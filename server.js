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

// serve admin page (public/admin.html exists)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// optional health check
app.get('/health', (req, res) => res.send('OK'));

// ---------------------- In-memory state ----------------------
let online = {}; // socketId -> username
let userData = {}; // username -> { joinedAt, status }
let whispers = []; // { from, to, message, time }
let bannedUsers = new Set();
let mutedUsers = {}; // username -> mutedUntil timestamp (ms)
let messages = []; // { id, user, message, time, edited: bool }
let logs = []; // audit logs { admin, cmd, target, time, reason? }

// Multiple admins
const admins = new Set(['DEV', 'skullfucker99', 'testuser1']);

// Helper: add audit log
function addLog(admin, cmd, target, extra = '') {
  const entry = { admin, cmd, target, time: Date.now(), extra };
  logs.unshift(entry);
  // keep logs reasonable
  if (logs.length > 1000) logs.length = 1000;
}

// Helper: broadcast current user list
function broadcastUsers() {
  io.emit('updateUsers', Object.values(online).map((u) => ({
    username: u,
    status: userData[u]?.status || '',
    isAdmin: admins.has(u),
    mutedUntil: mutedUsers[u] || null
  })));
}

// Helper: create simple unique id
function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// Check if user is muted
function isMuted(username) {
  const until = mutedUsers[username];
  if (!until) return false;
  if (Date.now() >= until) {
    delete mutedUsers[username];
    return false;
  }
  return true;
}

// Periodic cleanup of expired mutes
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

  // When client sends login
  socket.on('login', ({ username }) => {
    if (!username) return;
    // ban check
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

    // send current messages history (last 200)
    socket.emit('loginSuccess', { isAdmin: admins.has(username) });
    socket.emit('messages', messages.slice(-200));
    socket.emit('updateWhispers', whispers);
    broadcastUsers();

    io.emit('system', `${username} joined`);
    io.emit('playSound', 'join');
  });

  socket.on('register', ({ username }) => {
    if (!username) return;
    // simple register success (no DB here)
    socket.emit('registerSuccess');
  });

  // Chat sending (enforced mute)
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

  // whispers (private messages)
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
    // deliver to target if online
    for (let [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('whisper', { from, message });
    }
    // play sound for recipient if connected
    for (let [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('playSound', 'whisper');
    }
  });

  // admin commands (kick/ban/mute) - protected
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (!socket.username) return;
    if (!admins.has(socket.username)) return; // only admins run these

    // sanity
    if (!target) {
      socket.emit('system', 'No target specified.');
      return;
    }

    // Prevent targeting other admins
    if (admins.has(target)) {
      socket.emit('system', 'You cannot perform this action on another admin.');
      addLog(socket.username, cmd, target, 'blocked-target-admin');
      return;
    }

    // Prevent self-target
    if (target === socket.username) {
      socket.emit('system', 'You cannot perform this action on yourself.');
      addLog(socket.username, cmd, target, 'blocked-self');
      return;
    }

    // find socket id of target
    let targetId = null;
    for (let [id, name] of Object.entries(online)) {
      if (name === target) {
        targetId = id;
        break;
      }
    }

    // execute command
    switch (cmd) {
      case 'kick':
        if (!targetId) {
          socket.emit('system', 'Target not online.');
          return;
        }
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
        // arg can be seconds
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

  // edit message (allowed by author or admin)
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

  // delete message (allowed by author or admin)
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

  // typing indicator (broadcast to others)
  socket.on('typing', (isTyping) => {
    if (!socket.username) return;
    socket.broadcast.emit('typing', { user: socket.username, isTyping });
  });

  // set status
  socket.on('setStatus', (status) => {
    if (!socket.username) return;
    userData[socket.username] = userData[socket.username] || { joinedAt: Date.now(), status: '' };
    userData[socket.username].status = status;
    broadcastUsers();
  });

  // get admin data (only admins)
  socket.on('getAdminData', () => {
    if (!socket.username || !admins.has(socket.username)) return;
    const onlineList = Object.values(online);
    const banned = Array.from(bannedUsers);
    const muted = Object.entries(mutedUsers).map(([user, until]) => ({ user, mutedUntil: until }));
    socket.emit('adminData', { online: onlineList, banned, muted, logs });
  });

  // admin unban/unmute actions
  socket.on('adminAction', ({ action, target }) => {
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return;
    if (action === 'unban') {
      if (bannedUsers.has(target)) {
        bannedUsers.delete(target);
        addLog(socket.username, 'unban', target);
        io.emit('system', `${target} was unbanned by ${socket.username}.`);
      }
    } else if (action === 'unmute') {
      if (mutedUsers[target]) {
        delete mutedUsers[target];
        addLog(socket.username, 'unmute', target);
        io.emit('system', `${target} was unmuted by ${socket.username}.`);
        broadcastUsers();
      }
    }
  });

  // get profile
  socket.on('getProfile', ({ username }) => {
    if (!username) return;
    const data = userData[username] || null;
    socket.emit('profileData', { username, data });
  });

  // disconnect
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
