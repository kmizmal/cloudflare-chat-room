# Cloudflare Workers Chat Room — Design

**Date:** 2026-11-18
**Reference:** https://github.com/journey-ad/chat-room (journey-ad/chat-room, MIT)

## Intent

Build a runnable, publicly-accessible web chat room on Cloudflare Workers that reproduces the reference project's page structure, message flow, and room interactions, while replacing its Node/Express/Socket.IO/Mongoose server with Workers primitives. Deliver working source, config, local-run and deploy instructions, and an explicit borrowed-vs-adapted list.

## Goals

1. Nickname on entry; WebSocket realtime connect; text broadcast with sender/content/time; join / leave / disconnect handling.
2. Frontend page with nickname input, connection status, message list, message input.
3. Worker handles routing, WebSocket upgrade, connection management; shared state uses Durable Objects, with rationale and alternatives documented.
4. Complete project structure, key source, `wrangler.toml`, local commands, deploy steps.
5. Input validation, length limits, XSS escaping, simple rate limiting.
6. Mirror reference features selected by the user: named rooms, online list, join/leave/rename system messages, persistent history, `/record`, SVG live chart, word filter.

## Non-goals

- Exact pixel replication of the 2020 EJS/CSS theme (adapted, not cloned).
- Vendoring the full 148 KB upstream `banword.json` (ship a curated starter list + swap instructions).
- SVG chart's historical "replace word X with Y" special case for one specific room.
- Authentication, private rooms, image/file messages, moderation UI.

## Constraints

- Cloudflare Workers runtime only; no Node.js built-ins, no long-lived process memory, no `net`/`fs`.
- Durable Object state is per-object; one object per room via `idFromName(roomId)`.
- Hibernation API: in-memory state resets when idle, so per-connection state must live in `WebSocket.serializeAttachment`.
- Docs basis: `/cloudflare/workers-sdk` (Context7) and Cloudflare "Use WebSockets" (updated 2026-10-30) — Hibernation API, `acceptWebSocket`, `getWebSockets`, attachments, `new_sqlite_classes` migration, `ctx.storage.sql.exec`.
- Pinned `compatibility_date = "2026-04-07"` to enable automatic close-frame replies; documented in README.

## Approaches considered

| Approach | Trade-off | Verdict |
| --- | --- | --- |
| Modular TypeScript Worker + one SQLite-backed DO per room, Hibernation API | Faithful to named rooms and membership; hibernation cuts cost; SQL gives history + SVG | **Chosen** |
| Same plus KV/D1 for history | More infra, weaker ordering; history already fits in the room DO | Rejected |
| Single global-room single-file Worker | Fastest, but drops named rooms and most reference behavior | Rejected |

## Architecture & decisions

**Worker (`src/index.ts`)** — pure router. Validates `roomId` (`^[A-Za-z0-9_-]{1,32}$`) and query params *before* creating a DO stub (avoid billing invalid requests). Routes:

- `GET /` → 302 `/room/@demo`
- `GET /room/@:roomId?title=` → HTML page
- `GET /ws?room=&name=&uid=` → require `Upgrade: websocket` (else 426), validate inputs, proxy to DO stub
- `GET /room/@:roomId/record?limit=&offset=` → JSON via `stub.fetch`
- `GET /room/@:roomId/svg?...` → SVG via `stub.fetch`
- `GET /health` → `alive` (reference `/heart-beat`)
- `GET /filter?q=` → sanitized text (reference parity)

**Durable Object (`src/chatRoom.ts`)** — `class ChatRoom extends DurableObject<Env>`:

- `fetch`: `WebSocketPair`, `ctx.acceptWebSocket(server)`, `serializeAttachment` with `{ uid, name, joinedAt, recentTs }`, return 101 with client socket.
- `webSocketMessage`: restore attachment → parse JSON → validate/rate-limit → sanitize → persist SQL → broadcast to `ctx.getWebSockets()`. Message types: `message`, `rename`, `leave`.
- `webSocketClose` / `webSocketError`: restore attachment, broadcast `sys` + `online`; auto close-reply from runtime.
- Membership derived from `ctx.getWebSockets()` + attachments — no separate in-memory `roomList`, so hibernation is safe.
- Broadcasts: `init`, `sys`, `online`, `msg`, `rename`, `error`.

**Why Durable Objects:** Workers isolate requests in separate contexts, so a plain Worker cannot keep a shared socket registry or ordered message stream. A DO gives one single-threaded coordinator per room with ordered delivery, built-in WebSocket fan-out, and durable storage. Alternatives: external Redis/KV pub-sub (extra service, no ordering guarantee) or D1 polling (not realtime). Documented in README.

**Storage (SQLite in DO):** one `messages` table (`id`, `uid`, `name`, `text`, `ts`, `namecolor`, `msgcolor`), pruned to the newest ~1000 rows. `new_sqlite_classes: ["ChatRoom"]` migration, `ctx.storage.sql.exec`, cursor `.toArray()`/`.raw()`.

**Protocol:** JSON envelopes. Client→server `{type:"message"|"rename"|"leave", ...}`; server→client `{type:"init"|"sys"|"online"|"msg"|"rename"|"error", ...}`. `init` includes `you`, `users`, `recent` (last 50) so a reload restores context.

**Frontend (`src/ui/page.ts`):** one self-contained HTML response (inline CSS + JS, no asset binding). Nickname gate using `localStorage` (reference used cookies), status pill, scrolling message list, online list, input + send, auto-reconnect with backoff. All user-controlled text inserted via `textContent`, never `innerHTML`.

## Security rules

- `roomId`: `^[A-Za-z0-9_-]{1,32}$`; `name`: trim, 1–32 chars, control chars stripped, then HTML-escaped; message: trim, 1–1000 chars (reference cap), HTML-escaped.
- Colors: `^#(?:[0-9a-fA-F]{3,4}){1,2}$` else defaults `#117743` / `#3d3d3d` (reference defaults).
- Escape order: filter words first, then escape `& < > " '`; SVG path escapes again for XML.
- Rate limit: sliding window per connection in attachment — max 20 messages / 10 s, plus 1 rename / 5 s;超限 sends `{type:"error"}` and drops the message.
- `/record` clamps `limit` 1–100, `offset` >= 0; SVG params clamped; all responses `Cache-Control: no-store`.
- Word filter: curated small list in `src/banwords.ts`, longest-match-first `***` replacement; README explains swapping in upstream `utils/banword.json`.

## File plan

```
cloudflare-chat-room/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts          Worker router + upgrade proxy
│   ├── chatRoom.ts       ChatRoom DO (WS, membership, broadcast, SQL)
│   ├── types.ts          Env + protocol types
│   ├── validation.ts     validation, escaping, word filter, rate-limit helpers
│   ├── banwords.ts       curated starter word list
│   ├── svg.ts            record → SVG (foreignObject, XML-safe)
│   └── ui/page.ts        self-contained HTML/CSS/JS page
├── test/
│   └── validation.test.ts  node:test via tsx for pure helpers
└── docs/superpowers/specs/2026-11-18-cloudflare-chat-room-design.md
```

## Verification

1. `npm install`
2. `npx tsc --noEmit` — clean.
3. `npm test` — validation/escaping/word-filter/SVG escaping tests pass.
4. `npx wrangler dev` — open two tabs at `http://localhost:8787/room/@demo`, set nicknames, exchange messages; verify join/leave notices, `/record`, `/svg`, rate-limit error.
5. `npx wrangler deploy` — deployed URL serves the same page. (Requires Cloudflare account; not run in this environment.)

## Borrowed from reference / adapted for Workers

**Borrowed:** named rooms `/room/@name`; nickname + random UID with identity reuse; join/leave/rename system messages; online list; `init`/`sys`/`online`/`msg` event vocabulary; sender/color/time message shape; 32-char name / 1000-char message caps; hex color validation; `xss` + word-filter pipeline; persistent record + `/record`; SVG `foreignObject` live chart with `width/height/limit/theme/title/fontSize`; `/filter` and health endpoint.

**Adapted:** Express/Socket.IO → Worker router + native WebSocket + DO; in-memory `roomList` → socket attachments + `getWebSockets()` (hibernation-safe); Mongoose/SQLite file → DO SQLite; EJS template → self-contained HTML string; cookie identity → localStorage; socket.io auto-reconnect → explicit JS reconnect; external `xss` package → local escape helper (no Node deps); full 148 KB ban list → curated starter list; `moment` formatting → `Intl.DateTimeFormat`; server-side `foreignObject` escaping hardened.

**Deliberately omitted (see Non-goals):** SVG chart's room-specific word-replacement easter egg; full upstream ban list; exact 2020 CSS; auth/private rooms. `uid` is client-supplied (as upstream) and therefore spoofable by design — this is a public anonymous room, not authentication.

## Implementation clarifications (from design review)

- **Wrangler config is explicit:** `[[durable_objects.bindings]] name = "CHAT_ROOM", class_name = "ChatRoom"` plus `[[migrations]] tag = "v1", new_sqlite_classes = ["ChatRoom"]` in `wrangler.toml`; Worker reaches namespace via `env.CHAT_ROOM.idFromName(roomId)`.
- **Wire envelope:** all server frames are `ServerEvent` JSON with `type` + fields defined in `src/types.ts`. `msg` carries `{ type:"msg", message: MessageRecord }` where MessageRecord = `{ id, uid, name, text, ts, namecolor, msgcolor }`; `text` is already filter + HTML-escaped; `ts` is Unix **seconds** (integer), formatted client-side with `Intl.DateTimeFormat` in local time.
- **Join:** on first socket of a uid in the room, broadcast `{type:"sys", text:"<name>(<uid>) join the chat.", ts}` (upstream wording) then `{type:"online", users}`; same-uid new socket reuses identity without a join notice (reference session behavior).
- **Leave:** `{type:"leave"}` from client calls `ws.close(1000, "leave")`; the subsequent `webSocketClose` handler is the single place that removes membership and broadcasts leave `sys` + `online`. A bare disconnect follows the same path. No double broadcast.
- **Rate limit mutation:** `ConnectionState.recentTs` is updated in-memory, then `ws.serializeAttachment(state)` is called again so it survives hibernation; same for `lastRename` and rename.
- **Sanitization order:** apply word filter to the raw trimmed text first, then HTML-escape the filtered result (matches reference order `xss(filter(...))` semantics; avoids double-escaping).
- **History:** SQL `SELECT ... ORDER BY id DESC LIMIT ? OFFSET ?`; `init` sends the newest 50 as `recent` in chronological order (reverse of DESC query). Prune with `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)` on insert.
- **`/svg`:** params `width` (default 500), `height` (300), `limit` (20, max 100), `theme` (`light` or empty), `title`, `fontSize` (12); all numeric params `Math.abs`/clamped, title XML-escaped; response `Content-Type: image/svg+xml`, `Cache-Control: no-store`.
- **Reconnect:** client exponential backoff 1s → 30s cap; on `init` it replaces the message list with `recent` and sets status; on `error` it shows a toast; on unexpected close it retries unless a deliberate `leave` happened.
