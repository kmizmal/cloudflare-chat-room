// Self-contained chat page — inline CSS/JS, no external assets or bindings.
function esc(source: string): string {
  return source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPage(roomId: string, title: string): string {
  // roomId is already restricted to [A-Za-z0-9_-]; escape anyway so this
  // function stays safe if a caller ever passes something looser.
  const safeRoom = esc(roomId);
  const safeTitle = esc(title);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle || safeRoom} - Chat Room</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f8; --fg:#222; --panel:#fff; --line:#ddd; --accent:#117743; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16171a; --fg:#eee; --panel:#23252a; --line:#3a3d44; --accent:#4ade80; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Helvetica Neue","PingFang SC",sans-serif; background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #status { font-size:12px; padding:3px 9px; border-radius:12px; background:#eee; color:#555; }
  #status.online { background:#d6f5df; color:#116b34; }
  main { flex:1; display:flex; min-height:0; }
  #messages { flex:1; overflow-y:auto; padding:14px 18px; line-height:1.55; }
  .message p { margin:2px 0; word-break:break-word; }
  .nick { font-family:Consolas,Monaco,monospace; font-weight:bold; }
  .time { color:#888; font-size:12px; }
  .sys { color:#888; font-size:13px; font-style:italic; }
  aside { width:170px; border-left:1px solid var(--line); padding:10px 12px; background:var(--panel); overflow-y:auto; font-size:13px; }
  aside h2 { font-size:13px; margin:0 0 8px; }
  aside ul { list-style:none; padding:0; margin:0; }
  aside li { padding:2px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  form { display:flex; gap:8px; padding:10px 16px; background:var(--panel); border-top:1px solid var(--line); }
  input, button { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); }
  input[type=text] { flex:1; min-width:0; }
  button { background:var(--accent); color:#fff; border-color:var(--accent); cursor:pointer; }
  #gate { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:var(--bg); z-index:10; }
  #gate form { flex-direction:column; width:min(340px,90vw); gap:12px; border:1px solid var(--line); border-radius:12px; padding:24px; }
  #gate h2 { margin:0; } #toast { position:fixed; bottom:70px; left:50%; transform:translateX(-50%); background:#b91c1c; color:#fff; padding:8px 14px; border-radius:6px; display:none; z-index:20; }
  @media (max-width:620px) { aside { display:none; } }
</style>
</head>
<body>
<header>
  <h1>${safeTitle || safeRoom}</h1>
  <button id="renameBtn" type="button" title="修改昵称">改名</button>
  <button id="leaveBtn" type="button" title="离开聊天室">离开</button>
  <span id="status">未连接</span>
</header>
<main>
  <div id="messages" aria-live="polite"></div>
  <aside><h2>在线 (<span id="count">0</span>)</h2><ul id="users"></ul></aside>
</main>
<form id="sendForm" autocomplete="off">
  <input id="input" type="text" maxlength="1000" placeholder="输入消息…" aria-label="消息">
  <button type="submit">发送</button>
</form>
<div id="gate">
  <form id="gateForm">
    <h2>进入聊天室</h2>
    <input id="nick" type="text" maxlength="32" placeholder="你的昵称" aria-label="昵称" required>
    <button type="submit">进入</button>
  </form>
</div>
<div id="toast" role="alert"></div>
<script>
(function () {
  "use strict";
  const room = ${JSON.stringify(roomId)};
  let ws = null, uid = null, name = null, backoff = 1000, leaving = false;
  const $ = (id) => document.getElementById(id);
  const messages = $("messages"), status = $("status");

  function initIdentity() {
    name = localStorage.getItem("chat-name-" + room) || "";
    uid = localStorage.getItem("chat-uid-" + room) || "";
    if (!uid) { uid = Math.random().toString(36).slice(2, 8); localStorage.setItem("chat-uid-" + room, uid); }
    if (name) $("gate").style.display = "none";
    $("nick").value = name;
  }
  function setStatus(text, online) { status.textContent = text; status.classList.toggle("online", !!online); }
  function toast(text) { $("toast").textContent = text; $("toast").style.display = "block"; setTimeout(() => $("toast").style.display = "none", 3000); }
  function fmt(ts) { return new Intl.DateTimeFormat(undefined, { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).format(new Date(ts * 1000)); }
  function addMessage(text, cls, color) {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    p.textContent = text;
    if (color) p.style.color = color;
    messages.appendChild(p);
    messages.scrollTop = messages.scrollHeight;
  }
  function renderMsg(m) {
    const p = document.createElement("p");
    p.className = "message";
    const nick = document.createElement("span");
    nick.className = "nick"; nick.style.color = m.namecolor; nick.textContent = m.name;
    const time = document.createElement("span");
    time.className = "time"; time.textContent = " " + fmt(m.ts) + ": ";
    const body = document.createElement("span");
    body.style.color = m.msgcolor; body.textContent = m.text;
    p.append(nick, time, body);
    messages.appendChild(p);
    messages.scrollTop = messages.scrollHeight;
  }
  function renderUsers(users) {
    $("count").textContent = String(users.length);
    const ul = $("users"); ul.replaceChildren();
    users.forEach(u => { const li = document.createElement("li"); li.textContent = u.name + " (" + u.uid + ")"; ul.appendChild(li); });
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); else toast("未连接"); }
  function connect() {
    if (leaving) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/ws?room=" + encodeURIComponent(room) + "&name=" + encodeURIComponent(name) + "&uid=" + encodeURIComponent(uid);
    setStatus("连接中…", false);
    ws = new WebSocket(url);
    ws.onopen = () => { backoff = 1000; setStatus("已连接", true); };
    ws.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.type) {
        case "init":
          messages.replaceChildren();
          (ev.recent || []).forEach(renderMsg);
          renderUsers(ev.users || []);
          break;
        case "msg": renderMsg(ev.message); break;
        case "sys": addMessage(ev.text, "sys"); break;
        case "online": renderUsers(ev.users); break;
        case "rename": break; // the server broadcasts a sys rename notice
        case "error": toast(ev.text); break;
      }
    };
    ws.onclose = () => {
      setStatus("断开，重连中…", false);
      setTimeout(connect, backoff);
      backoff = Math.min(30000, backoff * 2);
    };
    ws.onerror = () => {};
  }
  $("gateForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("nick").value.trim();
    if (!v) return;
    name = v; localStorage.setItem("chat-name-" + room, name);
    $("gate").style.display = "none";
    leaving = false; backoff = 1000; // allow re-entry after an explicit leave
    connect();
  });
  $("sendForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("input").value.trim();
    if (!v) return;
    send({ type: "message", text: v });
    $("input").value = "";
  });
  $("leaveBtn").addEventListener("click", () => { leaving = true; if (ws) ws.close(1000, "leave"); setStatus("已离开", false); $("gate").style.display = "flex"; localStorage.removeItem("chat-name-" + room); name = ""; });
  $("renameBtn").addEventListener("click", () => {
    const v = window.prompt("新昵称（最多 32 字）", name || "");
    if (v && v.trim()) { name = v.trim().slice(0, 32); localStorage.setItem("chat-name-" + room, name); send({ type: "rename", name }); }
  });
  initIdentity();
  // Returning visitors already have a nickname: connect immediately instead of
  // waiting for a gate submit that can never happen (the gate is hidden).
  if (name) connect();
})();
</script>
</body>
</html>`;
}
