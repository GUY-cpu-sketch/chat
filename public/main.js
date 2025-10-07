// public/main.js
const socket = io();

// elements
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
const userList = document.getElementById("userList");
const whisperLogs = document.getElementById("whisperLogs"); // admin page

let lastWhisperFrom = null;

// --- login/register handlers ---
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Type username & password");
    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    socket.emit("login", { username, password });
  });

  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Type username & password");
    socket.emit("register", { username, password });
  });

  socket.on("loginSuccess", () => { window.location.href = "chat.html"; });
  socket.on("loginError", (msg) => { console.error("[LOGIN ERROR]", msg); alert(msg); });
  socket.on("registerSuccess", () => { alert("Registered! You can login now."); });
  socket.on("registerError", msg => { console.error("[REG ERR]", msg); alert(msg); });
}

// --- chat page logic ---
if (chatForm) {
  const savedUser = sessionStorage.getItem("username");
  const savedPass = sessionStorage.getItem("password");
  if (!savedUser || !savedPass) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected", "true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username: savedUser, password: savedPass });
  }

  let lastMessageTime = 0;
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
    // whisper
    if (raw.startsWith("/whisper ")) {
      const parts = raw.split(" ");
      const to = parts[1];
      const message = parts.slice(2).join(" ");
      if (!to || !message) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { to, message });
      chatInput.value = "";
      return;
    }
    // reply
    if (raw.startsWith("/reply ")) {
      if (!lastWhisperFrom) return alert("No one whispered you yet");
      const message = raw.split(" ").slice(1).join(" ");
      socket.emit("whisper", { to: lastWhisperFrom, message });
      chatInput.value = "";
      return;
    }
    // /chatgpt handled server-side; just send message
    if (raw.startsWith("/")) {
      // admin commands (handled server-side)
      const [cmd, target, ...rest] = raw.slice(1).split(" ");
      if (!cmd || !target) return alert("Admin cmd usage: /cmd target [arg]");
      socket.emit("adminCommand", { cmd, target, arg: rest.join(" ") });
      chatInput.value = "";
      return;
    }

    // anti-spam cooldown
    const now = Date.now();
    if (now - lastMessageTime < 2000) {
      alert("Slow down — 2s cooldown");
      return;
    }
    lastMessageTime = now;

    socket.emit("chat", raw);
    chatInput.value = "";
  });

  // incoming chat
  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
    const safeUser = escapeHTML(data.user);
    const safeMsg = escapeHTML(data.message);
    // style ChatGPT specially
    if (data.user === "ChatGPT") {
      p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b style="color:#7CFC00">${safeUser}</b>: ${safeMsg}`;
    } else {
      p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>${safeUser}</b>: ${safeMsg}`;
    }
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // system messages
  socket.on("system", (msg) => {
    const p = document.createElement("p");
    p.style.color = "#888";
    p.textContent = `[SYSTEM] ${msg}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // kicked / banned
  socket.on("kicked", () => { alert("Kicked by admin"); window.close(); });
  socket.on("banned", () => { alert("Banned by admin"); window.close(); });

  // whisper receipt
  socket.on("whisper", (data) => {
    lastWhisperFrom = data.from;
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
    p.style.color = "#00bfff";
    p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>${escapeHTML(data.from)} ➜ you:</b> ${escapeHTML(data.message)}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
    // notif sound
    const audio = new Audio("/sounds/notification.mp3");
    audio.currentTime = 0;
    audio.play().catch(()=>{});
  });

  // whisper sent (confirmation to sender)
  socket.on("whisperSent", (data) => {
    const p = document.createElement("p");
    p.style.color = "#7fffd4";
    const time = new Date(data.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
    p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>you ➜ ${escapeHTML(data.to)}:</b> ${escapeHTML(data.message)}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // update user list
  socket.on("updateUsers", (list) => {
    if (onlineCount) onlineCount.textContent = list.length;
    if (userList) userList.innerHTML = list.map(u => `<li>${escapeHTML(u)}</li>`).join("");
  });
}

// admin whisper logs on admin HTML
if (typeof whisperLogs !== "undefined" && whisperLogs) {
  socket.on("updateWhispers", (all) => {
    whisperLogs.innerHTML = "";
    all.forEach(w => {
      const p = document.createElement("p");
      const time = new Date(w.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
      p.innerHTML = `<span style="color:#aaa">[${time}]</span> <b>${escapeHTML(w.from)}</b> ➜ <b>${escapeHTML(w.to)}</b>: ${escapeHTML(w.message)}`;
      whisperLogs.appendChild(p);
    });
    whisperLogs.scrollTop = whisperLogs.scrollHeight;
  });
}

// helper escape
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// global error logging to console (no secret console)
window.addEventListener("error", (e) => {
  console.error("[GLOBAL ERROR]", e.message, e.filename, e.lineno, e.colno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[UNHANDLED REJECTION]", e.reason);
});
