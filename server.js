// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] } // adjust in prod if needed
});

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => res.send('OK'));

// -------------------- IN-MEMORY STATE --------------------
let online = {};         // socketId -> username
let userData = {};       // username -> { joinedAt, status, password? }
let messages = [];       // { id, user, message, time, edited }
let whispers = [];       // { from, to, message, time }
let bannedUsers = new Set();
let mutedUsers = {};     // username -> untilTimestamp (ms)
let logs = [];           // audit logs in-memory

const admins = new Set(['DEV', 'skullfucker99', 'testuser1']);

// -------------------- HELPERS --------------------
function makeId() { return `${Date.now()}-${Math.floor(Math.random()*100000)}`; }
function addLog(admin, cmd, target, extra='') {
  logs.unshift({ admin, cmd, target, extra, time: Date.now() });
  if (logs.length > 1000) logs.length = 1000;
}
function broadcastUsers() {
  const payload = Object.values(online).map(u => ({
    username: u,
    status: userData[u]?.status || '',
    isAdmin: admins.has(u),
    mutedUntil: mutedUsers[u] || null
  }));
  io.emit('updateUsers', payload);
}
function isMuted(user) {
  const until = mutedUsers[user];
  if (!until) return false;
  if (Date.now() >= until) { delete mutedUsers[user]; return false; }
  return true;
}
function emitAdminDataToAdmins() {
  const adminData = {
    online: Object.values(online),
    banned: Array.from(bannedUsers),
    muted: Object.entries(mutedUsers).map(([user, until]) => ({ user, mutedUntil: until })),
    logs
  };
  // emit only to sockets belonging to admins
  for (const [id, name] of Object.entries(online)) {
    if (admins.has(name)) {
      io.to(id).emit('adminData', adminData);
    }
  }
}

// cleanup expired mutes
setInterval(() => {
  let changed = false;
  for (const [u, until] of Object.entries(mutedUsers)) {
    if (Date.now() >= until) {
      delete mutedUsers[u];
      io.emit('system', `${u} has been unmuted (timer expired).`);
      changed = true;
    }
  }
  if (changed) { broadcastUsers(); emitAdminDataToAdmins(); }
}, 5000);

// -------------------- SOCKET.IO --------------------
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // REGISTER (ack)
  socket.on('register', (payload = {}, cb) => {
    const username = payload.username ? String(payload.username).trim() : '';
    const password = payload.password ? String(payload.password) : '';
    if (!username || !password) {
      if (typeof cb === 'function') return cb({ ok:false, error:'username & password required' });
      return socket.emit('registerError', 'username & password required');
    }
    if (userData[username]) {
      if (typeof cb === 'function') return cb({ ok:false, error:'username exists' });
      return socket.emit('registerError', 'username exists');
    }
    userData[username] = { joinedAt: Date.now(), status: '', password };
    console.log('registered', username);
    if (typeof cb === 'function') return cb({ ok:true });
    socket.emit('registerSuccess');
  });

  // LOGIN (ack)
  socket.on('login', (payload = {}, cb) => {
    const username = payload.username ? String(payload.username).trim() : '';
    const password = payload.password ? String(payload.password) : '';
    if (!username || !password) {
      if (typeof cb === 'function') return cb({ ok:false, error:'username & password required' });
      return socket.emit('loginError', 'username & password required');
    }
    if (bannedUsers.has(username)) {
      if (typeof cb === 'function') return cb({ ok:false, error:'banned' });
      socket.emit('banned', 'You are banned');
      return socket.disconnect();
    }
    const existing = userData[username];
    if (!existing) {
      // create minimal profile if not registered — keeps compatibility
      userData[username] = { joinedAt: Date.now(), status: '', password };
    } else {
      if (existing.password && existing.password !== password) {
        if (typeof cb === 'function') return cb({ ok:false, error:'incorrect password' });
        return socket.emit('loginError', 'incorrect password');
      }
    }
    socket.username = username;
    online[socket.id] = username;

    const resp = { ok:true, isAdmin: admins.has(username), messages: messages.slice(-200), whispers };
    if (typeof cb === 'function') cb(resp);

    socket.emit('loginSuccess', { isAdmin: admins.has(username) });
    socket.emit('messages', messages.slice(-200));
    socket.emit('updateWhispers', whispers);
    broadcastUsers();
    io.emit('system', `${username} joined`);
    io.emit('playSound', 'join');
    emitAdminDataToAdmins();
  });

  // CHAT
  socket.on('chat', (msg) => {
    if (!socket.username) return;
    if (isMuted(socket.username)) {
      socket.emit('system', `You are muted until ${new Date(mutedUsers[socket.username]).toLocaleString()}`);
      socket.emit('mutedStatus', { mutedUntil: mutedUsers[socket.username] });
      return;
    }
    const entry = { id: makeId(), user: socket.username, message: msg, time: Date.now(), edited:false };
    messages.push(entry);
    io.emit('chat', entry);
  });

  // WHISPER
  socket.on('whisper', ({ target, message }) => {
    if (!socket.username || !target || !message) return;
    if (isMuted(socket.username)) { socket.emit('system','You are muted'); return; }
    const w = { from: socket.username, to: target, message, time: Date.now() };
    whispers.push(w);
    io.emit('updateWhispers', whispers);
    for (const [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('whisper', { from: socket.username, message });
    }
  });

  // ADMIN COMMANDS
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return socket.emit('system','No target specified');
    if (admins.has(target)) { socket.emit('system','Cannot target another admin'); addLog(socket.username, cmd, target, 'blocked-target-admin'); return; }
    if (target === socket.username) { socket.emit('system','Cannot target yourself'); addLog(socket.username, cmd, target, 'blocked-self'); return; }

    const targetEntry = Object.entries(online).find(([id,name]) => name === target);
    const targetId = targetEntry ? targetEntry[0] : null;

    switch (cmd) {
      case 'kick':
        if (!targetId) return socket.emit('system','Target not online');
        io.to(targetId).emit('kicked','Kicked by admin');
        io.sockets.sockets.get(targetId)?.disconnect();
        addLog(socket.username,'kick',target);
        io.emit('system',`${target} was kicked by ${socket.username}.`);
        emitAdminDataToAdmins();
        break;
      case 'ban':
        bannedUsers.add(target);
        if (targetId) { io.to(targetId).emit('banned','Banned by admin'); io.sockets.sockets.get(targetId)?.disconnect(); }
        addLog(socket.username,'ban',target);
        io.emit('system',`${target} was banned by ${socket.username}.`);
        emitAdminDataToAdmins();
        break;
      case 'mute':
        {
          const seconds = parseInt(arg,10) || 60;
          mutedUsers[target] = Date.now() + seconds*1000;
          if (targetId) io.to(targetId).emit('mutedStatus',{ mutedUntil: mutedUsers[target] });
          addLog(socket.username,'mute',target,`for ${seconds}s`);
          io.emit('system',`${target} was muted by ${socket.username} for ${seconds}s.`);
          broadcastUsers();
          emitAdminDataToAdmins();
        }
        break;
      default:
        socket.emit('system','Unknown admin command');
    }
  });

  // ADMIN ACTIONS (unban/unmute)
  socket.on('adminAction', ({ action, target }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return;
    if (action === 'unban') {
      bannedUsers.delete(target);
      addLog(socket.username,'unban',target);
      io.emit('system',`${target} was unbanned by ${socket.username}.`);
      emitAdminDataToAdmins();
    } else if (action === 'unmute') {
      delete mutedUsers[target];
      addLog(socket.username,'unmute',target);
      io.emit('system',`${target} was unmuted by ${socket.username}.`);
      broadcastUsers();
      emitAdminDataToAdmins();
    }
  });

  // EDIT MESSAGE
  socket.on('editMessage', ({ id, newText }) => {
    if (!socket.username) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return;
    const msg = messages[idx];
    if (msg.user !== socket.username && !admins.has(socket.username)) {
      socket.emit('system','You cannot edit that message.');
      return;
    }
    messages[idx].message = newText;
    messages[idx].edited = true;
    io.emit('editMessage', messages[idx]);
    if (admins.has(socket.username) && msg.user !== socket.username) addLog(socket.username,'editMessage',msg.user,`edited ${id}`);
    emitAdminDataToAdmins();
  });

  // DELETE MESSAGE
  socket.on('deleteMessage', ({ id }) => {
    if (!socket.username) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1) return;
    const msg = messages[idx];
    if (msg.user !== socket.username && !admins.has(socket.username)) {
      socket.emit('system','You cannot delete that message.');
      return;
    }
    messages.splice(idx,1);
    io.emit('deleteMessage', { id });
    if (admins.has(socket.username) && msg.user !== socket.username) addLog(socket.username,'deleteMessage',msg.user,`deleted ${id}`);
    emitAdminDataToAdmins();
  });

  // TYPING
  socket.on('typing', (isTyping) => {
    if (!socket.username) return;
    socket.broadcast.emit('typing', { user: socket.username, isTyping });
  });

  // SET STATUS
  socket.on('setStatus', (status) => {
    if (!socket.username) return;
    userData[socket.username] = userData[socket.username] || { joinedAt: Date.now(), status: '' };
    userData[socket.username].status = status;
    broadcastUsers();
    emitAdminDataToAdmins();
  });

  // GET ADMIN DATA
  socket.on('getAdminData', () => {
    if (!socket.username || !admins.has(socket.username)) return;
    const adminData = {
      online: Object.values(online),
      banned: Array.from(bannedUsers),
      muted: Object.entries(mutedUsers).map(([user, until]) => ({ user, mutedUntil: until })),
      logs
    };
    socket.emit('adminData', adminData);
  });

  // PROFILE
  socket.on('getProfile', ({ username }) => {
    if (!username) return;
    socket.emit('profileData', { username, data: userData[username] || null });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    if (socket.username) {
      delete online[socket.id];
      io.emit('system', `${socket.username} left`);
      broadcastUsers();
      emitAdminDataToAdmins();
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
