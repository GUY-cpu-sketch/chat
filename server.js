require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5, cors: { origin: true, credentials: true } });

const PORT = Number(process.env.PORT) || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 24;
const MAX_STATUS_LENGTH = 80;
const MAX_AVATAR_URL_LENGTH = 500;
const MAX_USERS = 1000;
const MESSAGE_COOLDOWN_MS = 750;
const ADMIN_USERS = new Set(['DEV', 'testuser1', 'skullfucker99']);

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required. Configure a PostgreSQL database before starting the server.');
  process.exit(1);
}

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const sessions = new Map();
const onlineUsers = new Map();
let messages = [];
const whispers = [];
const auditLogs = [];
const avatarReports = [];

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public/chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const normalizeUsername = value => cleanText(value, MAX_USERNAME_LENGTH);
const validUsername = username => /^[A-Za-z0-9_-]{3,24}$/.test(username);
const validColor = color => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
function validAvatar(url) {
  if (!url) return true;
  try { return ['http:', 'https:'].includes(new URL(url).protocol) && url.length <= MAX_AVATAR_URL_LENGTH; }
  catch { return false; }
}
const isAdmin = username => ADMIN_USERS.has(username);

async function getUser(username) {
  const result = await db.query('SELECT username, password_hash, status, muted_until, avatar, color FROM users WHERE username=$1 LIMIT 1', [username]);
  return result.rows[0] || null;
}
async function userExists(username) {
  const result = await db.query('SELECT 1 FROM users WHERE username=$1 LIMIT 1', [username]);
  return result.rowCount > 0;
}
async function userIsBanned(username) {
  const result = await db.query('SELECT 1 FROM banned_users WHERE username=$1 LIMIT 1', [username]);
  return result.rowCount > 0;
}
async function countUsers() {
  const result = await db.query('SELECT COUNT(*)::int AS count FROM users');
  return result.rows[0].count;
}
async function requireAuth(socket) {
  try {
    const token = socket.handshake.auth?.token;
    const username = token ? sessions.get(token) : null;
    if (!username || !(await userExists(username)) || (await userIsBanned(username))) {
      socket.emit('authRequired');
      return null;
    }
    return username;
  } catch {
    socket.emit('errorMessage', 'Authentication service is temporarily unavailable.');
    return null;
  }
}
function addAudit(entry) {
  auditLogs.push({ ...entry, time: Date.now() });
  if (auditLogs.length > 500) auditLogs.shift();
}
async function publicUser(username) {
  const user = await getUser(username);
  return { username, status: user?.status || '', mutedUntil: user?.muted_until ? new Date(user.muted_until).getTime() : null, avatar: user?.avatar || '', color: user?.color || '#ffffff', isAdmin: isAdmin(username) };
}
async function updateUsers() {
  const list = [];
  for (const username of [...new Set(onlineUsers.values())]) list.push(await publicUser(username));
  io.emit('updateUsers', list);
}
function disconnectUser(username, event, reason) {
  for (const [socketId, user] of onlineUsers.entries()) {
    if (user !== username) continue;
    io.to(socketId).emit(event, reason);
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
}
async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(24) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status VARCHAR(80) NOT NULL DEFAULT '',
      muted_until TIMESTAMPTZ NULL,
      avatar TEXT NOT NULL DEFAULT '',
      color CHAR(7) NOT NULL DEFAULT '#ffffff',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS banned_users (
      username VARCHAR(24) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
  `);
}

io.on('connection', socket => {
  socket.on('register', async (payload = {}) => {
    const username = normalizeUsername(payload.username);
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (!validUsername(username)) return socket.emit('registerError', 'Username must be 3–24 characters and use only letters, numbers, _ or -.');
    if (password.length < 6 || password.length > 128) return socket.emit('registerError', 'Password must be between 6 and 128 characters.');
    try {
      if ((await countUsers()) >= MAX_USERS) return socket.emit('registerError', 'The server is full.');
      if (await userExists(username)) return socket.emit('registerError', 'Username already exists.');
      if (await userIsBanned(username)) return socket.emit('registerError', 'That username is unavailable.');
      const passwordHash = await bcrypt.hash(password, 12);
      await db.query('INSERT INTO users (username, password_hash) VALUES ($1,$2)', [username, passwordHash]);
      addAudit({ action: 'register', user: username });
      socket.emit('registerSuccess');
    } catch (error) {
      if (error.code === '23505') return socket.emit('registerError', 'Username already exists.');
      console.error('Registration error:', error);
      socket.emit('registerError', 'Registration failed. Please try again.');
    }
  });

  socket.on('login', async (payload = {}) => {
    const username = normalizeUsername(payload.username);
    const password = typeof payload.password === 'string' ? payload.password : '';
    try {
      if (await userIsBanned(username)) return socket.emit('loginError', 'You are banned from this chat.');
      const user = await getUser(username);
      if (!user) return socket.emit('loginError', 'User not found.');
      if (!await bcrypt.compare(password, user.password_hash)) return socket.emit('loginError', 'Incorrect password.');
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, username);
      socket.handshake.auth.token = token;
      onlineUsers.set(socket.id, username);
      socket.emit('loginSuccess', { token, username, isAdmin: isAdmin(username) });
      socket.emit('messages', messages);
      await updateUsers();
      addAudit({ action: 'login', user: username });
    } catch (error) {
      console.error('Login error:', error);
      socket.emit('loginError', 'Login failed. Please try again.');
    }
  });

  socket.on('authenticate', async () => {
    const username = await requireAuth(socket);
    if (!username) return;
    onlineUsers.set(socket.id, username);
    socket.emit('authenticated', { username, isAdmin: isAdmin(username) });
    socket.emit('messages', messages);
    await updateUsers();
  });

  socket.on('chat', async payload => {
    const username = await requireAuth(socket);
    if (!username) return;
    try {
      const user = await getUser(username);
      const message = cleanText(payload, MAX_MESSAGE_LENGTH);
      const now = Date.now();
      if (!user || !message) return;
      const mutedUntil = user.muted_until ? new Date(user.muted_until).getTime() : null;
      if (mutedUntil && now < mutedUntil) return socket.emit('errorMessage', 'You are currently muted.');
      if (socket.data.lastMessageAt && now - socket.data.lastMessageAt < MESSAGE_COOLDOWN_MS) return;
      socket.data.lastMessageAt = now;
      const messageObj = { id: crypto.randomUUID(), user: username, message, time: now, edited: false, color: user.color || '#ffffff', avatar: user.avatar || '' };
      messages.push(messageObj);
      if (messages.length > 1000) messages.shift();
      io.emit('chat', messageObj);
    } catch { socket.emit('errorMessage', 'Unable to send message right now.'); }
  });

  socket.on('whisper', async (payload = {}) => {
    const username = await requireAuth(socket);
    if (!username) return;
    try {
      const target = normalizeUsername(payload.target);
      const message = cleanText(payload.message, MAX_MESSAGE_LENGTH);
      if (!target || !message || !(await userExists(target)) || await userIsBanned(target)) return socket.emit('errorMessage', 'User not found or message is empty.');
      const whisper = { id: crypto.randomUUID(), from: username, to: target, message, time: Date.now() };
      whispers.push(whisper);
      if (whispers.length > 1000) whispers.shift();
      for (const [socketId, user] of onlineUsers.entries()) if (user === target || user === username) io.to(socketId).emit('whisper', whisper);
    } catch { socket.emit('errorMessage', 'Unable to send whisper right now.'); }
  });

  socket.on('editMessage', async payload => {
    const username = await requireAuth(socket);
    if (!username) return;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const newText = cleanText(payload.newText, MAX_MESSAGE_LENGTH);
    const msg = messages.find(m => m.id === id);
    if (!msg || !newText || (msg.user !== username && !isAdmin(username))) return;
    msg.message = newText;
    msg.edited = true;
    io.emit('editMessage', msg);
  });

  socket.on('deleteMessage', async payload => {
    const username = await requireAuth(socket);
    if (!username) return;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const msg = messages.find(m => m.id === id);
    if (!msg || (msg.user !== username && !isAdmin(username))) return;
    messages = messages.filter(m => m.id !== id);
    io.emit('deleteMessage', { id });
  });

  socket.on('setStatus', async status => {
    const username = await requireAuth(socket);
    if (!username) return;
    await db.query('UPDATE users SET status=$1 WHERE username=$2', [cleanText(status, MAX_STATUS_LENGTH), username]);
    await updateUsers();
  });
  socket.on('typing', async isTyping => { const username = await requireAuth(socket); if (username) socket.broadcast.emit('typing', { user: username, isTyping: Boolean(isTyping) }); });
  socket.on('setAvatar', async url => {
    const username = await requireAuth(socket);
    if (!username) return;
    const avatar = cleanText(url, MAX_AVATAR_URL_LENGTH);
    if (!validAvatar(avatar)) return socket.emit('errorMessage', 'Avatar must be a valid HTTP(S) URL.');
    await db.query('UPDATE users SET avatar=$1 WHERE username=$2', [avatar, username]);
    await updateUsers();
  });
  socket.on('setColor', async color => {
    const username = await requireAuth(socket);
    if (!username) return;
    if (!validColor(color)) return socket.emit('errorMessage', 'Invalid chat color.');
    await db.query('UPDATE users SET color=$1 WHERE username=$2', [color, username]);
    await updateUsers();
  });
  socket.on('reportAvatar', async (payload = {}) => {
    const username = await requireAuth(socket);
    if (!username) return;
    const target = normalizeUsername(payload.target);
    if (!target || !(await userExists(target)) || target === username) return;
    avatarReports.push({ reporter: username, target, time: Date.now() });
    if (avatarReports.length > 500) avatarReports.shift();
    addAudit({ action: 'avatar_report', user: username, target });
    if (isAdmin(username)) io.emit('updateReports', avatarReports);
  });

  socket.on('requestAdminData', async () => {
    const username = await requireAuth(socket);
    if (!username || !isAdmin(username)) return socket.emit('adminError', 'Admin access required.');
    socket.emit('adminData', { reports: avatarReports, auditLogs });
  });

  socket.on('adminCommand', async (payload = {}) => {
    const username = await requireAuth(socket);
    if (!username || !isAdmin(username)) return socket.emit('adminError', 'Admin access required.');
    const cmd = cleanText(payload.cmd, 20).toLowerCase();
    const target = normalizeUsername(payload.target);
    const arg = cleanText(payload.arg, 200);
    if (target && isAdmin(target) && ['kick', 'ban', 'mute'].includes(cmd)) return socket.emit('adminError', 'You cannot moderate another admin.');
    try {
      if (cmd === 'kick') {
        if (!(await userExists(target))) return socket.emit('adminError', 'User not found.');
        disconnectUser(target, 'kicked', arg || 'Kicked by admin');
        addAudit({ action: 'kick', admin: username, target, reason: arg });
      } else if (cmd === 'ban') {
        if (!(await userExists(target))) return socket.emit('adminError', 'User not found.');
        await db.query('INSERT INTO banned_users (username) VALUES ($1) ON CONFLICT (username) DO NOTHING', [target]);
        disconnectUser(target, 'banned', arg || 'Banned by admin');
        addAudit({ action: 'ban', admin: username, target, reason: arg });
      } else if (cmd === 'mute') {
        if (!(await userExists(target))) return socket.emit('adminError', 'User not found.');
        const seconds = Math.min(Math.max(Number.parseInt(arg, 10) || 60, 1), 86400);
        const mutedUntil = new Date(Date.now() + seconds * 1000);
        await db.query('UPDATE users SET muted_until=$1 WHERE username=$2', [mutedUntil, target]);
        for (const [socketId, user] of onlineUsers.entries()) if (user === target) io.to(socketId).emit('mutedStatus', { mutedUntil: mutedUntil.getTime() });
        addAudit({ action: 'mute', admin: username, target, until: mutedUntil.getTime() });
      } else if (cmd === 'clear') {
        messages = [];
        io.emit('messages', messages);
        addAudit({ action: 'clear', admin: username });
      } else if (cmd === 'unban') {
        await db.query('DELETE FROM banned_users WHERE username=$1', [target]);
        addAudit({ action: 'unban', admin: username, target });
      } else return socket.emit('adminError', 'Unknown command.');
      socket.emit('adminData', { reports: avatarReports, auditLogs });
      await updateUsers();
    } catch (error) {
      console.error('Admin command error:', error);
      socket.emit('adminError', 'Admin command failed.');
    }
  });

  socket.on('disconnect', () => { onlineUsers.delete(socket.id); updateUsers().catch(() => {}); });
});

async function start() {
  try {
    await db.query('SELECT 1');
    await initializeDatabase();
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (error) {
    console.error('Database startup failed:', error.message);
    await db.end().catch(() => {});
    process.exit(1);
  }
}
process.on('SIGTERM', async () => { await db.end().catch(() => {}); server.close(() => process.exit(0)); });
process.on('SIGINT', async () => { await db.end().catch(() => {}); server.close(() => process.exit(0)); });
start();
