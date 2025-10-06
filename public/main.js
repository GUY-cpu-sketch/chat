const socket = io();

const usernameInput = document.getElementById('usernameInput');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const messagesContainer = document.getElementById('messagesContainer');
const onlineUsersContainer = document.getElementById('onlineUsersContainer');

sendButton.addEventListener('click', () => {
  const message = chatInput.value;
  if (message) {
    socket.emit('sendMessage', message);
    chatInput.value = '';
  }
});

socket.on('receiveMessage', (data) => {
  const messageElement = document.createElement('div');
  messageElement.textContent = `${data.user}: ${data.message}`;
  messagesContainer.appendChild(messageElement);
});

socket.on('updateUserList', (users) => {
  onlineUsersContainer.innerHTML = '';
  users.forEach((user) => {
    const userElement = document.createElement('div');
    userElement.textContent = user;
    onlineUsersContainer.appendChild(userElement);
  });
});

function setUsername() {
  const username = usernameInput.value;
  if (username) {
    socket.emit('setUsername', username);
    usernameInput.disabled = true;
  }
}
