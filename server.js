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

// Add root route for Render health check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let online = {};
let whispers = [];

function broadcastUsers() {
  const users = Object.values(online);
  io.emit('updateUsers', users);
}

io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  socket.on('login', ({ username }) => {
    if (!username) return;
    socket.username = username;
    online[socket.id] = username;
    socket.emit('loginSuccess');
    io.emit('system', `${username} joined`);
    broadcastUsers();
    io.emit('updateWhispers', whispers);
  });

  socket.on('register', ({ username }) => {
    if (!username) return;
    socket.emit('registerSuccess');
  });

  socket.on('chat', (msg) => {
    if (!socket.username) return;
    io.emit('chat', { user: socket.username, message: msg, time: Date.now() });
  });

  socket.on('whisper', ({ target, message }) => {
    if (!socket.username) return;
    const from = socket.username;
    const time = Date.now();
    whispers.push({ from, to: target, message, time });
    for (let [id, name] of Object.entries(online)) {
      if (name === target) io.to(id).emit('whisper', { from, message });
    }
    io.emit('updateWhispers', whispers);
  });

  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (socket.username !== 'DEV') return;
    for (let [id, name] of Object.entries(online)) {
      if (name === target) {
        switch (cmd) {
          case 'kick': io.to(id).emit('kicked'); break;
          case 'ban': io.to(id).emit('banned'); break;
          case 'mute': io.to(id).emit('system', `You are muted for ${arg || 60}s`); break;
        }
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete online[socket.id];
      io.emit('system', `${socket.username} left`);
      broadcastUsers();
    }
  });
});

// Bind to Render’s PORT
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
