// main.js
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
let isAdmin = false;
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;
let typingUsers = {}; // user -> timeout

// sound map
const sounds = {
  join: new Audio('/sounds/join.mp3'),
  whisper: new Audio('/sounds/whisper.mp3'),
  mention: new Audio('/sounds/mention.mp3')
};

// safe play wrapper
function playSound(name) {
  try {
    if (sounds[name]) sounds[name].play().catch(()=>{});
  } catch (e) {}
}

// === AUTH (index.html) ===
if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if (!username || !password) return alert("Enter username & password");
    sessionStorage.setItem("username", username);
    sessionStorage.setItem("password", password);
    myUsername = username;
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
    window.location.href = "chat.html";
  });
  socket.on("loginError", (msg) => alert(msg));
  socket.on("registerSuccess", () => alert("Registered!"));
  socket.on("registerError", (msg) => alert(msg));
}

// === CHAT (chat.html) ===
if (chatForm) {
  myUsername = sessionStorage.getItem("username");
  const password = sessionStorage.getItem("password");

  if (!myUsername || !password) {
    if (!sessionStorage.getItem("redirected")) {
      sessionStorage.setItem("redirected", "true");
      window.location.href = "index.html";
    }
  } else {
    sessionStorage.removeItem("redirected");
    socket.emit("login", { username: myUsername, password });
  }

  // typing handlers
  function notifyTyping(on) {
    socket.emit("typing", on);
  }

  chatInput.addEventListener("input", () => {
    // send typing true and schedule false
    notifyTyping(true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => notifyTyping(false), 1200);
  });

  // message submit logic (cooldown + commands)
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = chatInput.value;
    const msg = raw.trim();
    if (!msg) return;

    const now = Date.now();
    if (now - lastMessageTime < 2000) {
      alert("Slow down! (2s cooldown)");
      return;
    }
    lastMessageTime = now;

    // status command
    if (msg.startsWith("/status ")) {
      const status = msg.slice(8).trim();
      socket.emit("setStatus", status);
      chatInput.value = "";
      return;
    }

    // whisper
    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if (!target || !message) return alert("Usage: /whisper [username] [message]");
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

  // Click username -> profile fetch
  userList?.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const uname = li.dataset.username;
    socket.emit('getProfile', { username: uname });
  });

  // admin panel quick open
  if (adminBtn) {
    adminBtn.addEventListener('click', () => {
      if (!isAdmin) return alert('Admins only');
      window.location.href = '/admin';
    });
  }

  // status update button
  if (statusBtn && statusInput) {
    statusBtn.addEventListener('click', () => {
      const s = statusInput.value.trim();
      socket.emit('setStatus', s);
      statusInput.value = '';
    });
  }
}

// === GLOBAL SOCKET HANDLERS ===

// initial messages history
socket.on('messages', (arr) => {
  if (!chatBox) return;
  chatBox.innerHTML = '';
  arr.forEach(renderMessage);
  chatBox.scrollTop = chatBox.scrollHeight;
});

// single chat message event
socket.on('chat', (data) => {
  renderMessage(data);
  chatBox.scrollTop = chatBox.scrollHeight;

  // mention detection
  if (myUsername && data.message.includes(`@${myUsername}`)) {
    playSound('mention');
  }
});

// message edited
socket.on('editMessage', (msg) => {
  const el = document.querySelector(`[data-id="${msg.id}"]`);
  if (el) {
    const body = el.querySelector('.msg-text');
    if (body) body.innerHTML = formatText(msg.message) + (msg.edited ? ' <span class="edited">(edited)</span>' : '');
  }
});

// message deleted
socket.on('deleteMessage', ({ id }) => {
  const el = document.querySelector(`[data-id="${id}"]`);
  if (el) {
    el.remove();
  }
});

// whispers
socket.on('whisper', ({ from, message }) => {
  lastWhisperFrom = from;
  const p = document.createElement('p');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  p.innerHTML = `<span class="time">[${time}]</span> <b class="whisper">${escapeHtml(from)} → You</b>: <span class="whisper-text">${escapeHtml(message)}</span>`;
  chatBox?.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
  playSound('whisper');
});

// system messages
socket.on('system', (msg) => {
  const p = document.createElement('p');
  p.className = 'system';
  p.textContent = `[SYSTEM] ${msg}`;
  chatBox?.appendChild(p);
  chatBox?.scrollTop = chatBox.scrollHeight;
});

// kicks/bans
socket.on('kicked', (reason) => {
  alert(reason || 'You were kicked!');
  try { window.close(); } catch(e){}
});
socket.on('banned', (reason) => {
  alert(reason || 'You were banned!');
  try { window.close(); } catch(e){}
});

// typing indicator
socket.on('typing', ({ user, isTyping }) => {
  if (!typingIndicator) return;
  if (isTyping) {
    typingUsers[user] = Date.now();
  } else {
    delete typingUsers[user];
  }
  updateTypingText();
});

function updateTypingText() {
  const names = Object.keys(typingUsers).slice(0,3);
  if (names.length === 0) {
    typingIndicator.textContent = '';
    return;
  }
  typingIndicator.textContent = `${names.join(', ')} is typing...`;
}

// admin data (on admin page)
socket.on('adminData', ({ online, banned, muted, logs }) => {
  // admin page will render this; emit only on admin page
  // admin page code handles this event
});

// update user list
socket.on('updateUsers', (list) => {
  if (!userList) return;
  userList.innerHTML = '';
  list.forEach(u => {
    const li = document.createElement('li');
    li.dataset.username = u.username;
    li.innerHTML = `<span class="avatar">${avatarFor(u.username)}</span><b>${escapeHtml(u.username)}</b> <span class="status">${escapeHtml(u.status || '')}</span> ${u.isAdmin ? '<span class="adminBadge">ADMIN</span>' : ''} ${u.mutedUntil ? '<span class="mutedBadge">MUTED</span>' : ''}`;
    userList.appendChild(li);
  });
});

// update whispers list
socket.on('updateWhispers', (all) => {
  if (!whisperLogs) return;
  whisperLogs.innerHTML = '';
  all.forEach(w => {
    const time = new Date(w.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const p = document.createElement('p');
    p.innerHTML = `<span class="time">[${time}]</span> <b>${escapeHtml(w.from)}</b> → <b>${escapeHtml(w.to)}</b>: <span>${escapeHtml(w.message)}</span>`;
    whisperLogs.appendChild(p);
  });
});

// muted status (client notified of own mute)
socket.on('mutedStatus', ({ mutedUntil }) => {
  if (!chatBox) return;
  const p = document.createElement('p');
  p.className = 'system';
  p.textContent = `You are muted until ${new Date(mutedUntil).toLocaleString()}`;
  chatBox.appendChild(p);
  chatBox.scrollTop = chatBox.scrollHeight;
  // show countdown UI if desired (left to page)
});

// play sound
socket.on('playSound', (name) => playSound(name));

// ---------------- UI helpers ----------------

function renderMessage(data) {
  if (!chatBox) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'message';
  wrapper.dataset.id = data.id;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.innerHTML = `<span class="time">[${time}]</span> <span class="avatar small">${avatarFor(data.user)}</span> <b class="user ${data.user === 'DEV' ? 'adminColor' : ''}">${escapeHtml(data.user)}</b> ${data.edited ? '<span class="edited">(edited)</span>' : ''}`;

  const body = document.createElement('div');
  body.className = 'msg-text';
  body.innerHTML = formatText(data.message) + (data.edited ? ' <span class="edited">(edited)</span>' : '');

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  // show edit/delete if owner or admin
  const currentUser = sessionStorage.getItem('username');
  const amAdmin = isAdmin || (sessionStorage.getItem('isAdmin') === 'true');
  if (data.user === currentUser || amAdmin) {
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.className = 'tiny';
    editBtn.addEventListener('click', () => openEditDialog(data.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'tiny danger';
    delBtn.addEventListener('click', () => {
      if (!confirm('Delete this message?')) return;
      socket.emit('deleteMessage', { id: data.id });
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
  if (newText === null) return;
  socket.emit('editMessage', { id, newText });
}

function formatText(str) {
  // basic formatting: **bold**, _italic_, ~strike~
  let s = escapeHtml(str);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/_(.+?)_/g, '<i>$1</i>');
  s = s.replace(/~(.+?)~/g, '<s>$1</s>');
  // preserve newlines (if any were later supported)
  s = s.replace(/\n/g, '<br/>');
  return s;
}

function avatarFor(name) {
  if (!name) return '?';
  const initial = escapeHtml(name[0].toUpperCase());
  return `<span class="avatar-circle">${initial}</span>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// dark mode toggle
if (darkToggle) {
  const saved = localStorage.getItem('dark') === 'true';
  document.documentElement.classList.toggle('dark', saved);
  darkToggle.checked = saved;
  darkToggle.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('dark', e.target.checked);
    localStorage.setItem('dark', e.target.checked);
  });
}
