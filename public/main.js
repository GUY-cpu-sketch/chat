const socket = io({ autoConnect: false });

const $ = (id) => document.getElementById(id);
const loginBtn = $('loginBtn');
const registerBtn = $('registerBtn');
const loginUsername = $('loginUsername');
const loginPassword = $('loginPassword');
const registerUsername = $('registerUsername');
const registerPassword = $('registerPassword');
const chatForm = $('chatForm');
const chatInput = $('chatInput');
const chatBox = $('chatBox');
const userList = $('userList');
const typingIndicator = $('typingIndicator');
const statusBtn = $('statusBtn');
const statusInput = $('statusInput');
const darkToggle = $('darkToggle');
const adminBtn = $('adminBtn');
const avatarInput = $('avatarInput');
const colorInput = $('colorInput');
const setProfileBtn = $('setProfileBtn');

let myUsername = sessionStorage.getItem('username') || null;
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;
let authenticated = false;

function showError(message) {
  if (typeof message === 'string' && message) alert(message);
}
function scrollChat() { if (chatBox) chatBox.scrollTop = chatBox.scrollHeight; }
function saveToken(token, username) {
  if (token) sessionStorage.setItem('chatToken', token);
  if (username) sessionStorage.setItem('username', username);
}
function clearSession() {
  sessionStorage.removeItem('chatToken');
  sessionStorage.removeItem('username');
  myUsername = null;
  authenticated = false;
}

// -------------------- Auth page --------------------
if (loginBtn && registerBtn) {
  const doLogin = () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    if (!username || !password) return showError('Enter a username and password.');
    loginBtn.disabled = true;
    socket.emit('login', { username, password });
  };
  const doRegister = () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value;
    if (!username || !password) return showError('Enter a username and password.');
    registerBtn.disabled = true;
    socket.emit('register', { username, password });
  };

  socket.connect();
  loginBtn.addEventListener('click', doLogin);
  registerBtn.addEventListener('click', doRegister);
  loginPassword.addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  registerPassword.addEventListener('keydown', (e) => e.key === 'Enter' && doRegister());

  socket.on('loginSuccess', ({ token, username }) => {
    saveToken(token, username);
    window.location.href = 'chat.html';
  });
  socket.on('loginError', (msg) => { loginBtn.disabled = false; showError(msg); });
  socket.on('registerSuccess', () => {
    registerBtn.disabled = false;
    alert('Account created! You can log in now.');
    registerPassword.value = '';
  });
  socket.on('registerError', (msg) => { registerBtn.disabled = false; showError(msg); });
}

// -------------------- Chat page --------------------
if (chatForm) {
  const token = sessionStorage.getItem('chatToken');
  myUsername = sessionStorage.getItem('username');
  if (!token || !myUsername) {
    window.location.href = 'index.html';
  } else {
    socket.auth = { token };
    socket.connect();
    socket.on('connect', () => socket.emit('authenticate'));
  }

  chatInput.addEventListener('input', () => {
    if (!authenticated) return;
    socket.emit('typing', true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit('typing', false), 900);
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = chatInput.value.trim();
    if (!raw || !authenticated) return;

    if (raw.startsWith('/status ')) {
      socket.emit('setStatus', raw.slice(8).trim()); chatInput.value = ''; return;
    }
    if (raw.startsWith('/whisper ')) {
      const [, target, ...parts] = raw.split(/\s+/);
      if (!target || !parts.length) return showError('Usage: /whisper username message');
      socket.emit('whisper', { target, message: parts.join(' ') }); chatInput.value = ''; return;
    }
    if (raw.startsWith('/reply ')) {
      if (!lastWhisperFrom) return showError('No whispers yet.');
      socket.emit('whisper', { target: lastWhisperFrom, message: raw.slice(7).trim() }); chatInput.value = ''; return;
    }
    if (raw === '/help') {
      addSystemMessage('Commands: /status text, /whisper username message, /reply message, /help'); chatInput.value = ''; return;
    }
    if (raw.startsWith('/')) return showError('Unknown command. Try /help.');

    const now = Date.now();
    if (now - lastMessageTime < 750) return showError('You are sending messages too quickly.');
    lastMessageTime = now;
    socket.emit('chat', raw);
    chatInput.value = '';
  });

  statusBtn?.addEventListener('click', () => {
    const status = statusInput.value.trim();
    if (status) socket.emit('setStatus', status);
    statusInput.value = '';
  });
  setProfileBtn?.addEventListener('click', () => {
    if (avatarInput) socket.emit('setAvatar', avatarInput.value.trim());
    if (colorInput) socket.emit('setColor', colorInput.value);
  });
  adminBtn?.addEventListener('click', () => { window.location.href = 'admin'; });
}

// -------------------- Socket events --------------------
socket.on('authenticated', ({ username, isAdmin }) => {
  authenticated = true;
  myUsername = username;
  sessionStorage.setItem('username', username);
  if (adminBtn) adminBtn.hidden = !isAdmin;
  if (chatInput) chatInput.focus();
});
socket.on('authRequired', () => { clearSession(); window.location.href = 'index.html'; });
socket.on('messages', (arr) => { if (!chatBox) return; chatBox.replaceChildren(); arr.forEach(renderMessage); scrollChat(); });
socket.on('chat', renderMessage);

socket.on('whisper', ({ from, message }) => {
  lastWhisperFrom = from;
  if (!chatBox) return;
  const row = document.createElement('div');
  row.className = 'chat-msg whisper';
  const label = document.createElement('span'); label.className = 'msg-user'; label.textContent = `${from} → You`;
  const text = document.createElement('span'); text.className = 'msg-text'; text.textContent = message;
  row.append(label, document.createTextNode(': '), text);
  chatBox.appendChild(row); scrollChat();
});

socket.on('updateUsers', (list) => {
  if (!userList) return;
  userList.replaceChildren();
  list.forEach((u) => {
    const li = document.createElement('li'); li.className = 'user-row';
    const avatar = document.createElement('img');
    avatar.className = 'user-avatar'; avatar.alt = ''; avatar.loading = 'lazy';
    avatar.src = u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.username)}&background=random`;
    avatar.onerror = () => avatar.remove();
    const details = document.createElement('div'); details.className = 'user-details';
    const name = document.createElement('strong'); name.textContent = u.username; name.style.color = u.color || '#ffffff';
    const status = document.createElement('small'); status.textContent = u.status || (u.isAdmin ? 'Administrator' : 'Online');
    details.append(name, status); li.append(avatar, details); userList.appendChild(li);
  });
});

socket.on('typing', ({ user, isTyping }) => { if (typingIndicator) typingIndicator.textContent = isTyping ? `${user} is typing…` : ''; });
socket.on('editMessage', (data) => { const el = chatBox?.querySelector(`[data-id="${CSS.escape(data.id)}"] .msg-text`); if (el) el.textContent = `${data.message} (edited)`; });
socket.on('deleteMessage', ({ id }) => { chatBox?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove(); });
socket.on('kicked', (reason) => { clearSession(); alert(`You were kicked.\n${reason || ''}`); window.location.href = 'index.html'; });
socket.on('banned', (reason) => { clearSession(); alert(`You were banned.\n${reason || ''}`); window.location.href = 'index.html'; });
socket.on('errorMessage', showError);
socket.on('adminError', showError);

function addSystemMessage(message) {
  if (!chatBox) return;
  const row = document.createElement('div'); row.className = 'system-message'; row.textContent = message;
  chatBox.appendChild(row); scrollChat();
}

function renderMessage(data) {
  if (!chatBox) return;
  const div = document.createElement('div'); div.className = 'chat-msg'; div.dataset.id = data.id;
  if (data.avatar) {
    const avatar = document.createElement('img'); avatar.src = data.avatar; avatar.className = 'msg-avatar'; avatar.alt = ''; avatar.loading = 'lazy';
    avatar.onerror = () => avatar.remove(); div.appendChild(avatar);
  }
  const content = document.createElement('div'); content.className = 'msg-content';
  const meta = document.createElement('div'); meta.className = 'msg-meta';
  const user = document.createElement('span'); user.className = 'msg-user'; user.textContent = data.user; user.style.color = data.color || '#ffffff';
  const time = document.createElement('time'); time.className = 'msg-time'; time.dateTime = new Date(data.time).toISOString();
  time.textContent = new Date(data.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  meta.append(user, time);
  const text = document.createElement('div'); text.className = 'msg-text'; text.textContent = data.message;
  if (data.edited) text.appendChild(document.createTextNode(' (edited)'));
  content.append(meta, text); div.appendChild(content); chatBox.appendChild(div); scrollChat();
}

const savedTheme = localStorage.getItem('chatTheme') || 'dark';
document.documentElement.classList.toggle('light', savedTheme === 'light');
if (darkToggle) {
  darkToggle.checked = savedTheme === 'light';
  darkToggle.addEventListener('change', (e) => {
    const light = e.target.checked;
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('chatTheme', light ? 'light' : 'dark');
  });
}
