const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let onlineUsers = [];

io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('setUsername', (username) => {
    socket.username = username;
    onlineUsers.push(username);
    io.emit('updateUserList', onlineUsers);
  });

  socket.on('sendMessage', (message) => {
    io.emit('receiveMessage', { user: socket.username, message });
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
    onlineUsers = onlineUsers.filter((user) => user !== socket.username);
    io.emit('updateUserList', onlineUsers);
  });
});

server.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});
