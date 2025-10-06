const loginForm = document.getElementById('loginForm');
const chatForm = document.getElementById('chatForm');
const chatBox = document.getElementById('chatBox');
let username = '';

loginForm?.addEventListener('submit', async e => {
    e.preventDefault();
    username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
        if(username === 'DEV') window.location.href = '/admin.html';
        else window.location.href = '/chat.html';
    } else alert('Wrong password!');
});

chatForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const msgInput = document.getElementById('chatInput');
    const message = msgInput.value;
    if (!message) return;
    await fetch('/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, message })
    });
    msgInput.value = '';
});

async function loadMessages(){
    const res = await fetch('/messages');
    const messages = await res.json();
    chatBox.innerHTML = messages.map(m => `<p><b>${m.username}:</b> ${m.message}</p>`).join('');
}
setInterval(loadMessages, 1000);