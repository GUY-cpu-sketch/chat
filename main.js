
/* client logic: register/login/forgot-password, chat, admin features, avatars, timestamps */
function $(id){ return document.getElementById(id); }

// check banned cookie on every page
(function(){
  try{
    const cookies = document.cookie.split(';').map(s=>s.trim());
    for (const c of cookies){
      if (c.startsWith('banned=')) {
        const val = c.split('=')[1];
        if (val === 'true') {
          document.body.innerHTML = '<div style="padding:20px;font-family:sans-serif;color:#fff;background:#222;height:100vh;">You are banned.</div>';
          try{ window.close(); }catch(e){}
        }
      }
    }
  }catch(e){}
})();

// --- Index: register/login + forgot ---
const loginForm = $('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    const action = $('loginAction').value;
    if (!username || !password) return alert('fill both');
    if (action === 'register') {
      const res = await fetch('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      const d = await res.json();
      if (d.success) { alert('registered! you can log in now'); $('loginAction').value='login'; $('loginToggle').textContent='Switch to Register'; }
      else if (d.error==='exists') alert('username taken');
      else alert('error');
      return;
    } else {
      const res = await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      const d = await res.json();
      if (d.success) {
        sessionStorage.setItem('username', username);
        if (username === 'DEV') window.location.href = '/admin.html';
        else window.location.href = '/chat.html';
      } else if (d.error === 'banned') {
        document.cookie = 'banned=true; path=/; max-age=31536000';
        alert('You are banned.');
        try{ window.close(); }catch(e){}
      } else {
        alert('wrong creds');
      }
    }
  });

  // toggle register/login
  const toggle = $('loginToggle');
  toggle.addEventListener('click', ()=>{
    const sel = $('loginAction');
    if (sel.value === 'login') {
      sel.value = 'register';
      toggle.textContent = 'Switch to Register';
      $('loginSubmit').textContent = 'Register';
    } else {
      sel.value = 'login';
      toggle.textContent = 'Switch to Register';
      $('loginSubmit').textContent = 'Login';
    }
  });

  // forgot password button
  const forgotBtn = document.createElement('button');
  forgotBtn.type = 'button';
  forgotBtn.textContent = 'Forgot password?';
  forgotBtn.style.marginLeft = '8px';
  forgotBtn.addEventListener('click', async ()=>{
    const username = prompt('Enter your username to request a reset token:');
    if (!username) return;
    const res = await fetch('/forgot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})});
    const d = await res.json();
    if (d.success) {
      alert('Reset token (valid 15 minutes): ' + d.token + '\nUse it on the next screen to set a new password.');
      // prompt to reset now
      const token = prompt('Enter the reset token you received:' , d.token);
      if (!token) return;
      const newPass = prompt('Enter your new password:');
      if (!newPass) return;
      const r2 = await fetch('/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username, token, newPassword: newPass})});
      const d2 = await r2.json();
      if (d2.success) alert('Password reset! You can now log in.');
      else alert('Reset failed: ' + (d2.error||'unknown'));
    } else if (d.error === 'notfound') alert('username not found');
    else alert('error requesting reset');
  });
  // add button to form
  loginForm.appendChild(forgotBtn);
}

// --- Chat page ---
const chatForm = $('chatForm');
if (chatForm) {
  const socket = io();
  const username = sessionStorage.getItem('username') || prompt('Enter username');
  socket.emit('register-socket', { username });
  const chatBox = $('chatBox');
  const onlineBox = $('onlineBox');

  function avatarFor(name) {
    // deterministic color from username
    let hash = 0;
    for (let i=0;i<name.length;i++) hash = name.charCodeAt(i) + ((hash<<5)-hash);
    const hue = Math.abs(hash) % 360;
    const initials = name.split(' ').map(s=>s[0]).join('').substring(0,2).toUpperCase();
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36'><rect width='100%' height='100%' rx='8' fill='hsl(${hue} 60% 50%)'/><text x='50%' y='54%' font-size='16' text-anchor='middle' fill='white' font-family='Arial' font-weight='700'>${initials}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function addMsg(m){
    const p = document.createElement('div');
    p.className='message';
    const timeStr = new Date(m.time).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    p.innerHTML = `<img src="${'${'}avatarFor(m.username)}" class="avatar" /><div class="bubble"><span class="meta">${m.username} <small>${timeStr}</small></span><div class="text">${escapeHTML(m.message)}</div></div>`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
  fetch('/messages').then(r=>r.json()).then(arr=>arr.forEach(addMsg));
  socket.on('chat', addMsg);
  socket.on('system', (s)=>{
    const el = { username: 'System', time: new Date().toISOString(), message: s.message };
    addMsg(el);
  });
  socket.on('online-users', (list)=>{
    onlineBox.innerHTML = list.map(u=>`<div>${u}</div>`).join('');
  });
  socket.on('muted', () => alert('You are currently muted.'));
  socket.on('muted-by-admin', ({secs}) => alert('Muted by admin for '+secs+'s'));
  socket.on('spam', ({wait}) => alert('Slow down — wait '+Math.ceil(wait/1000)+'s'));
  socket.on('force-close', ({reason}) => {
    document.body.innerHTML = '<div style="padding:20px;font-family:sans-serif;color:#fff;background:#222;height:100vh;">You were removed: '+(reason||'')+'</div>';
    try{ window.close(); }catch(e){ window.location.href='about:blank'; }
  });
  socket.on('apply-ban', ()=>{
    document.cookie = 'banned=true; path=/; max-age=31536000';
    try{ window.close(); }catch(e){ window.location.href='about:blank'; }
  });

  let lastSend = 0;
  chatForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const input = $('chatInput');
    const message = input.value.trim();
    if (!message) return;
    // client-side cooldown
    const now = Date.now();
    if (now - lastSend < 2000) { alert('Slow down bro — 2s cooldown'); return; }
    lastSend = now;

    if (username === 'DEV' && message.startsWith('/')) {
      socket.emit('admin-command', { command: message, from: username });
      input.value = '';
      return;
    }
    socket.emit('chat-message', { username, message });
    input.value = '';
  });
}

// --- Admin page logic ---
const adminPanel = $('adminPanel');
if (adminPanel) {
  const socket = io();
  const username = sessionStorage.getItem('username') || 'DEV';
  socket.emit('register-socket', { username });
  socket.on('online-users', (list)=>{
    $('adminOnline').innerHTML = list.map(u=>`<div>${u}</div>`).join('');
  });
  $('adminSend').addEventListener('click', ()=>{
    const cmd = $('adminCmd').value.trim();
    if (!cmd) return;
    socket.emit('admin-command', { command: cmd, from: username });
    $('adminCmd').value = '';
  });
}

// helper
function escapeHTML(s){ return (s+'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
