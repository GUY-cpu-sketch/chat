// main.js
const socket = io();

// -------------------- DOM Elements --------------------
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");
const userList = document.getElementById("userList");
const whisperLogs = document.getElementById("whisperLogs");
const typingIndicator = document.getElementById("typingIndicator");
const statusBtn = document.getElementById("statusBtn");
const statusInput = document.getElementById("statusInput");
const darkToggle = document.getElementById("darkToggle");
const adminBtn = document.getElementById("adminBtn");

// -------------------- State --------------------
let myUsername = sessionStorage.getItem("username") || null;
let isAdmin = sessionStorage.getItem("isAdmin") === "true";
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;
let typingUsers = {}; // user -> timestamp

// -------------------- Sounds --------------------
const sounds = {
  join: new Audio('/sounds/join.mp3'),
  whisper: new Audio('/sounds/whisper.mp3'),
  mention: new Audio('/sounds/mention.mp3')
};

function playSound(name) {
  try { sounds[name]?.play().catch(()=>{}); } catch(e) {}
}

// -------------------- AUTH --------------------
if (loginBtn && registerBtn) {
  loginBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");

    socket.emit("login", { username, password });

    socket.once("loginSuccess", ({ isAdmin: adminFlag }) => {
      isAdmin = !!adminFlag;
      sessionStorage.setItem("username", username);
      sessionStorage.setItem("password", password);
      sessionStorage.setItem("isAdmin", isAdmin ? "true" : "false");
      window.location.href = "chat.html";
    });

    socket.once("loginError", (msg) => alert(msg));
    socket.once("banned", (msg) => alert(msg));
  });

  registerBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");

    socket.emit("register", { username, password });

    socket.once("registerSuccess", () => {
      alert("Registered successfully! You can now log in.");
    });
    socket.once("registerError", (msg) => alert(msg));
  });
}

// -------------------- CHAT PAGE INIT --------------------
if (chatForm) {
  myUsername = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");

  if (!myUsername || !password) {
    window.location.href = "index.html";
  } else {
    socket.emit("login", { username: myUsername, password });
  }

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = chatInput.value.trim();
    if (!raw) return;

    const now = Date.now();
    if (now - lastMessageTime < 2000) {
      alert("Slow down! (2s cooldown)");
      return;
    }
    lastMessageTime = now;

    socket.emit("chat", raw);
    chatInput.value = "";
  });
}

// -------------------- SOCKET HANDLERS --------------------
socket.on('loginSuccess', (data) => {
  if (chatBox) addSystemMessage(`Welcome ${sessionStorage.getItem("username")}!`);
});

socket.on('chat', (data) => {
  addMessage(data.user, data.message);
});

socket.on('updateUsers', (list) => {
  if (!userList) return;
  userList.innerHTML = '';
  list.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    userList.appendChild(li);
  });
});

socket.on('system', (msg) => addSystemMessage(msg));

socket.on('kicked', (msg) => {
  alert(msg);
  window.location.href = "index.html";
});

socket.on('banned', (msg) => {
  alert(msg);
  window.location.href = "index.html";
});

// -------------------- Helper Functions --------------------
function addMessage(user, msg) {
  const div = document.createElement('div');
  div.classList.add('message');
  div.innerHTML = `<strong>${user}:</strong> ${msg}`;
  chatBox?.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addSystemMessage(msg) {
  const div = document.createElement('div');
  div.classList.add('systemMessage');
  div.textContent = msg;
  chatBox?.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// -------------------- DARK MODE --------------------
if (darkToggle) {
  const saved = localStorage.getItem('dark') === 'true';
  document.documentElement.classList.toggle('dark', saved);
  darkToggle.checked = saved;
  darkToggle.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('dark', e.target.checked);
    localStorage.setItem('dark', e.target.checked);
  });
}
