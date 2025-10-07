// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// load or create users DB
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE)); } catch (e) { users = {}; }
} else {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}

// seed admin DEV if not present
const seedAdmin = async () => {
  if (!users["DEV"]) {
    const hash = await bcrypt.hash("Roblox2011!", 10);
    users["DEV"] = { passwordHash: hash, banned: false };
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log("Seeded admin user DEV");
  }
};
seedAdmin().catch(console.error);

// in-memory runtime state
let online = {}; // socket.id => username
let whispers = []; // { from, to, message, time }
let muted = {}; // username => unix ms until unmute

// serve static
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// simple root
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

io.on("connection", (socket) => {
  console.log("conn:", socket.id);

  // helper: send updated user list
  const emitUserList = () => {
    io.emit("updateUsers", Object.values(online));
  };

  // LOGIN
  socket.on("login", async ({ username, password }) => {
    try {
      if (!username || !password) return socket.emit("loginError", "Missing credentials");
      const record = users[username];
      if (!record) return socket.emit("loginError", "User does not exist");
      if (record.banned) return socket.emit("loginError", "You are banned");
      const ok = await bcrypt.compare(password, record.passwordHash);
      if (!ok) return socket.emit("loginError", "Incorrect password");
      // success
      online[socket.id] = username;
      socket.username = username;
      socket.emit("loginSuccess");
      io.emit("system", `${username} has joined`);
      emitUserList();
      // send current whispers to admin (if admin online they'll get updates via updateWhispers below)
      const adminIds = Object.keys(online).filter(id => online[id] === "DEV");
      adminIds.forEach(id => io.to(id).emit("updateWhispers", whispers));
    } catch (err) {
      console.error("login err", err);
      socket.emit("loginError", "Server error");
    }
  });

  // REGISTER
  socket.on("register", async ({ username, password }) => {
    try {
      if (!username || !password) return socket.emit("registerError", "Missing fields");
      if (users[username]) return socket.emit("registerError", "Username already exists");
      const hash = await bcrypt.hash(password, 10);
      users[username] = { passwordHash: hash, banned: false };
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      socket.emit("registerSuccess");
    } catch (err) {
      console.error("register err", err);
      socket.emit("registerError", "Server error");
    }
  });

  // CHAT
  socket.on("chat", (msg) => {
    const username = online[socket.id];
    if (!username) return socket.emit("systemMessage", "You must be logged in to chat.");
    const now = Date.now();
    if (muted[username] && muted[username] > now) {
      socket.emit("systemMessage", `You are muted for ${(Math.ceil((muted[username]-now)/1000))}s`);
      return;
    } else if (muted[username]) {
      delete muted[username];
    }
    io.emit("chat", { user: username, message: String(msg), time: now });
  });

  // WHISPER
  socket.on("whisper", ({ to, message }) => {
    const from = online[socket.id];
    if (!from) return socket.emit("systemMessage", "You must be logged in to whisper.");
    const now = Date.now();
    if (muted[from] && muted[from] > now) {
      socket.emit("systemMessage", `You are muted for ${(Math.ceil((muted[from]-now)/1000))}s`);
      return;
    }
    const payload = { from, to, message: String(message), time: now };
    whispers.push(payload);
    // send to recipient if online
    const recipients = Object.entries(online).filter(([id, user]) => user === to).map(([id]) => id);
    recipients.forEach(id => io.to(id).emit("whisper", payload));
    // send confirmation to sender
    socket.emit("whisperSent", payload);
    // update admin whisper log (send to any DEV)
    Object.entries(online).forEach(([id, user]) => {
      if (user === "DEV") io.to(id).emit("updateWhispers", whispers);
    });
  });

  // ADMIN COMMANDS
  socket.on("adminCommand", ({ cmd, target, arg }) => {
    const sender = online[socket.id];
    if (sender !== "DEV") {
      socket.emit("systemMessage", "Not authorized");
      return;
    }
    if (!cmd || !target) return;
    // find target socket(s)
    const targets = Object.entries(online).filter(([id, user]) => user === target).map(([id]) => id);
    switch (cmd) {
      case "kick":
        targets.forEach(id => io.to(id).emit("kicked"));
        break;
      case "ban":
        // mark banned in users db if exists
        if (users[target]) {
          users[target].banned = true;
          fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        }
        targets.forEach(id => io.to(id).emit("banned"));
        break;
      case "mute": {
        const secs = parseInt(arg) || 60;
        const expire = Date.now() + secs * 1000;
        if (users[target]) muted[target] = expire;
        io.emit("system", `${target} muted for ${secs}s`);
        break;
      }
      default:
        socket.emit("systemMessage", "Unknown admin command");
    }
  });

  socket.on("disconnect", () => {
    if (socket.username) {
      delete online[socket.id];
      io.emit("system", `${socket.username} has left`);
      emitUserList();
    }
  });
});

http.listen(PORT, () => console.log(`Server running on ${PORT}`));
