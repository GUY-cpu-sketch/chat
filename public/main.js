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

// -------------------- Sounds --------------------
const sounds = {
  join: new Audio('/sounds/join.mp3'),
  whisper: new Audio('/sounds/whisper.mp3'),
  mention: new Audio('/sounds/mention.mp3')
};

function playSound(name) {
  try { if(sounds[name]) sounds[name].play().catch(()=>{}); } catch(e) {}
}

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

  socket.on("loginSuccess", ({ isAdmin: adminFlag }) => {
    isAdmin = !!adminFlag;
    sessionStorage.setItem("isAdmin", isAdmin ? "true" : "false");
    window.location.href = "chat.html";
  });

  socket.on("loginError", msg => alert(msg));
  socket.on("registerSuccess", () => alert("Registered!"));
  socket.on("registerError", msg => alert(msg));
}

// -------------------- Chat --------------------
if(chatForm) {
  myUsername = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");
  if(!myUsername || !password) {
    if(!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected","true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username: myUsername, password });
  }

  // Typing indicator
  chatInput.addEventListener("input", () => {
    socket.emit("typing", true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit("typing", false), 1200);
  });

  // Send message
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = chatInput.value.trim();
    if(!raw) return;
    const now = Date.now();
    if(now - lastMessageTime < 2000) { alert("Slow down! (2s cooldown)"); return; }
    lastMessageTime = now;

    // Commands
    if(raw.startsWith("/status ")) { socket.emit("setStatus", raw.slice(8).trim()); chatInput.value=""; return; }
    if(raw.startsWith("/whisper ")) { 
      const parts = raw.split(" "); 
      const target = parts[1]; 
      const message = parts.slice(2).join(" "); 
      if(!target || !message) return alert("Usage: /whisper [username] [message]"); 
      socket.emit("whisper", { target, message }); chatInput.value=""; return; 
    }
    if(raw.startsWith("/reply ")) { 
      if(!lastWhisperFrom) return alert("No whispers yet!"); 
      const message = raw.slice(7);
      socket.emit("whisper", { target:lastWhisperFrom, message }); chatInput.value=""; return; 
    }
    if(raw.startsWith("/")) {
      const [cmd, target, ...args] = raw.slice(1).split(" ");
      const arg = args.join(" ");
      socket.emit("adminCommand", { cmd, target, arg });
      chatInput.value=""; return;
    }

    socket.emit("chat", raw);
    chatInput.value="";
  });

  // Status button
  statusBtn?.addEventListener("click", () => {
    const s = statusInput.value.trim();
    if(s) socket.emit("setStatus", s);
    statusInput.value="";
  });

  // Admin panel
  adminBtn?.addEventListener("click", () => {
    if(isAdmin) window.location.href="/admin"; else alert("Admins only");
  });
}

// -------------------- Socket Events --------------------
socket.on('messages', arr => { chatBox.innerHTML=''; arr.forEach(renderMessage); chatBox.scrollTop=chatBox.scrollHeight; });
socket.on('chat', data => { renderMessage(data); chatBox.scrollTop=chatBox.scrollHeight; if(data.message.includes(`@${myUsername}`)) playSound('mention'); });
socket.on('whisper', ({from, message}) => {
  lastWhisperFrom=from;
  const p = document.createElement('p');
  p.innerHTML=`<b>${from} → You</b>: ${message}`;
  chatBox?.appendChild(p);
  chatBox.scrollTop=chatBox.scrollHeight;
  playSound('whisper');
});
socket.on('editMessage', msg => {
  const el = document.querySelector(`[data-id="${msg.id}"]`);
  if(el) el.querySelector('.msg-text').innerHTML = msg.message + (msg.edited ? ' (edited)' : '');
});
socket.on('deleteMessage', ({id}) => { const el = document.querySelector(`[data-id="${id}"]`); if(el) el.remove(); });
socket.on('updateUsers', list => {
  userList.innerHTML='';
  list.forEach(u=>{
    const li = document.createElement('li');
    li.textContent = u.username;
    if(u.isAdmin) li.style.fontWeight='bold';
    userList.appendChild(li);
  });
});
socket.on('typing', ({ user, isTyping }) => {
  typingIndicator.textContent = isTyping ? `${user} is typing...` : '';
});

// -------------------- Dark Mode --------------------
document.documentElement.classList.add('dark');
darkToggle.checked=false;
darkToggle?.addEventListener('change', e => document.documentElement.classList.toggle('dark', e.target.checked));

// -------------------- Helpers --------------------
function renderMessage(data){
  const div = document.createElement('div');
  div.className='chat-msg';
  div.dataset.id=data.id;
  div.innerHTML=`<span class="msg-user">${data.user}</span>: <span class="msg-text">${data.message}</span>`;
  chatBox.appendChild(div);
}
