require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const HF_API_KEY = process.env.HF_API_KEY;  // your Hugging Face token

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let online = {};      // socket.id => username
let whispers = [];    // { from, to, message, time }

// Helper to broadcast online users
function broadcastUsers() {
  const users = Object.values(online);
  io.emit('updateUsers', users);
}

// Socket logic
io.on('connection', (socket) => {
  console.log('Connect:', socket.id);

  socket.on('login', ({ username, password }) => {
    // You already have your login logic; I assume password check etc.
    socket.username = username;
    online[socket.id] = username;
    socket.emit('loginSuccess');
    io.emit('system', `${username} joined`);
    broadcastUsers();
    // Also send whisper log to admin if needed
    io.emit('updateWhispers', whispers);
  });

  socket.on('register', ({ username, password }) => {
    // Your register logic here
    socket.emit('registerSuccess');
  });

  socket.on('chat', async (msg) => {
    const user = socket.username;
    if (!user) return;

    // If it's a /chatgpt command
    if (msg.startsWith('/chatgpt ')) {
      const prompt = msg.slice('/chatgpt '.length).trim();
      if (!prompt) {
        socket.emit('system', 'Usage: /chatgpt [message]');
      } else {
        try {
          const response = await fetch(
            `https://api-inference.huggingface.co/models/openai-community/gpt2`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${HF_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ inputs: prompt })
            }
          );
          const data = await response.json();
          let aiReply = data?.[0]?.generated_text;
          if (!aiReply) aiReply = 'No response from AI.';

          // Emit AI message to all
          io.emit('chat', { user: 'ChatGPT', message: aiReply, time: Date.now() });
        } catch (err) {
          console.error('HuggingFace error:', err);
          socket.emit('system', 'Error contacting AI server.');
        }
      }
      return;
    }

    // Normal chat
    io.emit('chat', { user, message: msg, time: Date.now() });
  });

  socket.on('whisper', ({ target, message }) => {
    if (!socket.username) return;
    const from = socket.username;
    const time = Date.now();
    whispers.push({ from, to: target, message, time });
    // send to target
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
