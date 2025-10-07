import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------
// In-memory storage
// ---------------------------
let users = {};      // socket.id => username
let whispers = [];   // all whispers for admin log

io.on("connection", (socket) => {
  console.log("User connected", socket.id);

  // ---------------------------
  // LOGIN
  // ---------------------------
  socket.on("login", ({ username, password }) => {
    if (!username || !password) {
      socket.emit("loginError", "Missing credentials");
      return;
    }

    socket.username = username;
    users[socket.id] = username;

    socket.emit("loginSuccess");
    io.emit("system", `${username} joined`);
    io.emit("updateUsers", Object.values(users));
  });

  // ---------------------------
  // CHAT
  // ---------------------------
  socket.on("chat", (msg) => {
    if (!socket.username) return;
    const data = { user: socket.username, message: msg, time: Date.now() };
    io.emit("chat", data);
  });

  // ---------------------------
  // WHISPER
  // ---------------------------
  socket.on("whisper", ({ to, message }) => {
    const targetEntry = Object.entries(users).find(([id, user]) => user === to);
    if (targetEntry) {
      const [targetId] = targetEntry;
      const whisper = {
        from: socket.username,
        to,
        message,
        time: Date.now()
      };
      whispers.push(whisper);

      io.to(targetId).emit("whisper", whisper);
      socket.emit("whisperSent", whisper);
      io.emit("adminWhisperLog", whispers); // send to admin.html
    } else {
      socket.emit("system", `${to} is not online.`);
    }
  });

  // ---------------------------
  // DISCONNECT
  // ---------------------------
  socket.on("disconnect", () => {
    if (socket.username) {
      console.log(`${socket.username} disconnected`);
      delete users[socket.id];
      io.emit("system", `${socket.username} left`);
      io.emit("updateUsers", Object.values(users));
    }
  });

  // ---------------------------
  // ADMIN COMMANDS
  // ---------------------------
  socket.on("adminCommand", ({ cmd, target, arg }) => {
    if (!socket.username) return;

    const targetEntry = Object.entries(users).find(([id, user]) => user === target);
    if (!targetEntry) return;

    const [targetId] = targetEntry;

    switch(cmd) {
      case "kick":
        io.to(targetId).emit("kicked");
        break;
      case "ban":
        io.to(targetId).emit("banned");
        break;
      case "mute":
        const duration = parseInt(arg) || 60;
        io.to(targetId).emit("muted", duration);
        break;
      default:
        socket.emit("system", "Unknown command");
    }
  });
});

server.listen(PORT, () => console.log("Server running on port " + PORT));
