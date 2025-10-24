// main.js
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // DOM
  const loginBtn = document.getElementById('loginBtn');
  const registerBtn = document.getElementById('registerBtn');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const registerUsername = document.getElementById('registerUsername');
  const registerPassword = document.getElementById('registerPassword');

  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const chatBox = document.getElementById('chatBox');
  const userList = document.getElementById('userList');
  const whisperLogs = document.getElementById('whisperLogs');
  const typingIndicator = document.getElementById('typingIndicator');
  const statusBtn = document.getElementById('statusBtn');
  const statusInput = document.getElementById('statusInput');
  const darkToggle = document.getElementById('darkToggle');
  const adminBtn = document.getElementById('adminBtn');

  // state
  let myUsername = sessionStorage.getItem('username') || null;
  let myPassword = sessionStorage.getItem('password') || null;
  let isAdmin = sessionStorage.getItem('isAdmin') === 'true';
  let lastWhisperFrom = null;
  let lastMessageTime = 0;
  let typingTimeout = null;
  let typingUsers = {};

  // sounds
  const sounds = {
    join: new Audio('/sounds/join.mp3'),
    whisper: new Audio('/sounds/whisper.mp3'),
    mention: new Audio('/sounds/mention.mp3')
  };
  function playSound(name){ try { sounds[name]?.play()?.catch(()=>{}); } catch(e){} }

  // ensureConnected helper
  function ensureConnected(cb){
    if (socket.connected) return cb();
    socket.once('connect', cb);
  }

  // AUTH UI
  if (loginBtn && registerBtn) {
    loginBtn.addEventListener('click', () => {
      const username = loginUsername.value?.trim();
      const password = loginPassword.value || '';
      if (!username || !password) return alert('Enter username & password');
      ensureConnected(() => {
        socket.emit('login', { username, password }, (res) => {
          if (res && res.ok) {
            sessionStorage.setItem('username', username);
            sessionStorage.setItem('password', password);
            sessionStorage.setItem('isAdmin', res.isAdmin ? 'true' : 'false');
            isAdmin = !!res.isAdmin;
            // load messages if provided
            if (res.messages && Array.isArray(res.messages) && chatBox) {
              chatBox.innerHTML = '';
              res.messages.forEach(renderMessage);
              chatBox.scrollTop = chatBox.scrollHeight;
            }
            window.location.href = 'chat.html';
          } else {
            alert((res && res.error) || 'Login failed');
          }
        });
      });
    });

    registerBtn.addEventListener('click', () => {
      const username = registerUsername.value?.trim();
      const password = registerPassword.value || '';
      if (!username || !password) return alert('Enter username & password');
      ensureConnected(() => {
        socket.emit('register', { username, password }, (res) => {
          if (res && res.ok) {
            alert('Registered! Log in now.');
          } else {
            alert((res && res.error) || 'Register failed');
          }
        });
      });
    });
  }

  // CHAT PAGE INIT
  if (chatForm) {
    myUsername = sessionStorage.getItem('username');
    myPassword = sessionStorage.getItem('password');

    if (!myUsername || !myPassword) {
      if (!sessionStorage.getItem('redirected')) {
        sessionStorage.setItem('redirected', 'true');
        window.location.href = 'index.html';
      }
      return;
    } else {
      sessionStorage.removeItem('redirected');
      ensureConnected(() => {
        socket.emit('login', { username: myUsername, password: myPassword }, (res) => {
          if (!res || !res.ok) {
            alert((res && res.error) || 'Login failed');
            sessionStorage.removeItem('username');
            sessionStorage.removeItem('password');
            sessionStorage.removeItem('isAdmin');
            window.location.href = 'index.html';
            return;
          }
          isAdmin = !!res.isAdmin;
          if (res.messages && Array.isArray(res.messages)) {
            chatBox.innerHTML = '';
            res.messages.forEach(renderMessage);
            chatBox.scrollTop = chatBox.scrollHeight;
          }
        });
      });
    }

    // typing
    chatInput?.addEventListener('input', () => {
      socket.emit('typing', true);
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(()=>socket.emit('typing', false), 1200);
    });

    // Enter sends, Shift+Enter newline
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });

    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = chatInput.value || '';
      const msg = raw.trim();
      if (!msg) return;
      const now = Date.now();
      if (now - lastMessageTime < 2000) { alert('Slow down! (2s cooldown)'); return; }
      lastMessageTime = now;

      // commands
      if (msg.startsWith('/status ')) {
        socket.emit('setStatus', msg.slice(8).trim());
      } else if (msg.startsWith('/whisper ')) {
        const parts = msg.split(' ');
        const target = parts[1];
        const message = parts.slice(2).join(' ');
        if (!target || !message) return alert('Usage: /whisper [username] [message]');
        socket.emit('whisper', { target, message });
      } else if (msg.startsWith('/reply ')) {
        if (!lastWhisperFrom) return alert('No one whispered you yet!');
        socket.emit('whisper', { target: lastWhisperFrom, message: msg.slice(7) });
      } else if (msg.startsWith('/')) {
        const parts = msg.slice(1).split(' ');
        const cmd = parts[0];
        const target = parts[1];
        const arg = parts.slice(2).join(' ');
        socket.emit('adminCommand', { cmd, target, arg });
      } else {
        socket.emit('chat', msg);
      }
      chatInput.value = '';
    });

    // user list click
    userList?.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      const uname = li.dataset.username;
      socket.emit('getProfile', { username: uname });
    });

    // admin quick open
    adminBtn?.addEventListener('click', () => {
      if (!isAdmin) return alert('Admins only');
      window.location.href = '/admin';
    });

    // status set
    statusBtn?.addEventListener('click', () => {
      const s = statusInput?.value?.trim();
      if (s) { socket.emit('setStatus', s); if (statusInput) statusInput.value = ''; }
    });
  } // chatForm

  // GLOBAL SOCKET HANDLERS
  socket.on('messages', (arr) => {
    if (!chatBox) return;
    chatBox.innerHTML = '';
    arr.forEach(renderMessage);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on('chat', (data) => {
    renderMessage(data);
    chatBox.scrollTop = chatBox.scrollHeight;
    if (myUsername && data.message.includes(`@${myUsername}`)) playSound('mention');
  });

  socket.on('editMessage', (msg) => {
    const el = document.querySelector(`[data-id="${msg.id}"]`);
    if (el) {
      const body = el.querySelector('.msg-text');
      if (body) body.innerHTML = formatText(msg.message) + (msg.edited ? ' <span class="edited">(edited)</span>' : '');
    }
  });

  socket.on('deleteMessage', ({ id }) => {
    const el = document.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  });

  socket.on('whisper', ({ from, message }) => {
    lastWhisperFrom = from;
    if (!chatBox) return;
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    p.innerHTML = `<span class="time">[${time}]</span> <b class="whisper">${escapeHtml(from)} → You</b>: <span class="whisper-text">${escapeHtml(message)}</span>`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
    playSound('whisper');
  });

  socket.on('system', (msg) => {
    if (!chatBox) return;
    const p = document.createElement('p');
    p.className = 'system';
    p.textContent = `[SYSTEM] ${msg}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on('kicked', (reason) => { alert(reason || 'You were kicked'); window.location.href='index.html'; });
  socket.on('banned', (reason) => { alert(reason || 'You were banned'); window.location.href='index.html'; });

  socket.on('typing', ({ user, isTyping }) => {
    if (!typingIndicator) return;
    if (isTyping) typingUsers[user] = Date.now(); else delete typingUsers[user];
    updateTypingText();
  });

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

  socket.on('updateWhispers', (all) => {
    if (!whisperLogs) return;
    whisperLogs.innerHTML = '';
    all.forEach(w => {
      const time = new Date(w.time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const p = document.createElement('p');
      p.innerHTML = `<span class="time">[${time}]</span> <b>${escapeHtml(w.from)}</b> → <b>${escapeHtml(w.to)}</b>: <span>${escapeHtml(w.message)}</span>`;
      whisperLogs.appendChild(p);
    });
  });

  socket.on('mutedStatus', ({ mutedUntil }) => {
    if (!chatBox) return;
    const p = document.createElement('p');
    p.className = 'system';
    p.textContent = `You are muted until ${new Date(mutedUntil).toLocaleString()}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on('playSound', playSound);

  // UI helper functions (renderMessage, openEditDialog, formatText, avatarFor, escapeHtml...) --
  // keep same behavior: user can edit/delete own messages; admins can edit/delete any message.
  function renderMessage(data){
    if (!chatBox) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'message';
    wrapper.dataset.id = data.id;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = new Date(data.time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    meta.innerHTML = `<span class="time">[${time}]</span> <span class="avatar small">${avatarFor(data.user)}</span> <b class="user ${data.user === 'DEV' ? 'adminColor' : ''}">${escapeHtml(data.user)}</b> ${data.edited ? '<span class="edited">(edited)</span>' : ''}`;

    const body = document.createElement('div');
    body.className = 'msg-text';
    body.innerHTML = formatText(data.message) + (data.edited ? ' <span class="edited">(edited)</span>' : '');

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
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

  function openEditDialog(id){
    const el = document.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    const body = el.querySelector('.msg-text');
    const old = body ? body.textContent : '';
    const newText = prompt('Edit message:', old);
    if (newText === null) return;
    socket.emit('editMessage', { id, newText });
  }

  function formatText(str){
    let s = escapeHtml(str || '');
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/_(.+?)_/g, '<i>$1</i>');
    s = s.replace(/~(.+?)~/g, '<s>$1</s>');
    s = s.replace(/\n/g, '<br/>');
    return s;
  }

  function avatarFor(name){ return name ? `<span class="avatar-circle">${escapeHtml(name[0].toUpperCase())}</span>` : '?'; }
  function escapeHtml(str){ if (!str) return ''; return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function updateTypingText(){
    const names = Object.keys(typingUsers).slice(0,3);
    if (!typingIndicator) return;
    typingIndicator.textContent = names.length ? `${names.join(', ')} is typing...` : '';
  }

  // dark mode
  if (darkToggle) {
    const saved = localStorage.getItem('dark') === 'true';
    document.documentElement.classList.toggle('dark', saved);
    darkToggle.checked = saved;
    darkToggle.addEventListener('change', (e) => {
      document.documentElement.classList.toggle('dark', e.target.checked);
      localStorage.setItem('dark', e.target.checked);
    });
  }

}); // DOMContentLoaded end
