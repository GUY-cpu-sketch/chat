const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");
const path = require("path");

// -------------------
// 🔹 CONFIG
// -------------------
const PORT = process.env.PORT || 10000;
const DATA_FILE = path.join(__dirname, "data", "users.json");

// Ensure data folder exists
if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"));

// Load or create users file
let usersDB = {};
if (fs.existsSync(DATA_FILE)) {
  usersDB = JSON.parse(fs.readFileSync(DATA_FILE));
} else {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

// Online users
let onlineUsers = {};
let bannedUsers = new Set();

// -------------------
// 🔹 EXPRESS
// -------------------
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// -------------------
// 🔹 SOCKET.IO
// -------------------
io.on("connection", (socket) => {
  let currentUser = null;

  // LOGIN
  socket.on("login", ({ username, password }) => {
    if (bannedUsers.has(username)) {
      socket.emit("loginError", "You are banned!");
      return;
    }

    if (!usersDB[username]) {
      socket.emit("loginError", "User does not exist!");
      return;
    }

    if (usersDB[username].password !== password) {
      socket.emit("loginError", "Incorrect password!");
      return;
    }

    currentUser = username;
    onlineUsers[username] = socket.id;
    socket.emit("loginSuccess");
    io.emit("system", `${username} has joined the chat.`);
    io.emit("updateUsers", Object.keys(onlineUsers));
  });

  // REGISTER
  socket.on("register", ({ username, password }) => {
    if (usersDB[username]) {
      socket.emit("registerError", "Username already exists!");
      return;
    }
    usersDB[username] = { password };
    fs.writeFileSync(DATA_FILE, JSON.stringify(usersDB));
    socket.emit("registerSuccess");
  });

  // CHAT MESSAGE
  socket.on("chat", (msg) => {
    if (!currentUser) return;
    const data = { user: currentUser, message: msg, time: Date.now() };
    io.emit("chat", data);
  });

  // ADMIN COMMANDS
  socket.on("adminCommand", ({ cmd, target, arg }) => {
    if (currentUser !== "DEV") return; // only admin can run
    const targetSocketId = onlineUsers[target];
    if (!targetSocketId) return;

    switch (cmd) {
      case "kick":
        io.to(targetSocketId).emit("kicked");
        break;
      case "ban":
        bannedUsers.add(target);
        io.to(targetSocketId).emit("banned");
        break;
      case "mute":
        const time = parseInt(arg) || 60; // default 60s
        io.to(targetSocketId).emit("systemMessage", `You are muted for ${time} seconds.`);
        break;
      default:
        break;
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    if (!currentUser) return;
    delete onlineUsers[currentUser];
    io.emit("system", `${currentUser} has left the chat.`);
    io.emit("updateUsers", Object.keys(onlineUsers));
  });
});

// -------------------
// 🔹 START SERVER
// -------------------
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
