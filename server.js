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

// root route for Render health check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// optional health check
app.get('/health', (req, res) => res.send('OK'));

// ---------------------- In-memory state ----------------------
let online = {}; // socketId -> username
let userData = {}; // username -> { joinedAt, status }
let auth = {}; // username -> password
let whispers = [];
let bannedUsers = new Set();
let mutedUsers = {};
let messages = [];
let logs = [];

// admins
const admins = new Set(['DEV', 'skullfucker99', 'testuser1']);

// Helpers
function addLog(admin, cmd, target, extra='') {
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

// Periodic cleanup for mutes
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

  // --- REGISTER ---
  socket.on('register', ({ username, password }) => {
    if (!username || !password) return socket.emit('registerError', 'Username & password required');
    if (auth[username]) return socket.emit('registerError', 'Username already exists');

    auth[username] = password;
    userData[username] = { joinedAt: Date.now(), status: '' };
    socket.emit('registerSuccess');
  });

  // --- LOGIN ---
  socket.on('login', ({ username, password }) => {
    if (!username || !password) return socket.emit('loginError', 'Username & password required');
    if (bannedUsers.has(username)) {
      socket.emit('banned', 'You are banned from this chat.');
      socket.disconnect();
      return;
    }
    if (!auth[username]) return socket.emit('loginError', 'User not registered');
    if (auth[username] !== password) return socket.emit('loginError', 'Incorrect password');

    socket.username = username;
    online[socket.id] = username;

    if (!userData[username]) userData[username] = { joinedAt: Date.now(), status: '' };

    socket.emit('loginSuccess', { isAdmin: admins.has(username) });
    socket.emit('messages', messages.slice(-200));
    socket.emit('updateWhispers', whispers);
    broadcastUsers();

    io.emit('system', `${username} joined`);
    io.emit('playSound', 'join');
  });

  // --- CHAT ---
  socket.on('chat', (msg) => {
    if (!socket.username) return;
    const user = socket.username;
    if (isMuted(user)) {
      socket.emit('system', `You are muted until ${new Date(mutedUsers[user]).toLocaleString()}`);
      socket.emit('mutedStatus', { mutedUntil: mutedUsers[user] });
      return;
    }
    const entry = { id: makeId(), user, message: msg, time: Date.now(), edited: false };
    messages.push(entry);
    io.emit('chat', entry);
  });

  // --- WHISPER ---
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
    // deliver
    for (let [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('whisper', { from, message });
    }
    for (let [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('playSound', 'whisper');
    }
  });

  // --- ADMIN COMMANDS ---
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return socket.emit('system', 'No target specified.');
    if (admins.has(target)) return socket.emit('system', 'Cannot target another admin.');

    let targetId = Object.entries(online).find(([id, name]) => name === target)?.[0] || null;

    switch(cmd) {
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
        const seconds = parseInt(arg,10)||60;
        const until = Date.now()+seconds*1000;
        mutedUsers[target] = until;
        if (targetId) {
          io.to(targetId).emit('mutedStatus', { mutedUntil: until });
          io.to(targetId).emit('system', `You were muted for ${seconds}s by ${socket.username}.`);
        }
        addLog(socket.username, 'mute', target, `for ${seconds}s`);
        io.emit('system', `${target} was muted by ${socket.username} for ${seconds}s.`);
        broadcastUsers();
        break;
      default: socket.emit('system','Unknown admin command');
    }
  });

  // --- OTHER EVENTS: edit, delete, typing, status, getAdminData, adminAction, getProfile, disconnect ---
  // (keep all other handlers from your current server.js)
  
  socket.on('disconnect', () => {
    if (socket.username) {
      delete online[socket.id];
      io.emit('system', `${socket.username} left`);
      broadcastUsers();
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
