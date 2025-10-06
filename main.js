// main.js for chat logic
const socket = io();

const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatBox = document.getElementById('chatBox');

let lastMessageTime = 0;

loginBtn?.addEventListener('click', () => {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    socket.emit('login', { username, password });
});

registerBtn?.addEventListener('click', () => {
    const username = document.getElementById('registerUsername').value;
    const password = document.getElementById('registerPassword').value;
    socket.emit('register', { username, password });
});

chatForm?.addEventListener('submit', e => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastMessageTime < 2000) return;
    lastMessageTime = now;
    const msg = chatInput.value;
    socket.emit('chat', msg);
    chatInput.value = '';
});

socket.on('chat', data => {
    const p = document.createElement('p');
    p.textContent = `${data.user}: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
});
