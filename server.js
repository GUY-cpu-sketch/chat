// server.js
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => res.send('OK'));

// ---- in-memory state ----
let online = {};         // socketId -> username
let userData = {};       // username -> { joinedAt, status, password }
let messages = [];       // { id, user, message, time, edited }
let whispers = [];       // { from, to, message, time }
let bannedUsers = new Set();
let mutedUsers = {};     // username -> timestamp (ms)
let logs = [];           // audit logs: { admin, cmd, target, time, extra }

const admins = new Set(['DEV', 'skullfucker99', 'testuser1']);

// helpers
function makeId(){ return `${Date.now()}-${Math.floor(Math.random()*100000)}`; }

function addLog(admin, cmd, target, extra=''){
  logs.unshift({ admin, cmd, target, time: Date.now(), extra });
  if(logs.length > 1000) logs.length = 1000;
}

function isMuted(username){
  const until = mutedUsers[username];
  if(!until) return false;
  if(Date.now() >= until){
    delete mutedUsers[username];
    return false;
  }
  return true;
}

function broadcastUsers(){
  io.emit('updateUsers', Object.values(online).map(u => ({
    username: u,
    status: userData[u]?.status || '',
    isAdmin: admins.has(u),
    mutedUntil: mutedUsers[u] || null
  })));
}

// periodic cleanup for expired mutes
setInterval(() => {
  for (const [u, until] of Object.entries(mutedUsers)) {
    if (Date.now() >= until) {
      delete mutedUsers[u];
      io.emit('system', `${u} has been unmuted (timer expired).`);
      broadcastUsers();
    }
  }
}, 5000);

// ---- socket handling ----
io.on('connection', (socket) => {
  console.log('socket connected:', socket.id);

  // REGISTER (with ack callback)
  // payload: { username, password }, cb({ ok: bool, error?:string })
  socket.on('register', (payload, cb) => {
    try {
      const username = payload && payload.username ? String(payload.username).trim() : '';
      const password = payload && payload.password ? String(payload.password) : '';
      if (!username || !password) {
        if (typeof cb === 'function') return cb({ ok: false, error: 'Username & password required' });
        return socket.emit('registerError', 'Username & password required');
      }
      if (userData[username]) {
        if (typeof cb === 'function') return cb({ ok: false, error: 'Username already exists' });
        return socket.emit('registerError', 'Username already exists');
      }

      userData[username] = { joinedAt: Date.now(), status: '', password };
      console.log('registered user:', username);
      if (typeof cb === 'function') return cb({ ok: true });
      socket.emit('registerSuccess');
    } catch (err) {
      console.error('register error', err);
      if (typeof cb === 'function') return cb({ ok: false, error: 'Server error' });
      socket.emit('registerError', 'Server error');
    }
  });

  // LOGIN (with ack callback)
  // payload: { username, password }, cb({ ok: bool, error?:string, isAdmin?:bool, messages?:[], whispers?:[] })
  socket.on('login', (payload, cb) => {
    try {
      const username = payload && payload.username ? String(payload.username).trim() : '';
      const password = payload && payload.password ? String(payload.password) : '';
      if (!username || !password) {
        if (typeof cb === 'function') return cb({ ok: false, error: 'Username & password required' });
        return socket.emit('loginError', 'Username & password required');
      }

      // check ban
      if (bannedUsers.has(username)) {
        if (typeof cb === 'function') return cb({ ok: false, error: 'You are banned' });
        socket.emit('banned', 'You are banned');
        return socket.disconnect();
      }

      // must exist and match password
      const user = userData[username];
      if (!user) {
        if (typeof cb === 'function') return cb({ ok: false, error: 'User does not exist' });
        return socket.emit('loginError', 'User does not exist');
      }
      if (user.password !== password) {
        if (typeof cb === 'function') return cb({ ok: false, error: 'Incorrect password' });
        return socket.emit('loginError', 'Incorrect password');
      }

      // success: attach
      socket.username = username;
      online[socket.id] = username;
      userData[username] = userData[username] || { joinedAt: Date.now(), status: '', password };

      // ack with data
      const resp = { ok: true, isAdmin: admins.has(username), messages: messages.slice(-200), whispers };
      if (typeof cb === 'function') cb(resp);
      // also emit events for backward compatibility
      socket.emit('loginSuccess', { isAdmin: admins.has(username) });
      socket.emit('messages', messages.slice(-200));
      socket.emit('updateWhispers', whispers);
      broadcastUsers();

      io.emit('system', `${username} joined`);
      io.emit('playSound', 'join');
    } catch (err) {
      console.error('login error', err);
      if (typeof cb === 'function') cb({ ok: false, error: 'Server error' });
      else socket.emit('loginError', 'Server error');
    }
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
    if (isMuted(socket.username)) return socket.emit('system', 'You are muted and cannot send whispers.');
    const w = { from: socket.username, to: target, message, time: Date.now() };
    whispers.push(w);
    io.emit('updateWhispers', whispers);

    for (const [id, name] of Object.entries(online)) {
      if (name === target) {
        io.to(id).emit('whisper', { from: socket.username, message });
        io.to(id).emit('playSound', 'whisper');
      }
    }
  });

  // ADMIN COMMANDS
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return socket.emit('system', 'No target specified');
    if (admins.has(target)) return socket.emit('system', 'Cannot target another admin');
    if (target === socket.username) return socket.emit('system', 'Cannot target yourself');

    const targetEntry = Object.entries(online).find(([id, name]) => name === target);
    const targetId = targetEntry ? targetEntry[0] : null;

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
        {
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
        }
        break;
      default:
        socket.emit('system', 'Unknown admin command.');
    }
  });

  // EDIT MESSAGE
  socket.on('editMessage', ({ id, newText }) => {
    if (!socket.username) return;
    const idx = messages.findIndex(m => m.id === id);
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
    const idx = messages.findIndex(m => m.id === id);
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
    userData[socket.username] = userData[socket.username] || { joinedAt: Date.now(), status: '', password: '' };
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

  // ADMIN ACTION (unban/unmute)
  socket.on('adminAction', ({ action, target }) => {
    if (!socket.username || !admins.has(socket.username) || !target) return;
    if (action === 'unban' && bannedUsers.has(target)) {
      bannedUsers.delete(target);
      addLog(socket.username, 'unban', target);
      io.emit('system', `${target} was unbanned by ${socket.username}.`);
    } else if (action === 'unmute' && mutedUsers[target]) {
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
    // else nothing
  });

}); // io.on connection

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
