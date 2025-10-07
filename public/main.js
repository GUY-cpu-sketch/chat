const socket = io();

// Elements
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");
const onlineBox = document.getElementById("onlineUsers");

let lastMessageTime = 0;
let lastWhisperFrom = null;

// 🔐 LOGIN & REGISTER
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username and password");

    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    socket.emit("login", { username, password });
  });

  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Enter username and password");
    socket.emit("register", { username, password });
  });

  socket.on("loginSuccess", () => {
    window.location.href = "chat.html";
  });

  socket.on("loginError", (msg) => alert(msg));
  socket.on("registerSuccess", () => alert("Account created! You can now log in."));
  socket.on("registerError", (msg) => alert(msg));
}

// 💬 CHAT SYSTEM
if (chatForm) {
  const username = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");

  if (!username || !password) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected", "true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username, password });
  }

  // Send message
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

    // Whisper
    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if (!target || !message) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { target, message });
      chatInput.value = "";
      return;
    }

    // Reply
    if (msg.startsWith("/reply ")) {
      if (!lastWhisperFrom) return alert("No one has whispered to you yet!");
      const message = msg.slice(7);
      socket.emit("whisper", { target: lastWhisperFrom, message });
      chatInput.value = "";
      return;
    }

    // Admin commands or /chatgpt
    if (msg.startsWith("/")) {
      const [cmd, target, arg] = msg.slice(1).split(" ");
      if(cmd === "chatgpt") {
        socket.emit("chat", msg);
      } else {
        socket.emit("adminCommand", { cmd, target, arg });
      }
      chatInput.value = "";
      return;
    }

    // Normal chat
    socket.emit("chat", msg);
    chatInput.value = "";
  });

  // Receive chat
  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${data.user}</b>: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("whisper", ({ from, message }) => {
    lastWhisperFrom = from;

    const p = document.createElement("p");
    p.style.color = "#ffb86c";
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${from} → You</b>: ${message}`;
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

  socket.on("kicked", () => {
    alert("You were kicked by an admin!");
    window.close();
  });

  socket.on("banned", () => {
    alert("You were banned by an admin!");
    window.close();
  });

  socket.on("onlineUsers", (list) => {
    if (!onlineBox) return;
    onlineBox.innerHTML = "";
    list.forEach(u => {
      const li = document.createElement("li");
      li.textContent = u;
      onlineBox.appendChild(li);
    });
  });
}

// Admin whisper logs
const whisperLogs = document.getElementById("whisperLogs");
if (whisperLogs) {
  socket.on("updateWhispers", (allWhispers) => {
    whisperLogs.innerHTML = "";
    allWhispers.forEach(w => {
      const p = document.createElement("p");
      const time = new Date(w.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
      p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${w.from}</b> → <b>${w.to}</b>: ${w.message}`;
      whisperLogs.appendChild(p);
    });
    whisperLogs.scrollTop = whisperLogs.scrollHeight;
  });
}
