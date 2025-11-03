require('dotenv').config();
const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const path=require('path');
const bcrypt=require('bcrypt');

const app=express();
const server=http.createServer(app);
const io=new Server(server);
const PORT=process.env.PORT||10000;

app.use(express.static(path.join(__dirname,'public')));
app.use(express.json());

// Data
let users={}; // username -> {passwordHash,isAdmin,status,mutedUntil,color,avatar}
let onlineUsers={}; // socket.id -> username
let messages=[];
let whispers=[];
let auditLogs=[];
let bannedUsers=[];
let avatarReports=[];

// Routes
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/chat.html',(req,res)=>res.sendFile(path.join(__dirname,'public','chat.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

// Socket.IO
io.on('connection',socket=>{
  let currentUser=null;

  // Auth
  socket.on('register',async({username,password})=>{
    if(!username||!password)return socket.emit('registerError','Missing username or password');
    if(users[username])return socket.emit('registerError','Username exists');
    const hash=await bcrypt.hash(password,10);
    users[username]={passwordHash:hash,isAdmin:false,status:'',mutedUntil:null,color:'blue',avatar:null};
    socket.emit('registerSuccess');
    auditLogs.push({action:'register',user:username,time:Date.now()});
  });

  socket.on('login',async({username,password})=>{
    const user=users[username]; if(!user)return socket.emit('loginError','User not found');
    const match=await bcrypt.compare(password,user.passwordHash); if(!match)return socket.emit('loginError','Incorrect password');
    currentUser=username;
    onlineUsers[socket.id]=username;
    socket.emit('loginSuccess',{isAdmin:user.isAdmin});
    updateUsers();
    socket.emit('messages',messages);
    socket.emit('updateReports',avatarReports);
    auditLogs.push({action:'login',user:username,time:Date.now()});
  });

  // Chat
  socket.on('chat',msg=>{
    if(!currentUser)return;
    const userData=users[currentUser];
    const now=Date.now();
    if(userData.mutedUntil && now<userData.mutedUntil)return;
    const messageObj={id:Date.now()+Math.random(),user:currentUser,message:msg,time:now,edited:false,color:userData.color,avatar:userData.avatar};
    messages.push(messageObj);
    io.emit('chat',messageObj);
  });

  socket.on('whisper',({target,message})=>{
    if(!currentUser||!users[target])return;
    const w={from:currentUser,to:target,message,time:Date.now()}; whispers.push(w);
    Object.entries(onlineUsers).forEach(([id,uname])=>{ if(uname===target||uname===currentUser) io.to(id).emit('whisper',w); });
  });

  socket.on('setProfile',({color,avatar})=>{
    if(!currentUser)return;
    if(color)users[currentUser].color=color;
    if(avatar)users[currentUser].avatar=avatar;
  });

  socket.on('setStatus',status=>{ if(!currentUser)return; users[currentUser].status=status; updateUsers(); });

  // Avatar report
  socket.on('reportAvatar',({target})=>{
    if(!currentUser||!users[target])return;
    avatarReports.push({reporter:currentUser,target,time:Date.now()});
    io.emit('updateReports',avatarReports);
  });

  // Admin commands
  socket.on('adminCommand',({cmd,target,arg})=>{
    const isAdmin=users[currentUser]?.isAdmin;
    if(!currentUser||!isAdmin)return;
    const now=Date.now();
    if(cmd==='kick'&&onlineUsers[target]){ const sockId=Object.keys(onlineUsers).find(id=>onlineUsers[id]===target); io.to(sockId).emit('kicked',arg||'Kicked by admin'); auditLogs.push({action:'kick',admin:currentUser,target,reason:arg,time:now}); }
    if(cmd==='ban'){ bannedUsers.push(target); const sockId=Object.keys(onlineUsers).find(id=>onlineUsers[id]===target); if(sockId) io.to(sockId).emit('banned',arg||'Banned by admin'); auditLogs.push({action:'ban',admin:currentUser,target,reason:arg,time:now}); }
    if(cmd==='mute'&&users[target]){ users[target].mutedUntil=now+(parseInt(arg)||60)*1000; const sockId=Object.keys(onlineUsers).find(id=>onlineUsers[id]===target); if(sockId) io.to(sockId).emit('mutedStatus',{mutedUntil:users[target].mutedUntil}); auditLogs.push({action:'mute',admin:currentUser,target,until:users[target].mutedUntil,time:now}); }
  });

  socket.on('disconnect',()=>{ if(currentUser)delete onlineUsers[socket.id]; updateUsers(); });

  function updateUsers(){
    const list=Object.values(onlineUsers).map(u=>({username:u,status:users[u]?.status||'',isAdmin:users[u]?.isAdmin||false,mutedUntil:users[u]?.mutedUntil||null}));
    io.emit('updateUsers',list);
  }
});

// Start
server.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
