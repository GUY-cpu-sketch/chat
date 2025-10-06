// main.js
const socket = io();

// ===== ELEMENTS =====
const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const registerUsername = document.getElementById('registerUsername');
const registerPassword = document.getElementById('registerPassword');

const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatBox = document.getElementById('chatBox');
const onlineUsersDiv = document.getElementById('onlineUsers');

let lastMessageTime = 0;

// ===== LOGIN & REGISTER =====
if(loginBtn){
    loginBtn.addEventListener('click', () => {
        const username = loginUsername.value.trim();
        const password = loginPassword.value.trim();
        if(!username || !password) return alert('Enter username and password');
        socket.emit('login', { username, password });
    });

    registerBtn.addEventListener('click', () => {
        const username = registerUsername.value.trim();
        const password = registerPassword.value.trim();
        if(!username || !password) return alert('Enter username and password');
        socket.emit('register', { username, password });
    });
}

// ===== SOCKET RESPONSES =====
socket.on('loginSuccess', () => {
    const username = loginUsername.value.trim();
    sessionStorage.setItem('username', username); // persist username
    window.location.href = 'chat.html';
});

socket.on('loginFail', () => alert('Login failed!'));
socket.on('registerSuccess', () => alert('Registered successfully! Please login.'));
socket.on('registerFail', () => alert('Username already exists!'));

// ===== CHAT PAGE SETUP =====
const username = sessionStorage.getItem('username');

if(chatForm){
    if(!username){
        alert('You must login first!');
        window.location.href = 'index.html';
    } else {
        // Inform server of this socket's username
        socket.username = username;
        socket.emit('login', { username, password: '' }); // password ignored here
    }

    // Send chat messages
    chatForm.addEventListener('submit', e => {
        e.preventDefault();
        const now = Date.now();
        if(now - lastMessageTime < 2000) return; // 2s cooldown
        lastMessageTime = now;
        const msg = chatInput.value.trim();
        if(msg && username){
            socket.emit('chat', msg);
            chatInput.value = '';
        }
    });

    // Handle admin commands
    chatForm.addEventListener('keydown', e => {
        if(e.key === 'Enter'){
            const msg = chatInput.value.trim();
            if(msg.startsWith('/')){
                socket.emit('adminCommand', msg);
                chatInput.value = '';
                e.preventDefault();
            }
        }
    });
}

// ===== RECEIVE CHAT MESSAGES =====
socket.on('chat', data => {
    if(!chatBox) return;
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    p.textContent = `[${time}] ${data.user}: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
});

// ===== ONLINE USERS =====
socket.on('updateUsers', users => {
    if(!onlineUsersDiv) return;
    onlineUsersDiv.innerHTML = '<b>Online:</b> ' + users.join(', ');
});

// ===== SYSTEM MESSAGES =====
socket.on('system', msg => {
    if(!chatBox) return;
    const p = document.createElement('p');
    p.style.fontStyle = 'italic';
    p.textContent = msg;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
});
