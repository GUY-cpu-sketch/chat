// server.js - basic Node.js + Socket.IO setup
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('.'));
app.use(express.json());

const usersFile = './data/users.json';
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({}));

let users = JSON.parse(fs.readFileSync(usersFile));

// admin account reset
const adminUser = 'DEV';
const adminPass = 'Roblox2011!';
users[adminUser] = { password: bcrypt.hashSync(adminPass, 10), isAdmin: true };
fs.writeFileSync(usersFile, JSON.stringify(users));

io.on('connection', socket => {
    socket.on('login', ({ username, password }) => {
        if(users[username] && bcrypt.compareSync(password, users[username].password)){
            socket.username = username;
            socket.emit('loginSuccess');
        } else {
            socket.emit('loginFail');
        }
    });

    socket.on('register', ({ username, password }) => {
        if(!users[username]){
            users[username] = { password: bcrypt.hashSync(password,10), isAdmin:false };
            fs.writeFileSync(usersFile, JSON.stringify(users));
            socket.emit('registerSuccess');
        } else {
            socket.emit('registerFail');
        }
    });

    socket.on('chat', msg => {
        if(socket.username){
            io.emit('chat', { user: socket.username, message: msg });
        }
    });
});

server.listen(process.env.PORT || 10000, () => console.log('Server running'));
