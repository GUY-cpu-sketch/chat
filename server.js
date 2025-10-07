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

// Online, banned, and whispers
let onlineUsers = {};
let bannedUsers = new Set();
let whispers = [];

// -------------------
// 🔹 STATIC FILES
// -------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

    // Send current whispers to admin
    const adminSocketId = onlineUsers["DEV"];
    if (adminSocketId) io.to(adminSocketId).emit("updateWhispers", whispers);
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

  // WHISPER
  socket.on("whisper", ({ target, message }) => {
    if (!currentUser) return;
    const targetSocketId = onlineUsers[target];
    if (!targetSocketId) {
      socket.emit("system", `User ${target} is not online.`);
      return;
    }

    // Send to target
    io.to(targetSocketId).emit("whisper", { from: currentUser, message });
    // Copy to sender
    socket.emit("whisper", { from: currentUser, message });

    // Record for admin
    whispers.push({ from: currentUser, to: target, message, time: Date.now() });
    const adminSocketId = onlineUsers["DEV"];
    if (adminSocketId) io.to(adminSocketId).emit("updateWhispers", whispers);
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
