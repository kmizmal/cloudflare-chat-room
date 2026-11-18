# Cloudflare Workers Chat Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Build the chat room defined in `docs/superpowers/specs/2026-11-18-cloudflare-chat-room-design.md`.

**Architecture:** A stateless Worker router validates routes and proxies WebSocket upgrades to one SQLite-backed Durable Object per room. The DO uses the Hibernation WebSocket API; membership lives in connection attachments; SQL stores history for `/record` and `/svg`.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects (SQLite + Hibernation), Wrangler 4, node:test + tsx.

**Spec:** `docs/superpowers/specs/2026-11-18-cloudflare-chat-room-design.md`

## Global Constraints

- `compatibility_date = "2026-04-07"`; binding `CHAT_ROOM`; migration `tag = "v1"` with `new_sqlite_classes = ["ChatRoom"]`.
- No Node.js runtime dependencies in `src/`; pure helpers in `src/validation.ts` for testability.
- All timestamps in protocol are Unix seconds; frontend formats locally.
- User text always word-filtered then HTML-escaped on the server; frontend uses `textContent` only.

## Review Focus

- Untrusted `roomId`, `name`, `uid`, `text`, colors, and query params → validation/clamping in `src/index.ts` and `src/validation.ts`, tested in `test/validation.test.ts`.
- Hibernation state loss → attachment re-serialization after every mutation; reviewed in `src/chatRoom.ts`.
- Double leave broadcasts → single close handler; reviewed in `src/chatRoom.ts`.
- XSS via message text / SVG title → escape helpers tested in `test/validation.test.ts` and reviewed in `src/svg.ts`.
- Rate-limit bypass via reconnect → limit state is per attachment but keyed by uid-equivalent identity; documented as best-effort in README; tested for the pure helper.

---

### Task 1: Project scaffold + pure helpers

**Files:** Create `package.json`, `tsconfig.json`, `wrangler.toml`, `src/types.ts`, `src/validation.ts`, `src/banwords.ts`, `test/validation.test.ts`.

- [ ] **Step 1: Write failing tests** for `sanitizeRoomId` (valid/invalid), `normalizeName` (control chars, 40 chars → 32), `normalizeMessage` (empty → null, 1200 → 1000), `safeColor`, `escapeHtml`, `filterWords`, `rateLimited` (20 OK, 21st blocked, window expiry).
- [ ] **Step 2:** Run `npm test`; expect failure.
- [ ] **Step 3:** Implement helpers and scaffold files as sketched in the design.
- [ ] **Step 4:** Run `npm test`; expect pass.
- [ ] **Step 5:** Run `npx tsc --noEmit`; expect clean.
- [ ] **Step 6:** Commit `feat: scaffold Workers chat room with validation helpers`.

### Task 2: Durable Object room

**Files:** Create `src/chatRoom.ts`.

- [ ] **Step 1:** Implement `class ChatRoom extends DurableObject<Env>` with `fetch` (WebSocketPair, acceptWebSocket, attachment), `webSocketMessage` (message/rename/leave), `webSocketClose`, `webSocketError`, SQL init/insert/list/prune, broadcast helpers, membership from attachments, join/leave sys messages, rate limiting with re-serialized attachment.
- [ ] **Step 2:** Run `npx tsc --noEmit`; expect clean.
- [ ] **Step 3:** Review against Review Focus: hibernation, no double-broadcast, escaping before insert.
- [ ] **Step 4:** Commit `feat: implement ChatRoom Durable Object`.

### Task 3: Worker router + SVG + page

**Files:** Create `src/index.ts`, `src/svg.ts`, `src/ui/page.ts`.

- [ ] **Step 1:** Implement router with all routes from design; validate before DO stub creation; proxy WS upgrade; `stub.fetch` for `/record` and `/svg`.
- [ ] **Step 2:** Implement `record2svg` with clamped params, XML escaping, `foreignObject` markup based on the reference.
- [ ] **Step 3:** Implement self-contained HTML page: nickname gate, status, message list (textContent), online list, send form, reconnect backoff, rename/leave controls.
- [ ] **Step 4:** Run `npx tsc --noEmit`; expect clean.
- [ ] **Step 5:** Commit `feat: add Worker routes, SVG chart and frontend page`.

### Task 4: README + end-to-end verification

**Files:** Create `README.md`.

- [ ] **Step 1:** Write README: project structure, local commands (`npm install`, `npm run dev`), deploy (`npm run deploy`, Cloudflare login, binding/migration), protocol, borrowed/adapted/omitted table, DO rationale + alternatives, security notes, word-list swap.
- [ ] **Step 2:** Run `npm test && npx tsc --noEmit`.
- [ ] **Step 3:** Run `npx wrangler dev` in background; use `curl` to check `/`, `/health`, `/filter`, `/room/@demo`, `/room/@demo/record`, `/room/@demo/svg`; check a WebSocket handshake if feasible with a small node script (tsx); stop the dev server.
- [ ] **Step 4:** Commit `docs: add README and verify local worker`.
