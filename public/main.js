const socket = io();

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

let lastWhisperFrom = null;
let lastMessageTime = 0;

// === AUTH ===
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    socket.emit("login", { username, password });
  });

  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    socket.emit("register", { username, password });
  });

  socket.on("loginSuccess", () => (window.location.href = "chat.html"));
  socket.on("loginError", (msg) => alert(msg));
  socket.on("registerSuccess", () => alert("Registered!"));
  socket.on("registerError", (msg) => alert(msg));
}

// === CHAT ===
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
    const msg = chatInput.value.trim();
    if (!msg) return;

    lastMessageTime = now;

    // whisper
    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if (!target || !message)
        return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { target, message });
      chatInput.value = "";
      return;
    }

    // reply
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

  // === MESSAGE RENDERING ===
  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    let color;
    if (data.user === "DEV") color = "#f04747"; // red for admin
    else if (data.user === "ChatGPT") color = "#57f287"; // greenish for AI
    else color = "#00aff4"; // cyan for normal users

    p.innerHTML = `
      <span style="color:#aaa; font-size:12px;">[${time}]</span>
      <b style="color:${color}">${data.user}</b>:
      <span>${escapeHtml(data.message)}</span>
    `;

    p.style.padding = "4px 0";
    p.style.transition = "background 0.2s";
    p.addEventListener("mouseenter", () => (p.style.background = "#2f3136"));
    p.addEventListener("mouseleave", () => (p.style.background = "transparent"));

    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // whispers
  socket.on("whisper", ({ from, message }) => {
    lastWhisperFrom = from;
    const p = document.createElement("p");
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    p.innerHTML = `
      <span style="color:#aaa; font-size:12px;">[${time}]</span>
      <b style="color:#ffb86c">${from} → You</b>:
      <span style="color:#ffb86c">${escapeHtml(message)}</span>
    `;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // system messages
  socket.on("system", (msg) => {
    const p = document.createElement("p");
    p.style.color = "#888";
    p.style.fontStyle = "italic";
    p.textContent = `[SYSTEM] ${msg}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // admin actions
  socket.on("kicked", () => {
    alert("You were kicked!");
    window.close();
  });
  socket.on("banned", () => {
    alert("You were banned!");
    window.close();
  });

  // update lists
  socket.on("updateUsers", (list) => {
    if (userList) {
      userList.innerHTML = list.map((u) => `<li>${escapeHtml(u)}</li>`).join("");
    }
  });

  socket.on("updateWhispers", (all) => {
    if (whisperLogs) {
      whisperLogs.innerHTML = "";
      all.forEach((w) => {
        const time = new Date(w.time).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const p = document.createElement("p");
        p.innerHTML = `
          <span style="color:#aaa; font-size:12px;">[${time}]</span>
          <b>${escapeHtml(w.from)}</b> → <b>${escapeHtml(w.to)}</b>:
          <span>${escapeHtml(w.message)}</span>
        `;
        whisperLogs.appendChild(p);
      });
    }
  });
}

// === HTML escape helper ===
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
