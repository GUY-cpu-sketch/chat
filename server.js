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

// root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/health', (req, res) => res.send('OK'));

// ---------------------- In-memory state ----------------------
let online = {}; // socketId -> username
let userData = {}; // username -> { joinedAt, status }
let users = {}; // username -> { password, joinedAt, status }
let whispers = [];
let bannedUsers = new Set();
let mutedUsers = {};
let messages = [];
let logs = [];

const admins = new Set(['DEV', 'skullfucker99', 'testuser1']);

function addLog(admin, cmd, target, extra = '') {
  const entry = { admin, cmd, target, time: Date.now(), extra };
  logs.unshift(entry);
  if (logs.length > 1000) logs.length = 1000;
}

function broadcastUsers() {
  io.emit('updateUsers', Object.values(online).map((u) => ({
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

// periodic unmute cleanup
setInterval(() => {
  for (const [u, until] of Object.entries(mutedUsers)) {
    if (Date.now() >= until) {
      delete mutedUsers[u];
      io.emit('system', `${u} has been unmuted (timer expired).`);
      broadcastUsers();
    }
  }
}, 5000);

// ---------------------- Socket handling ----------------------
io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  // REGISTER
  socket.on('register', ({ username, password }) => {
    if (!username || !password) return socket.emit('registerError', 'Username/password required');
    if (users[username]) return socket.emit('registerError', 'Username taken');
    users[username] = { password, joinedAt: Date.now(), status: '' };
    socket.emit('registerSuccess');
  });

  // LOGIN
  socket.on('login', ({ username, password }) => {
    if (!username || !password) return socket.emit('loginError', 'Username/password required');
    const user = users[username];
    if (!user || user.password !== password) return socket.emit('loginError', 'Invalid username or password');

    if (bannedUsers.has(username)) {
      socket.emit('banned', 'You are banned from this chat.');
      socket.disconnect();
      return;
    }

    socket.username = username;
    online[socket.id] = username;
    userData[username] = userData[username] || { joinedAt: user.joinedAt, status: user.status };

    socket.emit('loginSuccess', { isAdmin: admins.has(username) });
    socket.emit('messages', messages.slice(-200));
    socket.emit('updateWhispers', whispers);
    broadcastUsers();

    io.emit('system', `${username} joined`);
    io.emit('playSound', 'join');
  });

  // CHAT
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

  // WHISPER
  socket.on('whisper', ({ target, message }) => {
    if (!socket.username || !target || !message) return;
    const from = socket.username;
    if (isMuted(from)) {
      socket.emit('system', `You are muted and cannot send whispers.`);
      return;
    }
    const time = Date.now();
    const w = { from, to: target, message, time };
    whispers.push(w);
    io.emit('updateWhispers', whispers);

    // deliver
    for (let [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('whisper', { from, message });
      if (name === target) io.to(id).emit('playSound', 'whisper');
    }
  });

  // ADMIN COMMANDS
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return socket.emit('system', 'No target specified.');
    if (admins.has(target)) return socket.emit('system', 'Cannot target another admin.');

    if (target === socket.username) return socket.emit('system', 'Cannot target yourself.');

    let targetId = Object.entries(online).find(([id, name]) => name === target)?.[0];

    switch (cmd) {
      case 'kick':
        if (!targetId) return socket.emit('system', 'Target not online.');
        io.to(targetId).emit('kicked', 'You were kicked by an admin.');
        io.sockets.sockets.get(targetId)?.disconnect();
        addLog(socket.username, 'kick', target);
        io.emit('system', `${target} was kicked by ${socket.username}.`);
        break;
      case 'ban':
        bannedUsers.add(target);
        if (targetId) {
          io.to(targetId).emit('banned', 'You were banned by an admin.');
          io.sockets.sockets.get(targetId)?.disconnect();
        }
        addLog(socket.username, 'ban', target);
        io.emit('system', `${target} was banned by ${socket.username}.`);
        break;
      case 'mute':
        const seconds = parseInt(arg, 10) || 60;
        const until = Date.now() + seconds * 1000;
        mutedUsers[target] = until;
        if (targetId) {
          io.to(targetId).emit('mutedStatus', { mutedUntil: until });
          io.to(targetId).emit('system', `You were muted for ${seconds}s by ${socket.username}.`);
        }
        addLog(socket.username, 'mute', target, `for ${seconds}s`);
        io.emit('system', `${target} was muted by ${socket.username} for ${seconds}s.`);
        broadcastUsers();
        break;
      default:
        socket.emit('system', 'Unknown admin command.');
    }
  });

  // EDIT MESSAGE
  socket.on('editMessage', ({ id, newText }) => {
    if (!socket.username) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const msg = messages[idx];
    if (msg.user !== socket.username && !admins.has(socket.username)) {
      socket.emit('system', 'You cannot edit that message.');
      return;
    }
    messages[idx].message = newText;
    messages[idx].edited = true;
    io.emit('editMessage', messages[idx]);
    if (admins.has(socket.username) && msg.user !== socket.username) {
      addLog(socket.username, 'editMessage', msg.user, `edited message ${id}`);
    }
  });

  // DELETE MESSAGE
  socket.on('deleteMessage', ({ id }) => {
    if (!socket.username) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const msg = messages[idx];
    if (msg.user !== socket.username && !admins.has(socket.username)) {
      socket.emit('system', 'You cannot delete that message.');
      return;
    }
    messages.splice(idx, 1);
    io.emit('deleteMessage', { id });
    if (admins.has(socket.username) && msg.user !== socket.username) {
      addLog(socket.username, 'deleteMessage', msg.user, `deleted message ${id}`);
    }
  });

  // TYPING
  socket.on('typing', (isTyping) => {
    if (!socket.username) return;
    socket.broadcast.emit('typing', { user: socket.username, isTyping });
  });

  // STATUS
  socket.on('setStatus', (status) => {
    if (!socket.username) return;
    userData[socket.username] = userData[socket.username] || { joinedAt: Date.now(), status: '' };
    userData[socket.username].status = status;
    broadcastUsers();
  });

  // GET ADMIN DATA
  socket.on('getAdminData', () => {
    if (!socket.username || !admins.has(socket.username)) return;
    const onlineList = Object.values(online);
    const banned = Array.from(bannedUsers);
    const muted = Object.entries(mutedUsers).map(([user, until]) => ({ user, mutedUntil: until }));
    socket.emit('adminData', { online: onlineList, banned, muted, logs });
  });

  // ADMIN ACTIONS
  socket.on('adminAction', ({ action, target }) => {
    if (!socket.username || !admins.has(socket.username) || !target) return;
    if (action === 'unban') {
      bannedUsers.delete(target);
      addLog(socket.username, 'unban', target);
      io.emit('system', `${target} was unbanned by ${socket.username}.`);
    } else if (action === 'unmute') {
      delete mutedUsers[target];
      addLog(socket.username, 'unmute', target);
      io.emit('system', `${target} was unmuted by ${socket.username}.`);
      broadcastUsers();
    }
  });

  // PROFILE
  socket.on('getProfile', ({ username }) => {
    if (!username) return;
    const data = userData[username] || null;
    socket.emit('profileData', { username, data });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    if (socket.username) {
      delete online[socket.id];
      io.emit('system', `${socket.username} left`);
      broadcastUsers();
    }
  });
});

// server listen
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
