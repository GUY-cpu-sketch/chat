require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  cors: { origin: true, credentials: true }
});

const PORT = Number(process.env.PORT) || 10000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 24;
const MAX_STATUS_LENGTH = 80;
const MAX_AVATAR_URL_LENGTH = 500;
const MAX_USERS = 1000;
const MESSAGE_COOLDOWN_MS = 750;

// Keep the existing admin list for compatibility with the current deployment.
const ADMIN_USERS = new Set(['DEV', 'testuser1', 'skullfucker99']);

// -------------------- In-memory data --------------------
const users = new Map();
const sessions = new Map(); // token -> username
const onlineUsers = new Map(); // socket.id -> username
let messages = [];
const whispers = [];
const auditLogs = [];
const bannedUsers = new Set();
const avatarReports = [];

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public/chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function normalizeUsername(value) {
  return cleanText(value, MAX_USERNAME_LENGTH);
}

function validUsername(username) {
  return /^[A-Za-z0-9_-]{3,24}$/.test(username);
}

function validColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
}

function validAvatar(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && url.length <= MAX_AVATAR_URL_LENGTH;
  } catch {
    return false;
  }
}

function isAdmin(username) {
  return ADMIN_USERS.has(username);
}

function getSocketUser(socket) {
  const token = socket.handshake.auth?.token;
  const username = token ? sessions.get(token) : null;
  return username && users.has(username) && !bannedUsers.has(username) ? username : null;
}

function requireAuth(socket) {
  const username = getSocketUser(socket);
  if (!username) {
    socket.emit('authRequired');
    return null;
  }
  return username;
}

function addAudit(entry) {
  auditLogs.push({ ...entry, time: Date.now() });
  if (auditLogs.length > 500) auditLogs.shift();
}

function publicUser(user) {
  const data = users.get(user);
  return {
    username: user,
    status: data?.status || '',
    mutedUntil: data?.mutedUntil || null,
    avatar: data?.avatar || '',
    color: data?.color || '#ffffff',
    isAdmin: isAdmin(user)
  };
}

function updateUsers() {
  io.emit('updateUsers', [...new Set(onlineUsers.values())].map(publicUser));
}

function disconnectUser(username, event, reason) {
  for (const [socketId, user] of onlineUsers.entries()) {
    if (user !== username) continue;
    io.to(socketId).emit(event, reason);
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
}

io.on('connection', (socket) => {
  socket.on('register', async (payload = {}) => {
    const username = normalizeUsername(payload.username);
    const password = typeof payload.password === 'string' ? payload.password : '';

    if (!validUsername(username)) {
      return socket.emit('registerError', 'Username must be 3–24 characters and use only letters, numbers, _ or -.');
    }
    if (password.length < 6 || password.length > 128) {
      return socket.emit('registerError', 'Password must be between 6 and 128 characters.');
    }
    if (users.size >= MAX_USERS) return socket.emit('registerError', 'The server is full.');
    if (users.has(username)) return socket.emit('registerError', 'Username already exists.');
    if (bannedUsers.has(username)) return socket.emit('registerError', 'That username is unavailable.');

    try {
      const hash = await bcrypt.hash(password, 10);
      users.set(username, {
        passwordHash: hash,
        status: '',
        mutedUntil: null,
        avatar: '',
        color: '#ffffff'
      });
      addAudit({ action: 'register', user: username });
      socket.emit('registerSuccess');
    } catch {
      socket.emit('registerError', 'Registration failed. Please try again.');
    }
  });

  socket.on('login', async (payload = {}) => {
    const username = normalizeUsername(payload.username);
    const password = typeof payload.password === 'string' ? payload.password : '';
    const user = users.get(username);

    if (bannedUsers.has(username)) return socket.emit('loginError', 'You are banned from this chat.');
    if (!user) return socket.emit('loginError', 'User not found.');

    try {
      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) return socket.emit('loginError', 'Incorrect password.');

      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, username);
      socket.handshake.auth.token = token;
      onlineUsers.set(socket.id, username);

      socket.emit('loginSuccess', { token, username, isAdmin: isAdmin(username) });
      socket.emit('messages', messages);
      updateUsers();
      addAudit({ action: 'login', user: username });
    } catch {
      socket.emit('loginError', 'Login failed. Please try again.');
    }
  });

  socket.on('authenticate', () => {
    const username = requireAuth(socket);
    if (!username) return;
    onlineUsers.set(socket.id, username);
    socket.emit('authenticated', { username, isAdmin: isAdmin(username) });
    socket.emit('messages', messages);
    updateUsers();
  });

  socket.on('chat', (payload) => {
    const username = requireAuth(socket);
    if (!username) return;
    const userData = users.get(username);
    const msg = cleanText(payload, MAX_MESSAGE_LENGTH);
    const now = Date.now();

    if (!msg) return;
    if (userData.mutedUntil && now < userData.mutedUntil) {
      return socket.emit('errorMessage', 'You are currently muted.');
    }
    if (socket.data.lastMessageAt && now - socket.data.lastMessageAt < MESSAGE_COOLDOWN_MS) return;
    socket.data.lastMessageAt = now;

    const messageObj = {
      id: crypto.randomUUID(),
      user: username,
      message: msg,
      time: now,
      edited: false,
      color: userData.color || '#ffffff',
      avatar: userData.avatar || ''
    };
    messages.push(messageObj);
    if (messages.length > 1000) messages.shift();
    io.emit('chat', messageObj);
  });

  socket.on('whisper', (payload = {}) => {
    const username = requireAuth(socket);
    if (!username) return;
    const target = normalizeUsername(payload.target);
    const message = cleanText(payload.message, MAX_MESSAGE_LENGTH);
    if (!target || !message || !users.has(target)) return socket.emit('errorMessage', 'User not found or message is empty.');
    if (bannedUsers.has(target)) return;

    const whisper = { id: crypto.randomUUID(), from: username, to: target, message, time: Date.now() };
    whispers.push(whisper);
    if (whispers.length > 1000) whispers.shift();

    for (const [socketId, uname] of onlineUsers.entries()) {
      if (uname === target || uname === username) io.to(socketId).emit('whisper', whisper);
    }
  });

  socket.on('editMessage', (payload = {}) => {
    const username = requireAuth(socket);
    if (!username) return;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const newText = cleanText(payload.newText, MAX_MESSAGE_LENGTH);
    const msg = messages.find(m => m.id === id);
    if (!msg || !newText) return;
    if (msg.user !== username && !isAdmin(username)) return;
    msg.message = newText;
    msg.edited = true;
    io.emit('editMessage', msg);
  });

  socket.on('deleteMessage', (payload = {}) => {
    const username = requireAuth(socket);
    if (!username) return;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const msg = messages.find(m => m.id === id);
    if (!msg) return;
    if (msg.user !== username && !isAdmin(username)) return;
    messages = messages.filter(m => m.id !== id);
    io.emit('deleteMessage', { id });
  });

  socket.on('setStatus', (status) => {
    const username = requireAuth(socket);
    if (!username) return;
    users.get(username).status = cleanText(status, MAX_STATUS_LENGTH);
    updateUsers();
  });

  socket.on('typing', (isTyping) => {
    const username = requireAuth(socket);
    if (!username) return;
    socket.broadcast.emit('typing', { user: username, isTyping: Boolean(isTyping) });
  });

  socket.on('setAvatar', (url) => {
    const username = requireAuth(socket);
    if (!username) return;
    const avatar = cleanText(url, MAX_AVATAR_URL_LENGTH);
    if (!validAvatar(avatar)) return socket.emit('errorMessage', 'Avatar must be a valid HTTP(S) URL.');
    users.get(username).avatar = avatar;
    updateUsers();
  });

  socket.on('setColor', (color) => {
    const username = requireAuth(socket);
    if (!username) return;
    if (!validColor(color)) return socket.emit('errorMessage', 'Invalid chat color.');
    users.get(username).color = color;
    updateUsers();
  });

  socket.on('reportAvatar', (payload = {}) => {
    const username = requireAuth(socket);
    if (!username) return;
    const target = normalizeUsername(payload.target);
    if (!target || !users.has(target) || target === username) return;
    avatarReports.push({ reporter: username, target, time: Date.now() });
    if (avatarReports.length > 500) avatarReports.shift();
    addAudit({ action: 'avatar_report', user: username, target });
    if (isAdmin(username)) io.emit('updateReports', avatarReports);
  });

  socket.on('requestAdminData', () => {
    const username = requireAuth(socket);
    if (!username || !isAdmin(username)) return socket.emit('adminError', 'Admin access required.');
    socket.emit('adminData', { reports: avatarReports, auditLogs });
  });

  socket.on('adminCommand', (payload = {}) => {
    const username = requireAuth(socket);
    if (!username || !isAdmin(username)) return socket.emit('adminError', 'Admin access required.');

    const cmd = cleanText(payload.cmd, 20).toLowerCase();
    const target = normalizeUsername(payload.target);
    const arg = cleanText(payload.arg, 200);

    if (target && isAdmin(target) && ['kick', 'ban', 'mute'].includes(cmd)) {
      return socket.emit('adminError', 'You cannot moderate another admin.');
    }

    if (cmd === 'kick') {
      if (!users.has(target)) return socket.emit('adminError', 'User not found.');
      disconnectUser(target, 'kicked', arg || 'Kicked by admin');
      addAudit({ action: 'kick', admin: username, target, reason: arg });
    } else if (cmd === 'ban') {
      if (!users.has(target)) return socket.emit('adminError', 'User not found.');
      bannedUsers.add(target);
      disconnectUser(target, 'banned', arg || 'Banned by admin');
      addAudit({ action: 'ban', admin: username, target, reason: arg });
    } else if (cmd === 'mute') {
      if (!users.has(target)) return socket.emit('adminError', 'User not found.');
      const seconds = Math.min(Math.max(Number.parseInt(arg, 10) || 60, 1), 86400);
      const mutedUntil = Date.now() + seconds * 1000;
      users.get(target).mutedUntil = mutedUntil;
      for (const [socketId, uname] of onlineUsers.entries()) {
        if (uname === target) io.to(socketId).emit('mutedStatus', { mutedUntil });
      }
      addAudit({ action: 'mute', admin: username, target, until: mutedUntil });
    } else if (cmd === 'clear') {
      messages = [];
      io.emit('messages', messages);
      addAudit({ action: 'clear', admin: username });
    } else if (cmd === 'unban') {
      bannedUsers.delete(target);
      addAudit({ action: 'unban', admin: username, target });
    } else {
      return socket.emit('adminError', 'Unknown command.');
    }

    socket.emit('adminData', { reports: avatarReports, auditLogs });
    updateUsers();
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    updateUsers();
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
