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

let online = {};      // socket.id => username
let whispers = [];    // { from, to, message, time }

// broadcast online users
function broadcastUsers() {
  const users = Object.values(online);
  io.emit('updateUsers', users);
}

io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  socket.on('login', ({ username, password }) => {
    socket.username = username;
    online[socket.id] = username;
    socket.emit('loginSuccess');
    io.emit('system', `${username} joined`);
    broadcastUsers();
    io.emit('updateWhispers', whispers);
  });

  socket.on('register', ({ username, password }) => {
    socket.emit('registerSuccess');
  });

  socket.on('chat', (msg) => {
    const user = socket.username;
    if (!user) return;
    io.emit('chat', { user, message: msg, time: Date.now() });
  });

  socket.on('whisper', ({ target, message }) => {
    if (!socket.username) return;
    const from = socket.username;
    const time = Date.now();
    whispers.push({ from, to: target, message, time });
    for (let [id, name] of Object.entries(online)) {
      if (name === target) {
        io.to(id).emit('whisper', { from, message });
      }
    }
    io.emit('updateWhispers', whispers);
  });

  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (socket.username !== 'DEV') return;
    for (let [id, name] of Object.entries(online)) {
      if (name === target) {
        switch (cmd) {
          case 'kick':
            io.to(id).emit('kicked');
            break;
          case 'ban':
            io.to(id).emit('banned');
            break;
          case 'mute':
            io.to(id).emit('system', `You are muted for ${arg || 60}s`);
            break;
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
