// Connect socket
const socket = io();

// Get page elements (they might not exist on every page)
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");

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
// 💬 CHAT SYSTEM
// =========================
if (chatForm) {
  const username = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");

  // Prevent redirect loop
  if (!username || !password) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected", "true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username, password });
  }

  // Chat send
  let lastMessageTime = 0;
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

    socket.emit("chat", msg);
    chatInput.value = "";
  });

  // Display messages
  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${data.user}</b>: ${data.message}`;
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
// 🧠 ADMIN COMMANDS
// =========================
if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && chatInput.value.startsWith("/")) {
      e.preventDefault();
      const [cmd, target, arg] = chatInput.value.slice(1).split(" ");
      socket.emit("adminCommand", { cmd, target, arg });
      chatInput.value = "";
    }
  });
}

// =========================
// 🕹️ KONAMI CODE CONSOLE
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
  const box = document.createElement("div");
  box.style.position = "fixed";
  box.style.bottom = "10px";
  box.style.left = "10px";
  box.style.width = "400px";
  box.style.height = "200px";
  box.style.background = "#1e1f22";
  box.style.color = "#0f0";
  box.style.fontFamily = "monospace";
  box.style.padding = "10px";
  box.style.border = "2px solid #0f0";
  box.style.overflowY = "auto";
  box.style.zIndex = "9999";
  box.id = "secretConsole";
  document.body.appendChild(box);

  const log = (msg) => {
    const p = document.createElement("p");
    p.textContent = msg;
    box.appendChild(p);
  };

  log("🧩 Debug Console Opened!");
  log("Logs will appear here...");

  const oldErr = console.error;
  const oldLog = console.log;

  console.error = (...args) => {
    oldErr(...args);
    log("[ERR] " + args.join(" "));
  };

  console.log = (...args) => {
    oldLog(...args);
    log("[LOG] " + args.join(" "));
  };
}
