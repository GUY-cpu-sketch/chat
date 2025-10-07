require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch'); // for Hugging Face API

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HF_API_TOKEN = process.env.HF_API_TOKEN;

app.use(express.static('public'));
app.use(express.json());

// In-memory data (users, chats, whispers)
let users = {};       // username -> socket.id
let onlineUsers = {}; // username -> true
let whispers = [];    // { from, to, message, time }

// =========================
// Socket.IO
// =========================
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // LOGIN
  socket.on('login', ({ username, password }) => {
    if (!username || !password) {
      socket.emit('loginError', 'Enter username and password.');
      return;
    }

    users[username] = socket.id;
    onlineUsers[username] = true;

    socket.username = username;
    socket.emit('loginSuccess');

    io.emit('system', `${username} joined the chat!`);
    io.emit('updateOnlineUsers', Object.keys(onlineUsers));
  });

  // REGISTER (dummy, just accepts any username/password)
  socket.on('register', ({ username, password }) => {
    socket.emit('registerSuccess');
  });

  // CHAT
  socket.on('chat', async (msg) => {
    const data = { user: socket.username, message: msg, time: Date.now() };
    io.emit('chat', data);

    // AI Command
    if (msg.startsWith('/chatgpt ')) {
      const question = msg.slice(9);
      try {
        const response = await fetch('https://api-inference.huggingface.co/models/gpt2', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${HF_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ inputs: question })
        });
        const json = await response.json();
        let aiReply = 'Error getting AI response';
        if (Array.isArray(json) && json[0]?.generated_text) {
          aiReply = json[0].generated_text;
        }
        io.to(socket.id).emit('chat', { user: 'AI', message: aiReply, time: Date.now() });
      } catch (err) {
        console.error('AI error:', err);
      }
    }
  });

  // WHISPER
  socket.on('whisper', ({ target, message }) => {
    const targetId = users[target];
    if (!targetId) return;
    const data = { from: socket.username, message };
    io.to(targetId).emit('whisper', data);
    whispers.push({ from: socket.username, to: target, message, time: Date.now() });

    // Update admin whisper logs
    io.emit('updateWhispers', whispers);
  });

  // ADMIN COMMANDS
  socket.on('adminCommand', ({ cmd, target, arg }) => {
    if (socket.username !== 'DEV') return;
    const targetSocketId = users[target];
    if (!targetSocketId) return;

    switch (cmd) {
      case 'kick':
        io.to(targetSocketId).emit('kicked');
        break;
      case 'ban':
        io.to(targetSocketId).emit('banned');
        break;
      case 'mute':
        io.to(targetSocketId).emit('system', `You are muted for ${arg || 60} seconds`);
        break;
    }
  });

  socket.on('disconnect', () => {
    if (!socket.username) return;
    delete onlineUsers[socket.username];
    delete users[socket.username];
    io.emit('updateOnlineUsers', Object.keys(onlineUsers));
    io.emit('system', `${socket.username} left the chat.`);
  });
});

// =========================
// Start server
// =========================
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
