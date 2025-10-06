// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

// Ensure data folder exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const usersFile = './data/users.json';
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '{}');

// Load users
let users = JSON.parse(fs.readFileSync(usersFile));

// Reset admin account
const adminUser = 'DEV';
const adminPass = 'Roblox2011!';
users[adminUser] = { password: bcrypt.hashSync(adminPass, 10), isAdmin: true };
fs.writeFileSync(usersFile, JSON.stringify(users));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Online users tracking
let onlineUsers = {}; // socket.id => username

io.on('connection', (socket) => {
  console.log('New connection');

  // Login
  socket.on('login', ({ username, password }) => {
    if (users[username] && bcrypt.compareSync(password, users[username].password)) {
      socket.username = username;
      onlineUsers[socket.id] = username;
      socket.emit('loginSuccess');
      io.emit('updateUsers', Object.values(onlineUsers));
    } else {
      socket.emit('loginFail');
    }
  });

  // Register
  socket.on('register', ({ username, password }) => {
    if (!users[username]) {
      users[username] = { password: bcrypt.hashSync(password, 10), isAdmin: false };
      fs.writeFileSync(usersFile, JSON.stringify(users));
      socket.emit('registerSuccess');
    } else {
      socket.emit('registerFail');
    }
  });

  // Chat messages
  socket.on('chat', (msg) => {
    if (socket.username) {
      io.emit('chat', { user: socket.username, message: msg });
    }
  });

  // Admin commands
  socket.on('adminCommand', (cmd) => {
    // Example: just send system message for now
    io.emit('system', `Admin command received: ${cmd}`);
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    io.emit('updateUsers', Object.values(onlineUsers));
  });
});

// Start server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
