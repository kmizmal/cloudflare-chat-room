import { DurableObject } from "cloudflare:workers";
import type { Env, ConnectionState, MessageRecord, RoomUser, ServerEvent, ClientEvent } from "./types";
import { serverSend } from "./types";
import {
  filterWords,
  mergeWords,
  normalizeMessage,
  normalizeName,
  rateLimited,
  renameCooldown,
  safeColor,
  DEFAULT_MSG_COLOR,
  DEFAULT_NAME_COLOR,
} from "./validation";
import { BANWORDS } from "./banwords";
import { MODERATION, REVIEW_CRON } from "./config";
import { countWords, decideCleaned, extractWords, jitteredAlarmTime, reviewText } from "./moderation";

type Row = [number, string, string, string, number, string, string];

export class ChatRoom extends DurableObject<Env> {
  private roomId = "default";
  private title = "";
  private wordCache: string[] | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every wake (including after hibernation), so keep it minimal and
    // block other events until the schema exists.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL,
          name TEXT NOT NULL,
          text TEXT NOT NULL,
          ts INTEGER NOT NULL,
          namecolor TEXT NOT NULL,
          msgcolor TEXT NOT NULL
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS dynamic_words (
          word TEXT PRIMARY KEY,
          hits INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        )`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/record") {
      const limit = clampInt(url.searchParams.get("limit"), 100, 1, 100);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
      const rows = this.listMessages(limit, offset);
      return json(rows);
    }

    if (url.pathname === "/svg") {
      // SVG generation lives in the Worker (no extra dependency here); expose
      // the raw rows for it via this internal endpoint.
      const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
      return json(this.listMessages(limit, 0));
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    this.roomId = url.searchParams.get("room") || "default";
    this.title = (url.searchParams.get("title") || "").slice(0, 100);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const uid = (url.searchParams.get("uid") || "").slice(0, 7) || "anon";
    // Upstream runs its word filter over nicknames too (but not the HTML
    // sanitizer: names are rendered with textContent).
    const name = filterWords(
      normalizeName(url.searchParams.get("name")) || `user_${Math.random().toString(36).slice(2, 7)}`,
      mergeWords(BANWORDS, this.dynamicWords()),
    );
    const state: ConnectionState = { uid, name, joinedAt: Date.now(), recentTs: [], lastRename: 0 };
    server.serializeAttachment(state);

    // Exclude this brand-new socket: it is already registered by acceptWebSocket().
    const isNewUid = !this.users(server).some((u) => u.uid === uid);
    const users = this.users();
    serverSend(server, {
      type: "init",
      you: { uid, name, joinedAt: state.joinedAt },
      users,
      recent: this.listMessages(50, 0).reverse(),
      roomId: this.roomId,
      title: this.title,
    });

    if (isNewUid) {
      this.broadcast({ type: "sys", text: `${name}(${uid}) join the chat.`, ts: Math.floor(Date.now() / 1000) });
    }
    this.broadcast({ type: "online", users: this.users() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let event: ClientEvent;
    try {
      event = JSON.parse(message) as ClientEvent;
    } catch {
      serverSend(ws, { type: "error", text: "Invalid message format." });
      return;
    }

    const state = ws.deserializeAttachment() as ConnectionState | null;
    if (!state) {
      serverSend(ws, { type: "error", text: "Connection state lost. Please reload." });
      return;
    }

    switch (event?.type) {
      case "message": {
        if (rateLimited(state.recentTs, Date.now())) {
          ws.serializeAttachment(state);
          serverSend(ws, { type: "error", text: "发送太快了，请稍后再试。" });
          return;
        }
        ws.serializeAttachment(state);
        const raw = normalizeMessage(event.text);
        if (!raw) {
          serverSend(ws, { type: "error", text: "消息不能为空或过长。" });
          return;
        }
        // Store the filtered text verbatim; escaping happens at every output
        // boundary (frontend uses textContent, SVG uses escapeXml). Escaping
        // here would double-encode for DOM consumers.
        const effectiveWords = mergeWords(BANWORDS, this.dynamicWords());
        const hit = filterWords(raw, effectiveWords) !== raw;
        const shouldReview = MODERATION.aiEnabled && ((MODERATION.reviewMode as string) === "all" || hit);
        const verdict = shouldReview
          ? await reviewText(raw.slice(0, MODERATION.maxReviewChars), this.env.AI, MODERATION)
          : "error";
        const cleaned = decideCleaned(raw, hit, verdict, MODERATION);
        if (cleaned === null) {
          serverSend(ws, { type: "error", text: "消息未通过审核。" });
          return;
        }
        const namecolor = safeColor(event.namecolor, DEFAULT_NAME_COLOR);
        const msgcolor = safeColor(event.msgcolor, DEFAULT_MSG_COLOR);
        const ts = Math.floor(Date.now() / 1000);
        const cursor = this.ctx.storage.sql.exec(
          `INSERT INTO messages (uid, name, text, ts, namecolor, msgcolor) VALUES (?, ?, ?, ?, ?, ?)`,
          state.uid,
          state.name,
          cleaned,
          ts,
          namecolor,
          msgcolor,
        );
        cursor.toArray();
        const id = this.lastInsertId();
        this.ctx.storage.sql.exec(
          `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)`,
        );
        if (REVIEW_CRON.enabled && !(await this.ctx.storage.getAlarm())) {
          await this.ctx.storage.setAlarm(
            jitteredAlarmTime(this.roomId, 3, Date.now(), REVIEW_CRON.jitterWindowMinutes),
          );
        }
        const record: MessageRecord = { id, uid: state.uid, name: state.name, text: cleaned, ts, namecolor, msgcolor };
        this.broadcast({ type: "msg", message: record });
        break;
      }
      case "rename": {
        const now = Date.now();
        if (renameCooldown(state, now)) {
          ws.serializeAttachment(state);
          serverSend(ws, { type: "error", text: "改名太频繁了。" });
          return;
        }
        const normalized = normalizeName(event.name);
        if (!normalized) {
          serverSend(ws, { type: "error", text: "昵称无效。" });
          return;
        }
        const name = filterWords(normalized, mergeWords(BANWORDS, this.dynamicWords()));
        const old = state.name;
        state.name = name;
        state.lastRename = now;
        ws.serializeAttachment(state);
        this.broadcast({ type: "rename", uid: state.uid, name });
        this.broadcast({ type: "sys", text: `${old}(${state.uid}) changed the name from ${old} to ${name}.`, ts: Math.floor(now / 1000) });
        this.broadcast({ type: "online", users: this.users() });
        break;
      }
      case "leave": {
        ws.close(1000, "leave");
        break;
      }
      default:
        serverSend(ws, { type: "error", text: "Unknown message type." });
    }
  }

  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      const since = Math.floor(now / 1000) - REVIEW_CRON.lookbackHours * 3600;
      const cursor = this.ctx.storage.sql.exec(
        "SELECT text FROM messages WHERE ts >= ? ORDER BY id DESC LIMIT ?",
        since,
        REVIEW_CRON.maxMessagesPerRoom,
      );
      const texts = Array.from(cursor.raw() as Iterable<[string]>).map(([text]) => text);
      const extracted: string[] = [];
      for (const text of texts) {
        const verdict = await reviewText(text, this.env.AI, MODERATION);
        if (verdict === "unsafe") {
          extracted.push(...(await extractWords(text, this.env.AI, REVIEW_CRON)));
        }
      }
      for (const [word, hits] of countWords(extracted)) {
        if (hits >= REVIEW_CRON.minHitCount) this.upsertWord(word, hits);
      }
      await this.ctx.storage.setAlarm(
        jitteredAlarmTime(this.roomId, 3, Date.now(), REVIEW_CRON.jitterWindowMinutes),
      );
    } catch (err) {
      console.error("moderation alarm failed", err);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const state = ws.deserializeAttachment() as (ConnectionState & { departed?: boolean }) | null;
    // Runtime auto-replies to close frames at compatibility_date >= 2026-04-07.
    if (!state) return;
    // webSocketError() may run before webSocketClose() for the same socket;
    // the attachment flag keeps the leave notice to exactly one broadcast.
    if (state.departed) return;
    state.departed = true;
    try {
      ws.serializeAttachment(state);
    } catch {
      // Socket already gone; the flag is best-effort.
    }
    // The closing socket can still be listed by getWebSockets(); exclude it so
    // the "last session for this uid" check is accurate.
    const stillConnected = this.users(ws).some((u) => u.uid === state.uid);
    if (!stillConnected) {
      this.broadcast({ type: "sys", text: `${state.name}(${state.uid}) leave the chat.`, ts: Math.floor(Date.now() / 1000) });
      this.broadcast({ type: "online", users: this.users(ws) });
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1006, "error", false);
  }

  private users(exclude?: WebSocket): RoomUser[] {
    const seen = new Set<string>();
    const result: RoomUser[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (exclude && ws === exclude) continue;
      const state = ws.deserializeAttachment() as ConnectionState | null;
      if (!state || seen.has(state.uid)) continue;
      seen.add(state.uid);
      result.push({ uid: state.uid, name: state.name, joinedAt: state.joinedAt });
    }
    return result;
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Ignore closing sockets.
      }
    }
  }

  private listMessages(limit: number, offset: number): MessageRecord[] {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT id, uid, name, text, ts, namecolor, msgcolor FROM messages ORDER BY id DESC LIMIT ? OFFSET ?`,
      limit,
      offset,
    );
    return Array.from(cursor.raw() as Iterable<Row>).map(([id, uid, name, text, ts, namecolor, msgcolor]) => ({
      id, uid, name, text, ts, namecolor, msgcolor,
    }));
  }

  private dynamicWords(): string[] {
    if (this.wordCache === null) {
      const cursor = this.ctx.storage.sql.exec("SELECT word FROM dynamic_words ORDER BY word");
      this.wordCache = Array.from(cursor.raw() as Iterable<[string]>).map(([word]) => word);
    }
    return this.wordCache;
  }

  private upsertWord(word: string, hits: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO dynamic_words (word, hits, created_at) VALUES (?, ?, ?)
       ON CONFLICT(word) DO UPDATE SET hits = hits + excluded.hits`,
      word,
      hits,
      Math.floor(Date.now() / 1000),
    );
    this.wordCache = null;
  }

  private lastInsertId(): number {
    const cursor = this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS id");
    const row = cursor.toArray()[0] as { id: number } | undefined;
    return Number(row?.id ?? 0);
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(Math.abs(n))));
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
