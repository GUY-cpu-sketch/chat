const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;

// -------------------
// 🔹 DATA STORAGE
// -------------------
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, "users.json");
let usersDB = {};
if (fs.existsSync(USERS_FILE)) {
  usersDB = JSON.parse(fs.readFileSync(USERS_FILE));
} else {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}

// Online and banned users
let onlineUsers = {};
let bannedUsers = new Set();

// -------------------
// 🔹 STATIC FILES
// -------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
    if (!usersDB[username]) return socket.emit("loginError", "User does not exist!");
    if (usersDB[username].password !== password)
      return socket.emit("loginError", "Incorrect password!");

    currentUser = username;
    onlineUsers[username] = socket.id;
    socket.emit("loginSuccess");
    io.emit("system", `${username} has joined the chat.`);
    io.emit("updateUsers", Object.keys(onlineUsers));
  });

  // REGISTER
  socket.on("register", ({ username, password }) => {
    if (usersDB[username]) return socket.emit("registerError", "Username already exists!");
    usersDB[username] = { password };
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB));
    socket.emit("registerSuccess");
  });

  // CHAT
  socket.on("chat", (msg) => {
    if (!currentUser) return;
    io.emit("chat", { user: currentUser, message: msg, time: Date.now() });
  });

  // ADMIN COMMANDS
  socket.on("adminCommand", ({ cmd, target, arg }) => {
    if (currentUser !== "DEV") return;
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
        const time = parseInt(arg) || 60;
        io.to(targetSocketId).emit("systemMessage", `You are muted for ${time} seconds.`);
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
