require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const HF_API_TOKEN = process.env.HF_API_TOKEN; // Hugging Face token

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// User storage
const usersFile = path.join(__dirname, "users.json");
let users = {};
if (fs.existsSync(usersFile)) {
  users = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
} else {
  fs.writeFileSync(usersFile, JSON.stringify({}));
}

// Whispers log for admin
let whispers = [];

// Helper: save users
function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

// =========================
// 🔐 LOGIN & REGISTER
// =========================
io.on("connection", (socket) => {
  socket.on("login", ({ username, password }) => {
    if (users[username] && users[username].password === password) {
      socket.username = username;
      socket.emit("loginSuccess");
      io.emit("system", `${username} joined`);
      updateOnlineUsers();
    } else {
      socket.emit("loginError", "Invalid username or password");
    }
  });

  socket.on("register", ({ username, password }) => {
    if (users[username]) {
      socket.emit("registerError", "Username already exists");
    } else {
      users[username] = { password };
      saveUsers();
      socket.emit("registerSuccess");
    }
  });

  // =========================
  // 💬 CHAT SYSTEM
  // =========================
  socket.on("chat", async (msg) => {
    const username = socket.username || "Unknown";

    // /chatgpt command
    if (msg.startsWith("/chatgpt ")) {
      const prompt = msg.replace("/chatgpt ", "");

      try {
        const res = await fetch("https://api-inference.huggingface.co/models/gpt2", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${HF_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ inputs: prompt })
        });

        const data = await res.json();
        const aiMessage = data[0]?.generated_text || "AI could not generate a response.";

        io.emit("chat", { user: "AI", message: aiMessage, time: Date.now() });
      } catch(err) {
        console.error(err);
        socket.emit("system", "Error contacting AI API.");
      }
      return;
    }

    io.emit("chat", { user: username, message: msg, time: Date.now() });
  });

  // =========================
  // 👤 WHISPERS
  // =========================
  socket.on("whisper", ({ target, message }) => {
    if (target && users[target]) {
      const from = socket.username || "Unknown";
      const time = Date.now();
      whispers.push({ from, to: target, message, time });

      // Send to target if online
      for (let [id, s] of io.sockets.sockets) {
        if (s.username === target) {
          s.emit("whisper", { from, message });
        }
      }

      // Update admin log
      io.emit("updateWhispers", whispers);
    } else {
      socket.emit("system", "User not found for whisper");
    }
  });

  // =========================
  // 👮 ADMIN COMMANDS
  // =========================
  socket.on("adminCommand", ({ cmd, target, arg }) => {
    if (socket.username !== "DEV") return;

    for (let [id, s] of io.sockets.sockets) {
      if (s.username === target) {
        if (cmd === "kick") s.emit("kicked");
        if (cmd === "ban") s.emit("banned");
        if (cmd === "mute") {
          const time = parseInt(arg) || 60;
          s.emit("system", `You are muted for ${time} seconds`);
        }
      }
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    updateOnlineUsers();
  });
});

// =========================
// 🔢 ONLINE USERS
// =========================
function updateOnlineUsers() {
  const online = [];
  for (let [id, s] of io.sockets.sockets) {
    if (s.username) online.push(s.username);
  }
  io.emit("onlineUsers", online);
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
