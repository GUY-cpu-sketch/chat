require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// -------------------- In-memory Data --------------------
let users = {}; // username -> { passwordHash, isAdmin, status, mutedUntil }
let onlineUsers = {}; // socket.id -> username
let messages = []; // { id, user, message, time, edited }
let whispers = []; // { from, to, message, time }
let auditLogs = [];
let bannedUsers = [];
let kickList = [];

// -------------------- Routes --------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// -------------------- Socket.IO --------------------
io.on('connection', (socket) => {
  let currentUser = null;

  // -------------------- AUTH --------------------
  socket.on('register', async ({ username, password }) => {
    if (!username || !password) return socket.emit('registerError', 'Missing username or password');
    if (users[username]) return socket.emit('registerError', 'Username already exists');
    const hash = await bcrypt.hash(password, 10);
    users[username] = { passwordHash: hash, isAdmin: false, status: '', mutedUntil: null };
    socket.emit('registerSuccess');
    auditLogs.push({ action: 'register', user: username, time: Date.now() });
  });

  socket.on('login', async ({ username, password }) => {
    const user = users[username];
    if (!user) return socket.emit('loginError', 'User not found');
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return socket.emit('loginError', 'Incorrect password');

    currentUser = username;
    onlineUsers[socket.id] = username;
    socket.emit('loginSuccess', { isAdmin: user.isAdmin });
    updateUsers();
    socket.emit('messages', messages);
    socket.emit('updateWhispers', whispers);
    auditLogs.push({ action: 'login', user: username, time: Date.now() });
  });

  // -------------------- Chat --------------------
  socket.on('chat', (msg) => {
    if (!currentUser) return;
    const userData = users[currentUser];
    const now = Date.now();
    if (userData.mutedUntil && now < userData.mutedUntil) return;
    const messageObj = { id: Date.now() + Math.random(), user: currentUser, message: msg, time: now, edited: false };
    messages.push(messageObj);
    io.emit('chat', messageObj);
  });

  // -------------------- Whisper --------------------
  socket.on('whisper', ({ target, message }) => {
    if (!currentUser || !users[target]) return;
    const w = { from: currentUser, to: target, message, time: Date.now() };
    whispers.push(w);
    Object.entries(onlineUsers).forEach(([id, uname]) => {
      if (uname === target || uname === currentUser) io.to(id).emit('whisper', w);
    });
  });

  // -------------------- Edit/Delete --------------------
  socket.on('editMessage', ({ id, newText }) => {
    if (!currentUser) return;
    const msg = messages.find(m => m.id === id);
    if (!msg) return;
    const isAdmin = users[currentUser]?.isAdmin;
    if (msg.user !== currentUser && !isAdmin) return;
    msg.message = newText;
    msg.edited = true;
    io.emit('editMessage', msg);
  });

  socket.on('deleteMessage', ({ id }) => {
    if (!currentUser) return;
    const msg = messages.find(m => m.id === id);
    if (!msg) return;
    const isAdmin = users[currentUser]?.isAdmin;
    if (msg.user !== currentUser && !isAdmin) return;
    messages = messages.filter(m => m.id !== id);
    io.emit('deleteMessage', { id });
  });

  // -------------------- Status --------------------
  socket.on('setStatus', (status) => {
    if (!currentUser) return;
    users[currentUser].status = status;
    updateUsers();
  });

  // -------------------- Typing --------------------
  socket.on('typing', (isTyping) => {
    if (!currentUser) return;
    socket.broadcast.emit('typing', { user: currentUser, isTyping });
  });

  // -------------------- Admin Commands --------------------
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    const isAdmin = users[currentUser]?.isAdmin;
    if (!currentUser || !isAdmin) return;
    const now = Date.now();
    if (cmd === 'kick' && onlineUsers[target]) {
      const sockId = Object.keys(onlineUsers).find(id => onlineUsers[id] === target);
      io.to(sockId).emit('kicked', arg || 'Kicked by admin');
      auditLogs.push({ action: 'kick', admin: currentUser, target, reason: arg, time: now });
    }
    if (cmd === 'ban') {
      bannedUsers.push(target);
      auditLogs.push({ action: 'ban', admin: currentUser, target, reason: arg, time: now });
      const sockId = Object.keys(onlineUsers).find(id => onlineUsers[id] === target);
      if (sockId) io.to(sockId).emit('banned', arg || 'Banned by admin');
    }
    if (cmd === 'mute' && users[target]) {
      users[target].mutedUntil = now + (parseInt(arg) || 60) * 1000;
      auditLogs.push({ action: 'mute', admin: currentUser, target, until: users[target].mutedUntil, time: now });
      const sockId = Object.keys(onlineUsers).find(id => onlineUsers[id] === target);
      if (sockId) io.to(sockId).emit('mutedStatus', { mutedUntil: users[target].mutedUntil });
    }
  });

  socket.on('getProfile', ({ username }) => {
    if (!currentUser) return;
    const profile = users[username] || {};
    socket.emit('system', `Profile of ${username}: status=${profile.status || ''}, admin=${profile.isAdmin}`);
  });

  // -------------------- Disconnect --------------------
  socket.on('disconnect', () => {
    if (currentUser) delete onlineUsers[socket.id];
    updateUsers();
  });

  function updateUsers() {
    const list = Object.values(onlineUsers).map(u => ({
      username: u,
      status: users[u]?.status || '',
      isAdmin: users[u]?.isAdmin || false,
      mutedUntil: users[u]?.mutedUntil || null
    }));
    io.emit('updateUsers', list);
  }
});

// -------------------- Start Server --------------------
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
