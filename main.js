// main.js - full version with login/register, chat, admin commands, anti-spam, timestamps
const socket = io();

const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatBox = document.getElementById('chatBox');

let lastMessageTime = 0;

// Login/Register handlers
loginBtn?.addEventListener('click', () => {
const username = document.getElementById('loginUsername').value.trim();
const password = document.getElementById('loginPassword').value.trim();
if(!username || !password) { alert('Please enter username and password'); return; }
socket.emit('login', { username, password });
});

registerBtn?.addEventListener('click', () => {
const username = document.getElementById('registerUsername').value.trim();
const password = document.getElementById('registerPassword').value.trim();
if(!username || !password) { alert('Please enter username and password'); return; }
socket.emit('register', { username, password });
});

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

// Chat form with 2s cooldown
chatForm?.addEventListener('submit', e => {
e.preventDefault();
const now = Date.now();
if(now - lastMessageTime < 2000) return;
lastMessageTime = now;
const msg = chatInput.value.trim();
if(msg) {
socket.emit('chat', msg);
chatInput.value = '';
}
});

// Receive chat messages and show with timestamp
socket.on('chat', data => {
const p = document.createElement('p');
const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
p.textContent = `[${time}] ${data.user}: ${data.message}`;
chatBox.appendChild(p);
chatBox.scrollTop = chatBox.scrollHeight;
});

// Admin commands: /mute, /kick, /ban
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

// Optional: handle server responses for admin commands
socket.on('system', msg => {
const p = document.createElement('p');
p.style.fontStyle = 'italic';
p.textContent = msg;
chatBox.appendChild(p);
chatBox.scrollTop = chatBox.scrollHeight;
});
