const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const usersFile = path.join(dataDir, 'users.json');
const messagesFile = path.join(dataDir, 'messages.json');
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify([{ username: 'DEV', password: 'Roblox2011!' }]));
if (!fs.existsSync(messagesFile)) fs.writeFileSync(messagesFile, JSON.stringify([]));

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = readJSON(usersFile);
    const user = users.find(u => u.username === username && u.password === password);
    if (user) res.json({ success: true, username });
    else res.json({ success: false });
});

app.get('/messages', (req, res) => {
    res.json(readJSON(messagesFile));
});

app.post('/messages', (req, res) => {
    const { username, message } = req.body;
    const messages = readJSON(messagesFile);
    messages.push({ username, message, time: new Date() });
    writeJSON(messagesFile, messages);
    io.emit('chat', { username, message });
    res.json({ success: true });
});

io.on('connection', socket => {
    console.log('A user connected');
    socket.on('disconnect', () => console.log('User disconnected'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));