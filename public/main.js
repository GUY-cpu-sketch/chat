// =========================
// 🔌 SOCKET + ELEMENTS
// =========================
const socket = io();

// General elements
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");
const whisperLogs = document.getElementById("whisperLogs");

// =========================
// 🔐 LOGIN & REGISTER
// =========================
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

// =========================
// 💬 CHAT + WHISPER SYSTEM
// =========================
let lastMessageTime = 0;
let lastWhisperFrom = null;
const whisperSound = new Audio("/sounds/notification.mp3");

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

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    let msg = chatInput.value.trim();
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

    // Admin commands
    if (msg.startsWith("/")) {
      const [cmd, target, arg] = msg.slice(1).split(" ");
      socket.emit("adminCommand", { cmd, target, arg });
      chatInput.value = "";
      return;
    }

    socket.emit("chat", msg);
    chatInput.value = "";
  });

  // Normal chat
  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${data.user}</b>: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // Whisper
  socket.on("whisper", ({ from, message }) => {
    lastWhisperFrom = from;
    whisperSound.currentTime = 0;
    whisperSound.play().catch(() => {});

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
}

// =========================
// 🧠 ADMIN WHISPER LOGS
// =========================
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

// =========================
// 🕹️ KONAMI DEBUG CONSOLE
// =========================
let konami = [];
const KONAMI_SEQ = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","a","d","a","d"];

window.addEventListener("keydown", (e) => {
  konami.push(e.key);
  if (konami.length > KONAMI_SEQ.length) konami.shift();
  if (JSON.stringify(konami) === JSON.stringify(KONAMI_SEQ)) {
    showDebugConsole();
  }
});

function showDebugConsole() {
  if (document.getElementById("secretConsole")) return;

  const box = document.createElement("div");
  box.id = "secretConsole";
  box.style.position = "fixed";
  box.style.bottom = "10px";
  box.style.left = "10px";
  box.style.width = "400px";
  box.style.height = "200px";
  box.style.background = "#1e1f22";
  box.style.color = "#00ff88";
  box.style.fontFamily = "monospace";
  box.style.padding = "10px";
  box.style.border = "2px solid #00ff88";
  box.style.borderRadius = "8px";
  box.style.overflowY = "auto";
  box.style.zIndex = "9999";
  box.textContent = "🧩 Debug Console Activated\n";

  document.body.appendChild(box);

  const oldLog = console.log;
  const oldErr = console.error;

  console.log = (...args) => {
    oldLog(...args);
    const p = document.createElement("p");
    p.textContent = "[LOG] " + args.join(" ");
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  };

  console.error = (...args) => {
    oldErr(...args);
    const p = document.createElement("p");
    p.style.color = "red";
    p.textContent = "[ERR] " + args.join(" ");
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  };

  window.addEventListener("error", (e) => {
    const p = document.createElement("p");
    p.style.color = "red";
    p.textContent = "[ERROR] " + e.message;
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  });
}
