const socket = io();

// Login/register
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");

// Chat
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");
const userList = document.getElementById("userList");
const whisperLogs = document.getElementById("whisperLogs");

let lastWhisperFrom = null;
let lastMessageTime = 0;

// LOGIN & REGISTER
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    socket.emit("login", { username });
  });

  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    socket.emit("register", { username });
  });

  socket.on("loginSuccess", () => window.location.href = "chat.html");
  socket.on("loginError", (msg) => alert(msg));
  socket.on("registerSuccess", () => alert("Registered!"));
  socket.on("registerError", (msg) => alert(msg));
}

// CHAT PAGE
if (chatForm) {
  const username = sessionStorage.getItem("username");
  if (!username) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected", "true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username });
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    const now = Date.now();
    if (now - lastMessageTime < 2000) {
      alert("Slow down! (2s cooldown)");
      return;
    }
    lastMessageTime = now;

    // /whisper
    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if (!target || !message) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { target, message });
      chatInput.value = "";
      return;
    }

    // /reply
    if (msg.startsWith("/reply ")) {
      if (!lastWhisperFrom) return alert("No one has whispered you yet!");
      const message = msg.slice(7);
      socket.emit("whisper", { target: lastWhisperFrom, message });
      chatInput.value = "";
      return;
    }

    // admin commands
    if (msg.startsWith("/")) {
      const parts = msg.slice(1).split(" ");
      const cmd = parts[0];
      const target = parts[1];
      const arg = parts.slice(2).join(" ");
      socket.emit("adminCommand", { cmd, target, arg });
      chatInput.value = "";
      return;
    }

    // normal chat
    socket.emit("chat", msg);
    chatInput.value = "";
  });

  // SOCKET LISTENERS
  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>${data.user}</b>: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("whisper", ({ from, message }) => {
    lastWhisperFrom = from;
    const p = document.createElement("p");
    p.style.color = "#ffb86c";
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>${from} → You</b>: ${message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("system", (msg) => {
    const p = document.createElement("p");
    p.style.color = "#888";
    p.textContent = `[SYSTEM] ${msg}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("kicked", (msg) => {
    alert(msg || "You were kicked!");
    window.location.href = "index.html";
  });

  socket.on("banned", (msg) => {
    alert(msg || "You were banned!");
    window.location.href = "index.html";
  });

  socket.on("updateUsers", (list) => {
    if (userList) userList.innerHTML = list.map(u => `<li>${u}</li>`).join("");
  });

  socket.on("updateWhispers", (all) => {
    if (whisperLogs) {
      whisperLogs.innerHTML = "";
      all.forEach((w) => {
        const p = document.createElement("p");
        const time = new Date(w.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>${w.from}</b> → <b>${w.to}</b>: ${w.message}`;
        whisperLogs.appendChild(p);
      });
    }
  });
}
