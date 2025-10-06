
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// admin reset password (generated when building zip)
// admin password (plain for your reference): Dev!Reset2025#X9
const ADMIN_USERNAME = 'DEV';
const ADMIN_PLAIN = 'Dev!Reset2025#X9';

// data dir + files
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const usersFile = path.join(dataDir, 'users.json');
const messagesFile = path.join(dataDir, 'messages.json');
const bannedFile = path.join(dataDir, 'banned.json');
const tokensFile = path.join(dataDir, 'reset_tokens.json');

if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify([], null, 2));
if (!fs.existsSync(messagesFile)) fs.writeFileSync(messagesFile, JSON.stringify([], null, 2));
if (!fs.existsSync(bannedFile)) fs.writeFileSync(bannedFile, JSON.stringify([], null, 2));
if (!fs.existsSync(tokensFile)) fs.writeFileSync(tokensFile, JSON.stringify([], null, 2));

const readJSON = (f) => JSON.parse(fs.readFileSync(f,'utf8'));
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// Ensure DEV user exists and has hashed password (reset)
(function ensureAdmin(){
  const users = readJSON(usersFile);
  const existing = users.find(u => u.username === ADMIN_USERNAME);
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(ADMIN_PLAIN, salt);
  if (existing) {
    existing.password = hash;
  } else {
    users.push({ username: ADMIN_USERNAME, password: hash });
  }
  writeJSON(usersFile, users);
  console.log('Admin user ensured/reset (DEV).');
})();

// in-memory state
const socketsByUser = {}; // username -> Set of socket ids
let muted = {}; // username -> epoch ms until which muted
let lastMessageAt = {}; // username -> epoch ms of last message (for anti-spam)

function updateOnline() {
  const online = Object.keys(socketsByUser);
  io.emit('online-users', online);
}

// Routes
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'Missing' });
  const users = readJSON(usersFile);
  if (users.find(u=>u.username === username)) return res.json({ success:false, error: 'exists' });
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  users.push({ username, password: hash });
  writeJSON(usersFile, users);
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const banned = readJSON(bannedFile);
  if (banned.includes(username)) return res.json({ success:false, error:'banned' });
  const users = readJSON(usersFile);
  const user = users.find(u => u.username === username);
  if (user && bcrypt.compareSync(password, user.password)) res.json({ success: true, username });
  else res.json({ success: false, error: 'wrong' });
});

// Forgot password - request token
app.post('/forgot', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success:false, error:'missing' });
  const users = readJSON(usersFile);
  if (!users.find(u=>u.username === username)) return res.json({ success:false, error:'notfound' });
  const tokens = readJSON(tokensFile);
  const token = crypto.randomBytes(12).toString('hex');
  const expires = Date.now() + 15*60*1000; // 15 minutes
  tokens.push({ username, token, expires });
  writeJSON(tokensFile, tokens);
  // Return token in response so user can reset (no email)
  res.json({ success: true, token, expires });
});

// Reset password using token
app.post('/reset', (req, res) => {
  const { username, token, newPassword } = req.body;
  if (!username || !token || !newPassword) return res.json({ success:false, error:'missing' });
  const tokens = readJSON(tokensFile);
  const idx = tokens.findIndex(t => t.username === username && t.token === token && t.expires > Date.now());
  if (idx === -1) return res.json({ success:false, error:'invalid' });
  // consume token and update password
  tokens.splice(idx,1);
  writeJSON(tokensFile, tokens);
  const users = readJSON(usersFile);
  const user = users.find(u=>u.username === username);
  if (!user) return res.json({ success:false, error:'notfound' });
  const hash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10));
  user.password = hash;
  writeJSON(usersFile, users);
  res.json({ success:true });
});

app.get('/messages', (req, res) => {
  res.json(readJSON(messagesFile));
});

// Helper to save message
function saveMessage(obj){
  const msgs = readJSON(messagesFile);
  msgs.push(obj);
  if (msgs.length > 500) msgs.shift();
  writeJSON(messagesFile, msgs);
}

// Socket.io
io.on('connection', socket => {
  // register user socket
  socket.on('register-socket', ({ username }) => {
    // if banned, force-close
    const banned = readJSON(bannedFile);
    if (banned.includes(username)) {
      socket.emit('force-close', { reason: 'banned' });
      try { socket.disconnect(true); } catch(e){}
      return;
    }
    if (!socketsByUser[username]) socketsByUser[username] = new Set();
    socketsByUser[username].add(socket.id);
    socket.username = username;
    updateOnline();
  });

  socket.on('chat-message', ({ username, message }) => {
    // anti-spam: 2 seconds cooldown server-side
    const now = Date.now();
    if (lastMessageAt[username] && now - lastMessageAt[username] < 2000) {
      socket.emit('spam', { wait: 2000 - (now - lastMessageAt[username]) });
      return;
    }
    lastMessageAt[username] = now;

    // check mute
    if (muted[username] && muted[username] > now) {
      socket.emit('muted', { until: muted[username] });
      return;
    }
    const msg = { id: Date.now(), username, message, time: new Date().toISOString() };
    saveMessage(msg);
    io.emit('chat', msg);
  });

  socket.on('admin-command', ({ command, from }) => {
    // only allow DEV
    if (from !== 'DEV') return;
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === '/mute') {
      const target = parts[1];
      const secs = parseInt(parts[2]) || 60;
      if (!target) return;
      const until = Date.now() + secs*1000;
      muted[target] = until;
      // notify target if online
      const set = socketsByUser[target];
      if (set) for (const sid of set) io.to(sid).emit('muted-by-admin', { secs });
      io.emit('system', { message: `${target} muted for ${secs}s by DEV` });
    } else if (cmd === '/kick') {
      const target = parts[1];
      if (!target) return;
      const set = socketsByUser[target];
      if (set) {
        for (const sid of set) {
          io.to(sid).emit('force-close', { reason: 'kicked' });
          try { io.sockets.sockets.get(sid)?.disconnect(true); } catch(e){}
        }
      }
      io.emit('system', { message: `${target} kicked by DEV` });
    } else if (cmd === '/ban') {
      const target = parts[1];
      if (!target) return;
      // add to banned.json
      const banned = readJSON(bannedFile);
      if (!banned.includes(target)) {
        banned.push(target);
        writeJSON(bannedFile, banned);
      }
      const set = socketsByUser[target];
      if (set) {
        for (const sid of set) {
          io.to(sid).emit('apply-ban', {});
          try { io.sockets.sockets.get(sid)?.disconnect(true); } catch(e){}
        }
      }
      io.emit('system', { message: `${target} banned by DEV` });
    }
  });

  socket.on('disconnect', () => {
    const u = socket.username;
    if (u && socketsByUser[u]) {
      socketsByUser[u].delete(socket.id);
      if (socketsByUser[u].size === 0) delete socketsByUser[u];
    }
    updateOnline();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
