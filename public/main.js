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
const typingIndicator = document.getElementById("typingIndicator");

const statusBtn = document.getElementById("statusBtn");
const statusInput = document.getElementById("statusInput");
const darkToggle = document.getElementById("darkToggle");
const adminBtn = document.getElementById("adminBtn");

// Avatar & Color
const avatarInput = document.getElementById("avatarInput");
const colorInput = document.getElementById("colorInput");
const reportBtn = document.getElementById("reportBtn");

let myUsername = sessionStorage.getItem("username") || null;
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;

// -------------------- AUTH --------------------
if(loginBtn && registerBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if(!username || !password) return alert("Enter username & password");
    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    socket.emit("login", { username, password });
  });

  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if(!username || !password) return alert("Enter username & password");
    socket.emit("register", { username, password });
  });

  socket.on("loginSuccess", () => window.location.href = "chat.html");
  socket.on("loginError", msg => alert(msg));
  socket.on("registerSuccess", () => alert("Registered!"));
  socket.on("registerError", msg => alert(msg));
}

// -------------------- Chat --------------------
if(chatForm) {
  myUsername = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");
  if(!myUsername || !password) window.location.href = "index.html";
  else socket.emit("login", { username: myUsername, password });

  chatInput.addEventListener("input", () => {
    socket.emit("typing", true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit("typing", false), 1200);
  });

  chatForm.addEventListener("submit", e => {
    e.preventDefault();
    const raw = chatInput.value.trim();
    if(!raw) return;
    const now = Date.now();
    if(now - lastMessageTime < 2000){ alert("Slow down! (2s cooldown)"); return; }
    lastMessageTime = now;

    // Admin commands
    if(raw.startsWith("/")) {
      const [cmd,target,...args] = raw.slice(1).split(" ");
      const arg = args.join(" ");
      socket.emit("adminCommand",{cmd,target,arg});
      chatInput.value="";
      return;
    }

    // Status
    if(raw.startsWith("/status ")) { socket.emit("setStatus", raw.slice(8).trim()); chatInput.value=""; return; }
    // Whisper
    if(raw.startsWith("/whisper ")) { 
      const [_, target, ...msg] = raw.split(" ");
      if(!target || !msg.length) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper",{target,message:msg.join(" ")});
      chatInput.value=""; return;
    }
    if(raw.startsWith("/reply ")) {
      if(!lastWhisperFrom) return alert("No whispers yet!");
      socket.emit("whisper",{target:lastWhisperFrom,message:raw.slice(7)});
      chatInput.value=""; return;
    }

    socket.emit("chat", raw);
    chatInput.value="";
  });

  // -------------------- Settings --------------------
  statusBtn?.addEventListener("click", () => {
    const s=statusInput.value.trim(); if(s) socket.emit("setStatus",s); statusInput.value="";
  });

  avatarInput?.addEventListener("change", e => { socket.emit("setAvatar", e.target.value); });
  colorInput?.addEventListener("change", e => { socket.emit("setColor", e.target.value); });
  reportBtn?.addEventListener("click", () => {
    const target = prompt("Enter username to report avatar:");
    if(target) socket.emit("reportAvatar",{target});
  });

  adminBtn?.addEventListener("click", () => alert("Admins: DEV, testuser1, skullfucker99"));
}

// -------------------- Socket Events --------------------
socket.on('messages', arr => { chatBox.innerHTML=''; arr.forEach(renderMessage); chatBox.scrollTop=chatBox.scrollHeight; });
socket.on('chat', renderMessage);
socket.on('whisper', ({from,message}) => {
  lastWhisperFrom=from;
  const p=document.createElement('p');
  p.innerHTML=`<b>${from} → You</b>: ${message}`;
  chatBox?.appendChild(p);
  chatBox.scrollTop=chatBox.scrollHeight;
});
socket.on('updateUsers', list => {
  userList.innerHTML='';
  list.forEach(u=>{
    const li=document.createElement('li');
    li.textContent=u.username;
    li.style.color = u.color || '#fff';
    if(u.avatar) li.innerHTML = `<img src="${u.avatar}" class="msg-avatar"> ${u.username}`;
    if(ADMIN_USERS.includes(u.username)) li.style.fontWeight='bold';
    userList.appendChild(li);
  });
});
socket.on('typing', ({user,isTyping}) => typingIndicator.textContent=isTyping?`${user} is typing...`:'');

// -------------------- Helpers --------------------
function renderMessage(data){
  const div = document.createElement('div');
  div.className='chat-msg';
  div.dataset.id=data.id;
  const time = new Date(data.time).toLocaleTimeString();
  div.innerHTML=`${data.avatar?`<img src="${data.avatar}" class="msg-avatar">`:''}<span class="msg-user" style="color:${data.color}">${data.user}</span> <span class="msg-time">[${time}]</span>: <span class="msg-text">${data.message}</span>`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// -------------------- Dark Mode --------------------
document.documentElement.classList.add('dark');
darkToggle.checked=false;
darkToggle?.addEventListener('change', e => document.documentElement.classList.toggle('dark', e.target.checked));
