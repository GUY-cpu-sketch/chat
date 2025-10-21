require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check
app.get('/health', (req, res) => res.send('OK'));

// ---------------------- In-memory state ----------------------
let online = {}; // socketId -> username
let userData = {}; // username -> { joinedAt, status }
let whispers = []; // { from, to, message, time }
let bannedUsers = new Set();
let mutedUsers = {}; // username -> timestamp
let messages = []; // { id, user, message, time, edited }
let logs = []; // audit logs { admin, cmd, target, time, extra }

// Multiple admins
const admins = new Set(['DEV','skullfucker99','testuser1']);

// ---------------------- Helpers ----------------------
function makeId() {
  return `${Date.now()}-${Math.floor(Math.random()*100000)}`;
}

function addLog(admin, cmd, target, extra='') {
  logs.unshift({ admin, cmd, target, time: Date.now(), extra });
  if (logs.length>1000) logs.length=1000;
}

function isMuted(username) {
  const until = mutedUsers[username];
  if (!until) return false;
  if (Date.now()>=until) {
    delete mutedUsers[username];
    return false;
  }
  return true;
}

function broadcastUsers() {
  io.emit('updateUsers', Object.values(online).map(u=>({
    username: u,
    status: userData[u]?.status||'',
    isAdmin: admins.has(u),
    mutedUntil: mutedUsers[u]||null
  })));
}

// Cleanup expired mutes
setInterval(()=>{
  for (const [u,until] of Object.entries(mutedUsers)){
    if (Date.now()>=until){
      delete mutedUsers[u];
      io.emit('system',`${u} has been unmuted (timer expired).`);
      broadcastUsers();
    }
  }
},5000);

// ---------------------- Socket Handling ----------------------
io.on('connection', (socket)=>{
  console.log('Connect:', socket.id);

  // LOGIN
  socket.on('login', ({ username, password })=>{
    if (!username || !password) return socket.emit('loginError','Missing username or password');
    if (bannedUsers.has(username)) return socket.emit('banned','You are banned');

    socket.username = username;
    online[socket.id] = username;

    if (!userData[username]) userData[username] = { joinedAt: Date.now(), status:'' };

    socket.emit('loginSuccess',{ isAdmin: admins.has(username) });
    socket.emit('messages', messages.slice(-200));
    socket.emit('updateWhispers', whispers);
    broadcastUsers();

    io.emit('system',`${username} joined`);
    io.emit('playSound','join');
  });

  // REGISTER
  socket.on('register', ({ username, password })=>{
    if (!username || !password) return socket.emit('registerError','Missing username or password');
    // simple memory register (no DB)
    if (userData[username]) return socket.emit('registerError','Username already exists');
    userData[username]={ joinedAt: Date.now(), status:'' };
    socket.emit('registerSuccess');
  });

  // CHAT MESSAGE
  socket.on('chat',(msg)=>{
    if (!socket.username) return;
    if (isMuted(socket.username)){
      socket.emit('system',`You are muted until ${new Date(mutedUsers[socket.username]).toLocaleString()}`);
      socket.emit('mutedStatus',{ mutedUntil: mutedUsers[socket.username] });
      return;
    }
    const entry={ id: makeId(), user: socket.username, message: msg, time: Date.now(), edited:false };
    messages.push(entry);
    io.emit('chat', entry);
  });

  // WHISPERS
  socket.on('whisper', ({ target, message })=>{
    if (!socket.username || !target || !message) return;
    if (isMuted(socket.username)) return socket.emit('system','You are muted, cannot whisper');

    const w={ from: socket.username, to: target, message, time: Date.now() };
    whispers.push(w);
    io.emit('updateWhispers', whispers);

    for (let [id,name] of Object.entries(online)){
      if (name===target){
        io.to(id).emit('whisper',{ from: socket.username, message });
        io.to(id).emit('playSound','whisper');
      }
    }
  });

  // ADMIN COMMANDS
  socket.on('adminCommand', ({ cmd, target, arg })=>{
    if (!socket.username || !admins.has(socket.username)) return;
    if (!target) return socket.emit('system','No target specified');
    if (admins.has(target)) return socket.emit('system','Cannot target another admin');

    let targetId=null;
    for (let [id,name] of Object.entries(online)){ if (name===target) targetId=id; }

    switch(cmd){
      case 'kick':
        if (!targetId) return socket.emit('system','Target not online');
        io.to(targetId).emit('kicked','You were kicked by admin');
        io.sockets.sockets.get(targetId)?.disconnect();
        addLog(socket.username,'kick',target);
        io.emit('system',`${target} was kicked by ${socket.username}`);
        break;
      case 'ban':
        bannedUsers.add(target);
        if (targetId){
          io.to(targetId).emit('banned','You were banned by admin');
          io.sockets.sockets.get(targetId)?.disconnect();
        }
        addLog(socket.username,'ban',target);
        io.emit('system',`${target} was banned by ${socket.username}`);
        break;
      case 'mute':
        const seconds=parseInt(arg,10)||60;
        mutedUsers[target]=Date.now()+seconds*1000;
        if (targetId){
          io.to(targetId).emit('mutedStatus',{ mutedUntil: mutedUsers[target] });
          io.to(targetId).emit('system',`You were muted for ${seconds}s by ${socket.username}`);
        }
        addLog(socket.username,'mute',target,`for ${seconds}s`);
        io.emit('system',`${target} was muted by ${socket.username} for ${seconds}s`);
        broadcastUsers();
        break;
      default:
        socket.emit('system','Unknown admin command');
    }
  });

  // EDIT MESSAGE
  socket.on('editMessage', ({ id, newText })=>{
    if (!socket.username) return;
    const idx=messages.findIndex(m=>m.id===id);
    if (idx===-1) return;
    const msg=messages[idx];
    if (msg.user!==socket.username && !admins.has(socket.username)) return socket.emit('system','Cannot edit that message');
    messages[idx].message=newText;
    messages[idx].edited=true;
    io.emit('editMessage',messages[idx]);
    if (admins.has(socket.username) && msg.user!==socket.username) addLog(socket.username,'editMessage',msg.user,`edited message ${id}`);
  });

  // DELETE MESSAGE
  socket.on('deleteMessage',({ id })=>{
    if (!socket.username) return;
    const idx=messages.findIndex(m=>m.id===id);
    if (idx===-1) return;
    const msg=messages[idx];
    if (msg.user!==socket.username && !admins.has(socket.username)) return socket.emit('system','Cannot delete that message');
    messages.splice(idx,1);
    io.emit('deleteMessage',{ id });
    if (admins.has(socket.username) && msg.user!==socket.username) addLog(socket.username,'deleteMessage',msg.user,`deleted message ${id}`);
  });

  // TYPING
  socket.on('typing',(isTyping)=>{
    if (!socket.username) return;
    socket.broadcast.emit('typing',{ user: socket.username, isTyping });
  });

  // STATUS
  socket.on('setStatus',(status)=>{
    if (!socket.username) return;
    userData[socket.username] = userData[socket.username]||{ joinedAt: Date.now(), status:'' };
    userData[socket.username].status=status;
    broadcastUsers();
  });

  // GET ADMIN DATA
  socket.on('getAdminData',()=>{
    if (!socket.username || !admins.has(socket.username)) return;
    socket.emit('adminData',{
      online: Object.values(online),
      banned: Array.from(bannedUsers),
      muted: Object.entries(mutedUsers).map(([user,mutedUntil])=>({ user, mutedUntil })),
      logs
    });
  });

  // ADMIN UNBAN / UNMUTE
  socket.on('adminAction',({ action, target })=>{
    if (!socket.username || !admins.has(socket.username) || !target) return;
    if (action==='unban' && bannedUsers.has(target)) {
      bannedUsers.delete(target);
      addLog(socket.username,'unban',target);
      io.emit('system',`${target} was unbanned by ${socket.username}`);
    }
    if (action==='unmute' && mutedUsers[target]){
      delete mutedUsers[target];
      addLog(socket.username,'unmute',target);
      io.emit('system',`${target} was unmuted by ${socket.username}`);
      broadcastUsers();
    }
  });

  // GET PROFILE
  socket.on('getProfile',({ username })=>{
    if (!username) return;
    const data=userData[username]||null;
    socket.emit('profileData',{ username, data });
  });

  // DISCONNECT
  socket.on('disconnect',()=>{
    if (socket.username){
      delete online[socket.id];
      io.emit('system',`${socket.username} left`);
      broadcastUsers();
    }
  });
});

// ---------------------- START SERVER ----------------------
server.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
