// Connect socket
const socket = io();

// ---------------------------
// LOGIN / REGISTER
// ---------------------------
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");
const onlineCount = document.getElementById("onlineCount");
const userListBox = document.getElementById("userList");

let lastWhisperFrom = null;

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

  socket.on("loginSuccess", () => window.location.href = "chat.html");
  socket.on("loginError", msg => console.error("[LOGIN ERROR]", msg));
  socket.on("registerSuccess", () => console.log("Account created!"));
  socket.on("registerError", msg => console.error("[REGISTER ERROR]", msg));
}

// ---------------------------
// CHAT + WHISPER SYSTEM
// ---------------------------
if (chatForm) {
  const username = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");

  if (!username || !password) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected","true");
      window.location.href="index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login",{username,password});
  }

  let lastMessageTime = 0;

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const to = parts[1];
      const message = parts.slice(2).join(" ");
      if (!to || !message) return console.error("Usage: /whisper [username] [message]");
      socket.emit("whisper", { to, message });
      chatInput.value = "";
      return;
    }

    if (msg.startsWith("/reply ")) {
      if (!lastWhisperFrom) return console.error("No one has whispered you yet");
      const message = msg.split(" ").slice(1).join(" ");
      socket.emit("whisper", { to: lastWhisperFrom, message });
      chatInput.value = "";
      return;
    }

    const now = Date.now();
    if (now - lastMessageTime < 2000) return console.error("Slow down! (2s cooldown)");
    lastMessageTime = now;

    socket.emit("chat", msg);
    chatInput.value = "";
  });

  // Display chat messages
  socket.on("chat", data => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${data.user}</b>: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // Display whispers
  socket.on("whisper", data => {
    lastWhisperFrom = data.from;
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    p.style.color="#00bfff";
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${data.from} ➜ you:</b> ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;

    const sound = new Audio("sounds/notification.mp3");
    sound.play().catch(()=>{});
  });

  socket.on("whisperSent", data => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    p.style.color="#7fffd4";
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>you ➜ ${data.to}:</b> ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("system", msg => {
    const p = document.createElement("p");
    p.style.color="#888";
    p.textContent=`[SYSTEM] ${msg}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("kicked", ()=>{alert("You were kicked by an admin!"); window.close();});
  socket.on("banned", ()=>{alert("You were banned by an admin!"); window.close();});

  socket.on("updateUsers", list => {
    if (onlineCount) onlineCount.textContent = list.length;
    if (userListBox) userListBox.innerHTML = list.map(u=>`<li>${u}</li>`).join("");
  });
}

// ---------------------------
// ADMIN COMMANDS (ENTER / COMMANDS)
// ---------------------------
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

// ---------------------------
// GLOBAL ERROR LOGGING
// ---------------------------
window.addEventListener("error", (e) => {
    console.error("[GLOBAL ERROR]", e.message, e.filename, e.lineno, e.colno, e.error);
});

window.addEventListener("unhandledrejection", (e) => {
    console.error("[UNHANDLED PROMISE REJECTION]", e.reason);
});
