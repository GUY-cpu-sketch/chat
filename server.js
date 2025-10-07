const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const bcrypt = require("bcryptjs"); // <-- swapped from bcrypt

app.use(express.static("public"));
app.use(express.json());

let users = {};      // username: { passwordHash, banned }
let online = {};     // socket.id : username
let whispers = [];   // {from,to,message,time}

// ----------------------
// SOCKET.IO
// ----------------------
io.on("connection", (socket) => {

  // LOGIN
  socket.on("login", async ({username,password}) => {
    if (!users[username]) return socket.emit("loginError","User does not exist");
    const match = await bcrypt.compare(password, users[username].passwordHash);
    if (!match) return socket.emit("loginError","Incorrect password");
    if (users[username].banned) return socket.emit("banned");
    online[socket.id] = username;
    socket.emit("loginSuccess");
    io.emit("updateUsers", Object.values(online));
  });

  // REGISTER
  socket.on("register", async ({username,password}) => {
    if (users[username]) return socket.emit("registerError","User already exists");
    const hash = await bcrypt.hash(password,10);
    users[username] = {passwordHash: hash, banned: false};
    socket.emit("registerSuccess");
  });

  // CHAT
  socket.on("chat", (msg) => {
    const username = online[socket.id];
    if (!username) return;
    const data = {user: username, message: msg, time: Date.now()};
    io.emit("chat", data);
  });

  // WHISPER
  socket.on("whisper", ({to,message}) => {
    const from = online[socket.id];
    if (!from) return;
    const data = {from,to,message,time: Date.now()};
    whispers.push(data);
    // Send to recipient
    for (let [id,user] of Object.entries(online)) {
      if (user === to) io.to(id).emit("whisper", data);
    }
    // Confirm to sender
    socket.emit("whisperSent", data);
    // Update admin
    io.emit("updateWhispers", whispers);
  });

  // ADMIN COMMANDS
  socket.on("adminCommand", ({cmd,target,arg}) => {
    const sender = online[socket.id];
    if (sender !== "DEV") return;
    if (!target) return;
    switch(cmd) {
      case "mute":
        const duration = parseInt(arg) || 60;
        io.emit("system", `${target} muted for ${duration}s`);
        break;
      case "kick":
        for (let [id,user] of Object.entries(online)) {
          if (user === target) io.to(id).emit("kicked");
        }
        break;
      case "ban":
        for (let [id,user] of Object.entries(online)) {
          if (user === target) {
            users[target].banned = true;
            io.to(id).emit("banned");
          }
        }
        break;
    }
  });

  socket.on("disconnect", () => {
    delete online[socket.id];
    io.emit("updateUsers", Object.values(online));
  });

});

http.listen(process.env.PORT || 3000, () => console.log("Server running"));
