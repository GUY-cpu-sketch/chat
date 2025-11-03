const socket = io();

// DOM
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");
const userList = document.getElementById("userList");
const typingIndicator = document.getElementById("typingIndicator");

const statusBtn = document.getElementById("statusBtn");
const statusInput = document.getElementById("statusInput");
const darkToggle = document.getElementById("darkToggle");
const adminBtn = document.getElementById("adminBtn");

const avatarInput = document.getElementById("avatarInput");
const colorPicker = document.getElementById("colorPicker");
const setProfileBtn = document.getElementById("setProfileBtn");

// State
let myUsername = sessionStorage.getItem("username") || null;
let isAdmin = sessionStorage.getItem("isAdmin") === "true";
let lastWhisperFrom = null;
let lastMessageTime = 0;
let typingTimeout = null;

// Sounds
const sounds = { join:new Audio('/sounds/join.mp3'), whisper:new Audio('/sounds/whisper.mp3'), mention:new Audio('/sounds/mention.mp3') };
function playSound(name){ try{ sounds[name]?.play().catch(()=>{}); }catch(e){} }

// -------------------- Auth --------------------
if(loginBtn && registerBtn){
  loginBtn.addEventListener("click", ()=>{
    const u=loginUsername.value.trim(), p=loginPassword.value.trim();
    if(!u||!p)return alert("Enter username & password");
    sessionStorage.setItem("username",u); sessionStorage.setItem("password",p);
    socket.emit("login",{username:u,password:p});
  });
  registerBtn.addEventListener("click", ()=>{
    const u=registerUsername.value.trim(), p=registerPassword.value.trim();
    if(!u||!p)return alert("Enter username & password");
    socket.emit("register",{username:u,password:p});
  });
  socket.on("loginSuccess",({isAdmin:adminFlag})=>{
    isAdmin=!!adminFlag; sessionStorage.setItem("isAdmin",isAdmin?"true":"false"); window.location.href="chat.html";
  });
  socket.on("loginError",msg=>alert(msg));
  socket.on("registerSuccess",()=>alert("Registered!"));
  socket.on("registerError",msg=>alert(msg));
}

// -------------------- Chat --------------------
if(chatForm){
  myUsername=sessionStorage.getItem("username");
  const password=sessionStorage.getItem("password");
  if(!myUsername||!password){
    if(!sessionStorage.getItem("redirected")){ sessionStorage.setItem("redirected","true"); window.location.href="index.html"; }
  }else{ sessionStorage.removeItem("redirected"); socket.emit("login",{username:myUsername,password}); }

  chatInput.addEventListener("input",()=>{
    socket.emit("typing",true);
    clearTimeout(typingTimeout);
    typingTimeout=setTimeout(()=>socket.emit("typing",false),1200);
  });

  chatForm.addEventListener("submit",(e)=>{
    e.preventDefault();
    const raw=chatInput.value.trim(); if(!raw)return;
    const now=Date.now();
    if(now-lastMessageTime<2000){ alert("Slow down! (2s cooldown)"); return; }
    lastMessageTime=now;

    if(raw.startsWith("/status ")){ socket.emit("setStatus",raw.slice(8).trim()); chatInput.value=""; return; }
    if(raw.startsWith("/whisper ")){
      const parts=raw.split(" "); const target=parts[1]; const msg=parts.slice(2).join(" ");
      if(!target||!msg)return alert("Usage: /whisper [user] [message]");
      socket.emit("whisper",{target,message:msg}); chatInput.value=""; return;
    }
    if(raw.startsWith("/reply ")){
      if(!lastWhisperFrom)return alert("No whispers yet!");
      socket.emit("whisper",{target:lastWhisperFrom,message:raw.slice(7)}); chatInput.value=""; return;
    }
    if(raw.startsWith("/")){
      const [cmd,target,...args]=raw.slice(1).split(" "); socket.emit("adminCommand",{cmd,target,arg:args.join(" ")}); chatInput.value=""; return;
    }

    socket.emit("chat",raw); chatInput.value="";
  });

  statusBtn?.addEventListener("click",()=>{ const s=statusInput.value.trim(); if(s)socket.emit("setStatus",s); statusInput.value=""; });
  adminBtn?.addEventListener("click",()=>{ if(isAdmin)window.location.href="/admin"; else alert("Admins only"); });

  // Profile
  setProfileBtn?.addEventListener("click",()=>{
    const color=colorPicker.value;
    const avatar=avatarInput.value.trim();
    socket.emit("setProfile",{color,avatar});
    alert("Profile updated!");
  });
}

// -------------------- Socket Events --------------------
socket.on('messages',arr=>{ chatBox.innerHTML=''; arr.forEach(renderMessage); chatBox.scrollTop=chatBox.scrollHeight; });
socket.on('chat',data=>{
  renderMessage(data); chatBox.scrollTop=chatBox.scrollHeight;
  if(data.message.includes(`@${myUsername}`)){ playSound('mention'); const last=chatBox.lastChild; last.classList.add('mention'); setTimeout(()=>last.classList.remove('mention'),3000); }
});
socket.on('whisper',({from,message})=>{
  lastWhisperFrom=from; const p=document.createElement('p'); p.innerHTML=`<b>${from} → You</b>: ${message}`; chatBox?.appendChild(p); chatBox.scrollTop=chatBox.scrollHeight; playSound('whisper');
});
socket.on('editMessage',msg=>{ const el=document.querySelector(`[data-id="${msg.id}"]`); if(el) el.querySelector('.msg-text').innerHTML=msg.message+(msg.edited?' (edited)':''); });
socket.on('deleteMessage',({id})=>{ const el=document.querySelector(`[data-id="${id}"]`); if(el) el.remove(); });
socket.on('updateUsers',list=>{ userList.innerHTML=''; list.forEach(u=>{ const li=document.createElement('li'); li.textContent=u.username; if(u.isAdmin) li.style.fontWeight='bold'; userList.appendChild(li); }); });
socket.on('typing',({user,isTyping})=>{ typingIndicator.textContent=isTyping?`${user} is typing...` : ''; });

// Avatar reports
socket.on('updateReports',reports=>{
  const container=document.getElementById('avatarReports');
  if(!container)return;
  container.innerHTML='';
  reports.forEach(r=>{ const li=document.createElement('li'); li.textContent=`[${new Date(r.time).toLocaleTimeString()}] ${r.reporter} reported ${r.target}`; container.appendChild(li); });
});

// -------------------- Dark Mode --------------------
document.documentElement.classList.add('dark');
darkToggle.checked=false;
darkToggle?.addEventListener('change',e=>document.documentElement.classList.toggle('dark',e.target.checked));

// -------------------- Helpers --------------------
function renderMessage(data){
  const div=document.createElement('div'); div.className='chat-msg'; div.dataset.id=data.id;
  const timeStr=new Date(data.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const color=data.color||'blue';
  const avatarHTML=data.avatar?`<img src="${data.avatar}" class="msg-avatar" data-user="${data.user}">`:'';
  div.innerHTML=`${avatarHTML}<span class="msg-user" style="color:${color}">${data.user}</span>: <span class="msg-text">${data.message}</span> <span class="msg-time">${timeStr}</span>`;

  const avatarEl=div.querySelector('.msg-avatar');
  if(avatarEl){
    avatarEl.addEventListener('contextmenu',e=>{ e.preventDefault(); if(confirm(`Report avatar of ${data.user}?`)){ socket.emit('reportAvatar',{target:data.user}); alert('Reported to admin!'); } });
  }

  chatBox.appendChild(div);
}
