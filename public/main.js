// Connect to socket.io
const socket = io();

// Konami Code setup (for console)
let konamiCode = ["w","w","s","s","a","d","a","d"];
let konamiProgress = 0;
let consoleVisible = false;

// Create hidden console
const debugConsole = document.createElement("div");
debugConsole.style.position = "fixed";
debugConsole.style.bottom = "10px";
debugConsole.style.left = "10px";
debugConsole.style.width = "95%";
debugConsole.style.height = "200px";
debugConsole.style.background = "rgba(0,0,0,0.9)";
debugConsole.style.color = "#0f0";
debugConsole.style.fontFamily = "monospace";
debugConsole.style.fontSize = "13px";
debugConsole.style.overflowY = "auto";
debugConsole.style.padding = "10px";
debugConsole.style.borderRadius = "10px";
debugConsole.style.display = "none";
debugConsole.style.zIndex = "9999";
debugConsole.id = "debugConsole";
document.body.appendChild(debugConsole);

// Show console when Konami code entered
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === konamiCode[konamiProgress]) {
    konamiProgress++;
    if (konamiProgress === konamiCode.length) {
      consoleVisible = !consoleVisible;
      debugConsole.style.display = consoleVisible ? "block" : "none";
      konamiProgress = 0;
      logToConsole("Console toggled!");
    }
  } else {
    konamiProgress = 0;
  }
});

function logToConsole(msg) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugConsole.appendChild(line);
  debugConsole.scrollTop = debugConsole.scrollHeight;
}

// Catch JS errors
window.addEventListener("error", (err) => {
  logToConsole("⚠️ JS Error: " + err.message);
});

// Page element refs
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");

// Login
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");

    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    socket.emit("login", { username, password });
  });
}

// Register
if (registerBtn) {
  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");

    socket.emit("register", { username, password });
  });
}

// On successful login
socket.on("loginSuccess", () => {
  window.location.href = "chat.html";
});

// On register success
socket.on("registerSuccess", () => {
  alert("Registered successfully! You can now log in.");
  window.location.href = "index.html";
});

// On login error
socket.on("loginError", (msg) => {
  alert(msg);
});

// Chat page logic
if (chatForm) {
  const username = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");

  if (!username || !password) {
    alert("You must log in first!");
    window.location.href = "index.html";
  } else {
    socket.emit("login", { username, password });
  }

  // Message sending with cooldown
  let canSend = true;
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message || !canSend) return;
    socket.emit("chatMessage", message);
    chatInput.value = "";
    canSend = false;
    setTimeout(() => (canSend = true), 800); // cooldown
  });

  // Listen for chat messages
  socket.on("chatMessage", (data) => {
    const msg = document.createElement("p");
    msg.textContent = `${data.username}: ${data.message}`;
    chatBox.appendChild(msg);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // Show system messages
  socket.on("systemMessage", (msg) => {
    const sys = document.createElement("p");
    sys.style.color = "#999";
    sys.textContent = `[SYSTEM] ${msg}`;
    chatBox.appendChild(sys);
  });
}
