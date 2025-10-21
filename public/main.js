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
const typingIndicator = document.getElementById("typingIndicator");
const statusBtn = document.getElementById("statusBtn");
const statusInput = document.getElementById("statusInput");
const darkToggle = document.getElementById("darkToggle");
const adminBtn = document.getElementById("adminBtn");

let myUsername = sessionStorage.getItem("username") || null;
let myPassword = sessionStorage.getItem("password") || null;
let isAdmin = sessionStorage.getItem("isAdmin") === "true";
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;
let typingUsers = {};

const sounds = {
  join: new Audio('/sounds/join.mp3'),
  whisper: new Audio('/sounds/whisper.mp3'),
  mention: new Audio('/sounds/mention.mp3')
};

function playSound(name) {
  try { sounds[name]?.play()?.catch(()=>{}); } catch(e){}
}

// ================= LOGIN & REGISTER =================
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    myUsername = username;
    myPassword = password;
    socket.emit("login", { username, password });
  });

  registerBtn.addEventListener("click", () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    socket.emit("register", { username, password });
  });

  socket.on("loginSuccess", ({ isAdmin: adminFlag }) => {
    isAdmin = !!adminFlag;
    sessionStorage.setItem("isAdmin", isAdmin);
    window.location.href = "chat.html";
  });

  socket.on("loginError", (msg) => alert(msg));
  socket.on("registerSuccess", () => alert("Registered!"));
  socket.on("registerError", (msg) => alert(msg));
}

// ================= CHAT =================
if (chatForm) {
  myUsername = sessionStorage.getItem("username");
  myPassword = sessionStorage.getItem("password");
  if (!myUsername || !myPassword) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected", "true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username: myUsername, password: myPassword });
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    const now = Date.now();
    if (now - lastMessageTime < 2000) return alert("Slow down! (2s cooldown)");
    lastMessageTime = now;

    // commands
    if (msg.startsWith("/status ")) {
      socket.emit("setStatus", msg.slice(8).trim());
      chatInput.value = "";
      return;
    }
    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if (!target || !message) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { target, message });
      chatInput.value = "";
      return;
    }
    if (msg.startsWith("/reply ")) {
      if (!lastWhisperFrom) return alert("No whispers yet!");
      socket.emit("whisper", { target: lastWhisperFrom, message: msg.slice(7) });
      chatInput.value = "";
      return;
    }
    if (msg.startsWith("/")) {
      const parts = msg.slice(1).split(" ");
      socket.emit("adminCommand", { cmd: parts[0], target: parts[1], arg: parts.slice(2).join(" ") });
      chatInput.value = "";
      return;
    }

    socket.emit("chat", msg);
    chatInput.value = "";
  });
}

// ================= MESSAGE RENDERING =================
socket.on('messages', arr => {
  if (!chatBox) return;
  chatBox.innerHTML = '';
  arr.forEach(renderMessage);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on('chat', renderMessage);

socket.on('editMessage', msg => {
  const el = document.querySelector(`[data-id="${msg.id}"]`);
  if (!el) return;
  const body = el.querySelector('.msg-text');
  if (body) body.innerHTML = formatText(msg.message) + (msg.edited ? ' <span class="edited">(edited)</span>' : '');
});

socket.on('deleteMessage', ({ id }) => {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (el) el.remove();
});

socket.on('whisper', ({ from, message }) => {
  lastWhisperFrom = from;
  const p = document.createElement('p');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  p.innerHTML = `<span class="time">[${time}]</span> <b class="whisper">${escapeHtml(from)} → You</b>: <span class="whisper-text">${escapeHtml(message)}</span>`;
  chatBox?.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
  playSound('whisper');
});

socket.on('system', msg => {
  const p = document.createElement('p');
  p.className = 'system';
  p.textContent = `[SYSTEM] ${msg}`;
  chatBox?.appendChild(p);
  chatBox?.scrollTop = chatBox.scrollHeight;
});

// ================= KICK / BAN =================
socket.on('kicked', reason => {
  alert(reason || 'You were kicked!');
  try { window.close(); } catch(e){}
});
socket.on('banned', reason => {
  alert(reason || 'You were banned!');
  try { window.close(); } catch(e){}
});

// ================= TYPING =================
chatInput?.addEventListener('input', () => {
  socket.emit('typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', false), 1200);
});

socket.on('typing', ({ user, isTyping }) => {
  if (!typingIndicator) return;
  if (isTyping) typingUsers[user] = Date.now();
  else delete typingUsers[user];
  updateTypingText();
});

function updateTypingText() {
  const names = Object.keys(typingUsers).slice(0,3);
  typingIndicator.textContent = names.length ? `${names.join(', ')} is typing...` : '';
}

// ================= USER LIST / STATUS =================
socket.on('updateUsers', list => {
  if (!userList) return;
  userList.innerHTML = '';
  list.forEach(u => {
    const li = document.createElement('li');
    li.dataset.username = u.username;
    li.innerHTML = `<span class="avatar">${avatarFor(u.username)}</span><b>${escapeHtml(u.username)}</b> <span class="status">${escapeHtml(u.status || '')}</span> ${u.isAdmin ? '<span class="adminBadge">ADMIN</span>' : ''} ${u.mutedUntil ? '<span class="mutedBadge">MUTED</span>' : ''}`;
    userList.appendChild(li);
  });
});

// ================= WHISPER LOG =================
socket.on('updateWhispers', all => {
  if (!whisperLogs) return;
  whisperLogs.innerHTML = '';
  all.forEach(w => {
    const time = new Date(w.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const p = document.createElement('p');
    p.innerHTML = `<span class="time">[${time}]</span> <b>${escapeHtml(w.from)}</b> → <b>${escapeHtml(w.to)}</b>: <span>${escapeHtml(w.message)}</span>`;
    whisperLogs.appendChild(p);
  });
});

// ================= MUTED STATUS =================
socket.on('mutedStatus', ({ mutedUntil }) => {
  if (!chatBox) return;
  const p = document.createElement('p');
  p.className = 'system';
  p.textContent = `You are muted until ${new Date(mutedUntil).toLocaleString()}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
});

// ================= SOUNDS =================
socket.on('playSound', playSound);

// ================= ADMIN PANEL =================
adminBtn?.addEventListener('click', () => {
  if (!isAdmin) return alert('Admins only');
  window.location.href = '/admin';
});

// ================= STATUS =================
statusBtn?.addEventListener('click', () => {
  const s = statusInput.value.trim();
  socket.emit('setStatus', s);
  statusInput.value = '';
});

// ================= DARK MODE =================
if (darkToggle) {
  const saved = localStorage.getItem('dark') === 'true';
  document.documentElement.classList.toggle('dark', saved);
  darkToggle.checked = saved;
  darkToggle.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('dark', e.target.checked);
    localStorage.setItem('dark', e.target.checked);
  });
}

// ================= HELPERS =================
function renderMessage(data) {
  if (!chatBox) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'message';
  wrapper.dataset.id = data.id;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(data.time).toLocaleTimeString([], { hour:'2-digit',minute:'2-digit' });
  meta.innerHTML = `<span class="time">[${time}]</span> <span class="avatar small">${avatarFor(data.user)}</span> <b class="user ${data.user==='DEV'?'adminColor':''}">${escapeHtml(data.user)}</b> ${data.edited?'<span class="edited">(edited)</span>':''}`;

  const body = document.createElement('div');
  body.className = 'msg-text';
  body.innerHTML = formatText(data.message);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const currentUser = sessionStorage.getItem('username');
  const amAdmin = isAdmin || (sessionStorage.getItem('isAdmin')==='true');
  if (data.user===currentUser || amAdmin) {
    const editBtn = document.createElement('button');
    editBtn.textContent='Edit';
    editBtn.className='tiny';
    editBtn.addEventListener('click', ()=>openEditDialog(data.id));
    const delBtn = document.createElement('button');
    delBtn.textContent='Delete';
    delBtn.className='tiny danger';
    delBtn.addEventListener('click', ()=>{
      if (!confirm('Delete this message?')) return;
      socket.emit('deleteMessage',{id:data.id});
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
  }

  wrapper.appendChild(meta);
  wrapper.appendChild(body);
  wrapper.appendChild(actions);
  chatBox.appendChild(wrapper);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function openEditDialog(id) {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  const body = el.querySelector('.msg-text');
  const old = body ? body.textContent : '';
  const newText = prompt('Edit message:', old);
  if (newText===null) return;
  socket.emit('editMessage',{id,newText});
}

function formatText(str) {
  let s = escapeHtml(str);
  s = s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
       .replace(/_(.+?)_/g,'<i>$1</i>')
       .replace(/~(.+?)~/g,'<s>$1</s>')
       .replace(/\n/g,'<br/>');
  return s;
}

function avatarFor(name) {
  if (!name) return '?';
  return `<span class="avatar-circle">${escapeHtml(name[0].toUpperCase())}</span>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
