// End-to-end smoke test using only Node built-ins (no npm deps).
// Usage: node scripts/smoke.mjs [baseUrl]
const baseHttp = process.argv[2] || "http://127.0.0.1:8787";
const baseWs = baseHttp.replace(/^http/, "ws");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, cond, extra = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${extra}`); }
}

function open(room, name, uid) {
  const ws = new WebSocket(`${baseWs}/ws?room=${room}&name=${encodeURIComponent(name)}&uid=${uid}`);
  const events = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data)));
  return { ws, events, ready: new Promise((res) => ws.addEventListener("open", res)) };
}

console.log(`Smoke test against ${baseHttp}`);
const health = await fetch(`${baseHttp}/health`);
check("GET /health -> 200 alive", health.status === 200 && (await health.text()) === "alive");

const redirect = await fetch(`${baseHttp}/`, { redirect: "manual" });
check("GET / -> 302 /room/@demo", redirect.status === 302 && redirect.headers.get("location")?.endsWith("/room/@demo"));

const page = await fetch(`${baseHttp}/room/@demo?title=Smoke`);
const html = await page.text();
check("room page 200 + has input/status/list", page.status === 200 && html.includes('id="input"') && html.includes('id="status"') && html.includes('id="messages"'));

const bad = await fetch(`${baseHttp}/room/@bad%20room`);
check("invalid room id -> 400", bad.status === 400);

const filtered = await (await fetch(`${baseHttp}/filter?q=${encodeURIComponent("<img src=x onerror=alert(1)>")}`)).text();
check("GET /filter escapes HTML", filtered.includes("&lt;img") && !filtered.includes("<img"));

check("WS upgrade without header -> 426", (await fetch(`${baseHttp}/ws?room=demo`)).status === 426);

const room = `smoke${Date.now() % 100000}`;
const a = open(room, "Alice", "aaa111");
await a.ready;
await wait(400);
const b = open(room, "Bob", "bbb222");
await b.ready;
await wait(600);

b.ws.send(JSON.stringify({ type: "message", text: "<script>alert(1)</script> hi" }));
await wait(500);
const gotMsg = a.events.find((e) => e.type === "msg");
check("broadcast message reaches other client", !!gotMsg);
check("message text is raw for DOM (escaped at render)", !!gotMsg && gotMsg.message.text.includes("<script>"));
check("message shows sender + time", !!gotMsg && gotMsg.message.name === "Bob" && Number.isInteger(gotMsg.message.ts));

check("join notice broadcast", a.events.some((e) => e.type === "sys" && e.text.includes("Bob(bbb222) join")));
const online = a.events.filter((e) => e.type === "online").at(-1);
check("online list contains both users", !!online && online.users.length === 2);

// rate limit: 20 allowed per 10s window, 21st rejected
for (let i = 0; i < 25; i++) b.ws.send(JSON.stringify({ type: "message", text: `spam ${i}` }));
await wait(1200);
const errs = b.events.filter((e) => e.type === "error");
check("rate limit fires errors after quota", errs.length >= 1, `errors=${errs.length}`);

b.ws.send(JSON.stringify({ type: "leave" }));
await wait(800);
check("leave notice broadcast", a.events.some((e) => e.type === "sys" && e.text.includes("leave the chat")));

const record = await (await fetch(`${baseHttp}/room/@${room}/record?limit=5`)).json();
check("/record returns persisted messages", Array.isArray(record) && record.length > 0);
check("/record respects limit", record.length <= 5);

const svg = await fetch(`${baseHttp}/room/@${room}/svg?width=400&height=200&theme=light&title=${encodeURIComponent("<x>")}`);
const svgText = await svg.text();
check("SVG served as image/svg+xml", svg.headers.get("content-type")?.includes("image/svg+xml"));
check("SVG escapes title", svgText.includes("&lt;x&gt;") && !svgText.includes("<x>"));
check("SVG escapes message text", svgText.includes("&lt;script&gt;") && !svgText.includes("<script>alert"));

a.ws.close();
await wait(300);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
