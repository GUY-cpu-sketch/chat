require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------- Routes ----------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => res.send('OK'));

// ---------------- In-memory state ----------------
let online = {}; // socketId -> username
let userData = {}; // username -> { joinedAt, status }
let whispers = []; // { from, to, message, time }
let bannedUsers = new Set();
let mutedUsers = {}; // username -> mutedUntil timestamp (ms)
let messages = []; // { id, user, message, time, edited: bool }
let logs = []; // audit logs { admin, cmd, target, time, reason? }
let registeredUsers = {}; // username -> password

// Admins
const admins = new Set(['DEV', 'skullfucker99', 'testuser1']);

// ---------------- Helpers ----------------
function addLog(admin, cmd, target, extra = '') {
  const entry = { admin, cmd, target, time: Date.now(), extra };
  logs.unshift(entry);
  if (logs.length > 1000) logs.length = 1000;
}

function broadcastUsers() {
  io.emit('updateUsers', Object.values(online).map(u => ({
    username: u,
    status: userData[u]?.status || '',
    isAdmin: admins.has(u),
    mutedUntil: mutedUsers[u] || null
  })));
}

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function isMuted(username) {
  const until = mutedUsers[username];
  if (!until) return false;
  if (Date.now() >= until) {
    delete mutedUsers[username];
    return false;
  }
  return true;
}

// Periodic cleanup
setInterval(() => {
  for (const [u, until] of Object.entries(mutedUsers)) {
    if (Date.now() >= until) {
      delete mutedUsers[u];
      io.emit('system', `${u} has been unmuted (timer expired).`);
      broadcastUsers();
    }
  }
}, 5000);

// ---------------- Socket Handling ----------------
io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  // ---------- AUTH ----------
  socket.on('register', ({ username, password }) => {
    if (!username || !password) return socket.emit('registerError', 'Enter username & password');
    if (registeredUsers[username]) return socket.emit('registerError', 'Username taken');
    registeredUsers[username] = password;
    socket.emit('registerSuccess');
  });

  socket.on('login', ({ username, password }) => {
    if (!username || !password) return socket.emit('loginError', 'Enter username & password');
    if (!registeredUsers[username] || registeredUsers[username] !== password) {
      return socket.emit('loginError', 'Invalid username or password');
    }
    if (bannedUsers.has(username)) {
      socket.emit('banned', 'You are banned from this chat.');
      socket.disconnect();
      return;
    }

    socket.username = username;
    online[socket.id] = username;

    if (!userData[username]) {
      userData[username] = { joinedAt: Date.now(), status: '' };
    }

    socket.emit('loginSuccess', { isAdmin: admins.has(username) });
    socket.emit('messages', messages.slice(-200));
    socket.emit('updateWhispers', whispers);
    broadcastUsers();

    io.emit('system', `${username} joined`);
    io.emit('playSound', 'join');
  });

  // ---------- CHAT ----------
  socket.on('chat', (msg) => {
    if (!socket.username) return;
    const user = socket.username;
    if (isMuted(user)) {
      socket.emit('system', `You are muted until ${new Date(mutedUsers[user]).toLocaleString()}`);
      socket.emit('mutedStatus', { mutedUntil: mutedUsers[user] });
      return;
    }
    const id = makeId();
    const entry = { id, user, message: msg, time: Date.now(), edited: false };
    messages.push(entry);
    io.emit('chat', entry);
  });

  socket.on('whisper', ({ target, message }) => {
    if (!socket.username || !target || !message) return;
    const from = socket.username;
    if (isMuted(from)) {
      socket.emit('system', 'You are muted and cannot send whispers.');
      return;
    }
    const w = { from, to: target, message, time: Date.now() };
    whispers.push(w);
    io.emit('updateWhispers', whispers);

    for (let [id, name] of Object.entries(online)) {
      if (name === target) {
        io.to(id).emit('whisper', { from, message });
        io.to(id).emit('playSound', 'whisper');
      }
    }
  });

  // ---------- ADMIN ----------
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return socket.emit('system', 'No target specified');
    if (admins.has(target)) return socket.emit('system', 'Cannot target another admin');

    let targetId = Object.entries(online).find(([id, name]) => name === target)?.[0] || null;

    switch (cmd) {
      case 'kick':
        if (!targetId) return socket.emit('system', 'Target not online');
        io.to(targetId).emit('kicked', 'You were kicked by an admin.');
        io.sockets.sockets.get(targetId)?.disconnect();
        addLog(socket.username, 'kick', target);
        io.emit('system', `${target} was kicked by ${socket.username}`);
        break;

      case 'ban':
        bannedUsers.add(target);
        if (targetId) {
          io.to(targetId).emit('banned', 'You were banned by an admin.');
          io.sockets.sockets.get(targetId)?.disconnect();
        }
        addLog(socket.username, 'ban', target);
        io.emit('system', `${target} was banned by ${socket.username}`);
        break;

      case 'mute':
        const seconds = parseInt(arg, 10) || 60;
        const until = Date.now() + seconds * 1000;
        mutedUsers[target] = until;
        if (targetId) {
          io.to(targetId).emit('mutedStatus', { mutedUntil: until });
          io.to(targetId).emit('system', `You were muted for ${seconds}s by ${socket.username}`);
        }
        addLog(socket.username, 'mute', target, `for ${seconds}s`);
        io.emit('system', `${target} was muted by ${socket.username} for ${seconds}s`);
        broadcastUsers();
        break;

      default:
        socket.emit('system', 'Unknown admin command');
    }
  });

  // ---------- EDIT / DELETE ----------
  socket.on('editMessage', ({ id, newText }) => {
    if (!socket.username) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return;
    const msg = messages[idx];
    if (msg.user !== socket.username && !admins.has(socket.username)) {
      return socket.emit('system', 'Cannot edit this message');
    }
    messages[idx].message = newText;
    messages[idx].edited = true;
    io.emit('editMessage', messages[idx]);
    if (admins.has(socket.username) && msg.user !== socket.username) {
      addLog(socket.username, 'editMessage', msg.user, `edited message ${id}`);
    }
  });

  socket.on('deleteMessage', ({ id }) => {
    if (!socket.username) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return;
    const msg = messages[idx];
    if (msg.user !== socket.username && !admins.has(socket.username)) {
      return socket.emit('system', 'Cannot delete this message');
    }
    messages.splice(idx, 1);
    io.emit('deleteMessage', { id });
    if (admins.has(socket.username) && msg.user !== socket.username) {
      addLog(socket.username, 'deleteMessage', msg.user, `deleted message ${id}`);
    }
  });

  // ---------- OTHER EVENTS ----------
  socket.on('typing', (isTyping) => {
    if (!socket.username) return;
    socket.broadcast.emit('typing', { user: socket.username, isTyping });
  });

  socket.on('setStatus', (status) => {
    if (!socket.username) return;
    userData[socket.username] = userData[socket.username] || { joinedAt: Date.now(), status: '' };
    userData[socket.username].status = status;
    broadcastUsers();
  });

  socket.on('adminAction', ({ action, target }) => {
    if (!socket.username || !admins.has(socket.username) || !target) return;
    if (action === 'unban' && bannedUsers.has(target)) {
      bannedUsers.delete(target);
      addLog(socket.username, 'unban', target);
      io.emit('system', `${target} was unbanned by ${socket.username}`);
    } else if (action === 'unmute' && mutedUsers[target]) {
      delete mutedUsers[target];
      addLog(socket.username, 'unmute', target);
      io.emit('system', `${target} was unmuted by ${socket.username}`);
      broadcastUsers();
    }
  });

  socket.on('getProfile', ({ username }) => {
    if (!username) return;
    socket.emit('profileData', { username, data: userData[username] || null });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete online[socket.id];
      io.emit('system', `${socket.username} left`);
      broadcastUsers();
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
