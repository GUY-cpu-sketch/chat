const socket = io();
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatBox = document.getElementById("chatBox");

let lastMessageTime = 0;
let lastWhisperFrom = null;

// Create audio element for whisper notifications
const whisperSound = new Audio("/sounds/notification.mp3");

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    let msg = chatInput.value.trim();
    if (!msg) return;

    const now = Date.now();
    if (now - lastMessageTime < 2000) {
      alert("Slow down! (2s cooldown)");
      return;
    }
    lastMessageTime = now;

    // Whisper
    if (msg.startsWith("/whisper ")) {
      const parts = msg.split(" ");
      const target = parts[1];
      const message = parts.slice(2).join(" ");
      if (!target || !message) return alert("Usage: /whisper [username] [message]");
      socket.emit("whisper", { target, message });
      chatInput.value = "";
      return;
    }

    // Reply
    if (msg.startsWith("/reply ")) {
      if (!lastWhisperFrom) return alert("No one has whispered to you yet!");
      const message = msg.slice(7);
      socket.emit("whisper", { target: lastWhisperFrom, message });
      chatInput.value = "";
      return;
    }

    // Admin commands
    if (msg.startsWith("/")) {
      const [cmd, target, arg] = msg.slice(1).split(" ");
      socket.emit("adminCommand", { cmd, target, arg });
      chatInput.value = "";
      return;
    }

    // Normal chat
    socket.emit("chat", msg);
    chatInput.value = "";
  });

  socket.on("chat", (data) => {
    const p = document.createElement("p");
    const time = new Date(data.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${data.user}</b>: ${data.message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("whisper", ({ from, message }) => {
    lastWhisperFrom = from;

    // Play notification sound
    whisperSound.currentTime = 0;
    whisperSound.play().catch(() => {}); // catch for browsers that block autoplay

    const p = document.createElement("p");
    p.style.color = "#ffb86c";
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${from} → You</b>: ${message}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("system", (msg) => {
    const p = document.createElement("p");
    p.style.color = "#888";
    p.textContent = `[SYSTEM] ${msg}`;
    chatBox.appendChild(p);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on("kicked", () => {
    alert("You were kicked by an admin!");
    window.close();
  });

  socket.on("banned", () => {
    alert("You were banned by an admin!");
    window.close();
  });
}

// Admin whisper logs
const whisperLogs = document.getElementById("whisperLogs");
if (whisperLogs) {
  socket.on("updateWhispers", (allWhispers) => {
    whisperLogs.innerHTML = "";
    allWhispers.forEach(w => {
      const p = document.createElement("p");
      const time = new Date(w.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      p.innerHTML = `<span style="color:#aaa;">[${time}]</span> <b>${w.from}</b> → <b>${w.to}</b>: ${w.message}`;
      whisperLogs.appendChild(p);
    });
    whisperLogs.scrollTop = whisperLogs.scrollHeight;
  });
}

/* ============================================================
   KONAMI CODE MINI CONSOLE (↑ ↑ ↓ ↓ ← → ← → A B)
   ============================================================ */
const konamiCode = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","a","b"];
let konamiIndex = 0;
let consoleDiv = null;

document.addEventListener("keydown", (e) => {
  if (e.key === konamiCode[konamiIndex]) {
    konamiIndex++;
    if (konamiIndex === konamiCode.length) {
      konamiIndex = 0;
      toggleConsole();
    }
  } else {
    konamiIndex = 0;
  }
});

function toggleConsole() {
  if (consoleDiv) {
    consoleDiv.remove();
    consoleDiv = null;
    return;
  }

  consoleDiv = document.createElement("div");
  consoleDiv.style.position = "fixed";
  consoleDiv.style.bottom = "10px";
  consoleDiv.style.left = "10px";
  consoleDiv.style.width = "350px";
  consoleDiv.style.height = "200px";
  consoleDiv.style.background = "rgba(30,30,30,0.9)";
  consoleDiv.style.color = "#00ff88";
  consoleDiv.style.fontFamily = "monospace";
  consoleDiv.style.fontSize = "12px";
  consoleDiv.style.overflowY = "auto";
  consoleDiv.style.border = "1px solid #444";
  consoleDiv.style.borderRadius = "8px";
  consoleDiv.style.padding = "6px";
  consoleDiv.style.zIndex = "9999";
  consoleDiv.style.cursor = "move";
  consoleDiv.textContent = "🕹 Debug Console (Konami Mode)\n";

  document.body.appendChild(consoleDiv);
  makeDraggable(consoleDiv);

  const origLog = console.log;
  const origErr = console.error;

  console.log = (...args) => {
    origLog(...args);
    const msg = document.createElement("div");
    msg.textContent = args.join(" ");
    consoleDiv.appendChild(msg);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  };

  console.error = (...args) => {
    origErr(...args);
    const msg = document.createElement("div");
    msg.style.color = "red";
    msg.textContent = args.join(" ");
    consoleDiv.appendChild(msg);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  };

  window.addEventListener("error", (e) => {
    const msg = document.createElement("div");
    msg.style.color = "red";
    msg.textContent = `Error: ${e.message}`;
    consoleDiv.appendChild(msg);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  });
}

function makeDraggable(el) {
  let offsetX = 0, offsetY = 0, isDragging = false;

  el.addEventListener("mousedown", (e) => {
    isDragging = true;
    offsetX = e.clientX - el.offsetLeft;
    offsetY = e.clientY - el.offsetTop;
  });

  document.addEventListener("mousemove", (e) => {
    if (isDragging) {
      el.style.left = `${e.clientX - offsetX}px`;
      el.style.top = `${e.clientY - offsetY}px`;
      el.style.bottom = "auto";
    }
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}
