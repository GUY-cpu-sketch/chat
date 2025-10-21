// main.js
const socket = io();

// ------------------- ELEMENTS -------------------
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

let myUsername = sessionStorage.getItem("username") || null;
let myPassword = sessionStorage.getItem("password") || null;
let isAdmin = false;
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;
let typingUsers = {}; // user -> timestamp

const sounds = {
  join: new Audio('/sounds/join.mp3'),
  whisper: new Audio('/sounds/whisper.mp3'),
  mention: new Audio('/sounds/mention.mp3')
};

function playSound(name) {
  try { sounds[name]?.play()?.catch(() => {}); } catch(e) {}
}

// ------------------- LOGIN & REGISTER -------------------
if(window.location.pathname.endsWith("index.html") || window.location.pathname === "/"){
  if(loginBtn){
    loginBtn.addEventListener("click", () => {
      const username = loginUsername.value.trim();
      const password = loginPassword.value.trim();
      if(!username || !password) return alert("Enter username & password");
      sessionStorage.setItem("username", username);
      sessionStorage.setItem("password", password);
      myUsername = username;
      myPassword = password;
      socket.emit("login", { username, password });
    });
  }

  if(registerBtn){
    registerBtn.addEventListener("click", () => {
      const username = registerUsername.value.trim();
      const password = registerPassword.value.trim();
      if(!username || !password) return alert("Enter username & password");
      sessionStorage.setItem("username", username);
      sessionStorage.setItem("password", password);
      myUsername = username;
      myPassword = password;
      socket.emit("register", { username, password });
    });
  }

  socket.on("loginSuccess", ({ isAdmin: adminFlag }) => {
    isAdmin = !!adminFlag;
    sessionStorage.setItem("isAdmin", isAdmin);
    window.location.href = "chat.html";
  });

  socket.on("loginError", msg => alert(msg));
  socket.on("registerSuccess", () => alert("Registered! You can now login."));
  socket.on("registerError", msg => alert(msg));
}

// ------------------- CHAT PAGE -------------------
if(window.location.pathname.endsWith("chat.html")){
  myUsername = sessionStorage.getItem("username");
  myPassword = sessionStorage.getItem("password");
  isAdmin = sessionStorage.getItem("isAdmin") === "true";

  if(!myUsername || !myPassword){
    if(!sessionStorage.getItem("redirected")){
      sessionStorage.setItem("redirected","true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username: myUsername, password: myPassword });
  }

  // ----------------- CHAT FORM -----------------
  chatForm?.addEventListener("submit", e => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if(!msg) return;

    const now = Date.now();
    if(now - lastMessageTime < 2000){
      alert("Slow down! (2s cooldown)");
      return;
    }
    lastMessageTime = now;

    if(msg.startsWith("/status ")){
      const status = msg.slice(8).trim();
      socket.emit("setStatus", status);
      chatInput.value = "";
      return;
    }

    if(msg.startsWith("/whisper ")){
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if(!target || !message) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { target, message });
      chatInput.value = "";
      return;
    }

    if(msg.startsWith("/reply ")){
      if(!lastWhisperFrom) return alert("No one has whispered you yet!");
      const message = msg.slice(7);
      socket.emit("whisper", { target: lastWhisperFrom, message });
      chatInput.value = "";
      return;
    }

    if(msg.startsWith("/")){
      const parts = msg.slice(1).split(" ");
      const cmd = parts[0];
      const target = parts[1];
      const arg = parts.slice(2).join(" ");
      socket.emit("adminCommand", { cmd, target, arg });
      chatInput.value = "";
      return;
    }

    socket.emit("chat", msg);
    chatInput.value = "";
  });

  chatInput?.addEventListener("input", () => {
    socket.emit("typing", true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit("typing", false), 1200);
  });

  // status button
  statusBtn?.addEventListener("click", () => {
    const s = statusInput.value.trim();
    socket.emit("setStatus", s);
    statusInput.value = "";
  });

  // user list -> profile
  userList?.addEventListener("click", e => {
    const li = e.target.closest("li");
    if(!li) return;
    socket.emit("getProfile", { username: li.dataset.username });
  });

  // admin panel open
  adminBtn?.addEventListener("click", () => {
    if(!isAdmin) return alert("Admins only");
    window.location.href = "/admin";
  });
}

// ------------------- SOCKET EVENTS -------------------
socket.on("messages", arr => {
  if(!chatBox) return;
  chatBox.innerHTML = "";
  arr.forEach(renderMessage);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("chat", data => {
  renderMessage(data);
  chatBox.scrollTop = chatBox.scrollHeight;
  if(myUsername && data.message.includes(`@${myUsername}`)) playSound("mention");
});

socket.on("whisper", ({ from, message }) => {
  lastWhisperFrom = from;
  if(!chatBox) return;
  const p = document.createElement("p");
  const time = new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
  p.innerHTML = `<span class="time">[${time}]</span> <b class="whisper">${escapeHtml(from)} → You</b>: <span>${escapeHtml(message)}</span>`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
  playSound("whisper");
});

socket.on("system", msg => {
  if(!chatBox) return;
  const p = document.createElement("p");
  p.className = "system";
  p.textContent = `[SYSTEM] ${msg}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("kicked", reason => { alert(reason||"You were kicked!"); try{window.close()}catch{} });
socket.on("banned", reason => { alert(reason||"You were banned!"); try{window.close()}catch{} });

socket.on("typing", ({ user, isTyping }) => {
  if(!typingIndicator) return;
  if(isTyping) typingUsers[user] = Date.now();
  else delete typingUsers[user];
  updateTypingText();
});

function updateTypingText(){
  const names = Object.keys(typingUsers).slice(0,3);
  typingIndicator.textContent = names.length ? `${names.join(", ")} is typing...` : "";
}

socket.on("mutedStatus", ({ mutedUntil }) => {
  if(!chatBox) return;
  const p = document.createElement("p");
  p.className = "system";
  p.textContent = `You are muted until ${new Date(mutedUntil).toLocaleString()}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on("playSound", name => playSound(name));
socket.on("updateUsers", list => {
  if(!userList) return;
  userList.innerHTML = "";
  list.forEach(u => {
    const li = document.createElement("li");
    li.dataset.username = u.username;
    li.innerHTML = `<span class="avatar">${avatarFor(u.username)}</span><b>${escapeHtml(u.username)}</b> <span class="status">${escapeHtml(u.status||"")}</span> ${u.isAdmin?'<span class="adminBadge">ADMIN</span>':''} ${u.mutedUntil?'<span class="mutedBadge">MUTED</span>':''}`;
    userList.appendChild(li);
  });
});

socket.on("updateWhispers", all => {
  if(!whisperLogs) return;
  whisperLogs.innerHTML = "";
  all.forEach(w => {
    const time = new Date(w.time).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    const p = document.createElement("p");
    p.innerHTML = `<span class="time">[${time}]</span> <b>${escapeHtml(w.from)}</b> → <b>${escapeHtml(w.to)}</b>: <span>${escapeHtml(w.message)}</span>`;
    whisperLogs.appendChild(p);
  });
});

// ------------------- UI HELPERS -------------------
function renderMessage(data){
  if(!chatBox) return;
  const wrapper = document.createElement("div");
  wrapper.className = "message";
  wrapper.dataset.id = data.id;

  const meta = document.createElement("div");
  meta.className = "meta";
  const time = new Date(data.time).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  meta.innerHTML = `<span class="time">[${time}]</span> <span class="avatar small">${avatarFor(data.user)}</span> <b class="user ${data.user==="DEV"?"adminColor":""}">${escapeHtml(data.user)}</b> ${data.edited?'<span class="edited">(edited)</span>':''}`;

  const body = document.createElement("div");
  body.className = "msg-text";
  body.innerHTML = formatText(data.message) + (data.edited ? ' <span class="edited">(edited)</span>':'');

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const currentUser = sessionStorage.getItem("username");
  const amAdmin = isAdmin || sessionStorage.getItem("isAdmin")==="true";
  if(data.user === currentUser || amAdmin){
    const editBtn = document.createElement("button");
    editBtn.className = "tiny";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", ()=>openEditDialog(data.id));
    const delBtn = document.createElement("button");
    delBtn.className = "tiny danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", ()=>{ if(confirm("Delete this message?")) socket.emit("deleteMessage",{id:data.id}) });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
  }

  wrapper.appendChild(meta);
  wrapper.appendChild(body);
  wrapper.appendChild(actions);
  chatBox.appendChild(wrapper);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function openEditDialog(id){
  const el = document.querySelector(`[data-id="${id}"]`);
  if(!el) return;
  const body = el.querySelector(".msg-text");
  const old = body?.textContent || "";
  const newText = prompt("Edit message:", old);
  if(newText===null) return;
  socket.emit("editMessage",{ id, newText });
}

function formatText(str){
  let s = escapeHtml(str);
  s = s.replace(/\*\*(.+?)\*\*/g,"<b>$1</b>");
  s = s.replace(/_(.+?)_/g,"<i>$1</i>");
  s = s.replace(/~(.+?)~/g,"<s>$1</s>");
  s = s.replace(/\n/g,"<br/>");
  return s;
}

function escapeHtml(str){
  if(!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function avatarFor(name){
  if(!name) return "?";
  const initial = escapeHtml(name[0].toUpperCase());
  return `<span class="avatar-circle">${initial}</span>`;
}

// dark mode toggle
if(darkToggle){
  const saved = localStorage.getItem("dark")==="true";
  document.documentElement.classList.toggle("dark", saved);
  darkToggle.checked = saved;
  darkToggle.addEventListener("change", e => {
    document.documentElement.classList.toggle("dark", e.target.checked);
    localStorage.setItem("dark", e.target.checked);
  });
}
