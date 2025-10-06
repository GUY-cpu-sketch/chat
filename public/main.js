// main.js
const socket = io();

// Elements
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

// Login
loginBtn?.addEventListener('click', () => {
    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();
    if(!username || !password) return alert('Enter username and password');
    socket.emit('login', { username, password });
});

// Register
registerBtn?.addEventListener('click', () => {
    const username = registerUsername.value.trim();
    const password = registerPassword.value.trim();
    if(!username || !password) return alert('Enter username and password');
    socket.emit('register', { username, password });
});

// Socket responses
socket.on('loginSuccess', () => {
    alert('Login successful!');
    window.location.href = 'chat.html';
});

socket.on('loginFail', () => {
    alert('Login failed!');
});

socket.on('registerSuccess', () => {
    alert('Registered successfully! Please login.');
});

socket.on('registerFail', () => {
    alert('Username already exists!');
});

// Chat form
chatForm?.addEventListener('submit', e => {
    e.preventDefault();
    const now = Date.now();
    if(now - lastMessageTime < 2000) return; // 2s cooldown
    lastMessageTime = now;
    const msg = chatInput.value.trim();
    if(msg) {
        socket.emit('chat', msg);
        chatInput.value = '';
    }
});

// Receive chat messages
socket.on('chat', data => {
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    p.textContent = `[${time}] ${data.user}: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
});

// Update online users
socket.on('updateUsers', users => {
    if(!onlineUsersDiv) return;
    onlineUsersDiv.innerHTML = '<b>Online:</b> ' + users.join(', ');
});

// Admin commands
chatForm?.addEventListener('keydown', e => {
    if(e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if(msg.startsWith('/')) {
            socket.emit('adminCommand', msg);
            chatInput.value = '';
            e.preventDefault();
        }
    }
});

// System messages
socket.on('system', msg => {
    const p = document.createElement('p');
    p.style.fontStyle = 'italic';
    p.textContent = msg;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
});
