// Pure helpers: validation, escaping, word filtering, rate limiting.
// No Node.js dependencies — runs identically in Worker and node:test.

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}){1,2}$/;
export const DEFAULT_NAME_COLOR = "#117743";
export const DEFAULT_MSG_COLOR = "#3d3d3d";
export const MAX_NAME = 32;
export const MAX_MESSAGE = 1000;
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX_MESSAGES = 20;
export const RENAME_COOLDOWN_MS = 5_000;

export function sanitizeRoomId(raw: string | null | undefined): string | null {
  if (!raw || !ROOM_ID_RE.test(raw)) return null;
  return raw;
}

/** Strip control chars, trim, enforce length. Returns null for empty input. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, MAX_NAME).join("");
}

/** Trim and enforce message length; whitespace-only is rejected. */
export function normalizeMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, MAX_MESSAGE).join("");
}

export function safeColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_COLOR_RE.test(raw) ? raw : fallback;
}

/** HTML escape (reference project's `xss` equivalent, without Node deps). */
export function escapeHtml(source: string): string {
  return source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** XML escape for SVG output (already-escaped `&lt;` stays literal text). */
export function escapeXml(source: string): string {
  return escapeHtml(source);
}

export function randomUid(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Longest-match-first censor with `***`, like the reference fastscan filter. */
export function filterWords(source: string, words: readonly string[]): string {
  if (!words.length) return source;
  const sorted = [...words].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi",
  );
  return source.replace(pattern, "***");
}

/** Sliding-window rate limit. Mutates `recentTs` in the connection attachment. */
export function rateLimited(
  recentTs: number[],
  now: number,
  max: number = RATE_MAX_MESSAGES,
  windowMs: number = RATE_WINDOW_MS,
): boolean {
  while (recentTs.length && now - recentTs[0] >= windowMs) recentTs.shift();
  if (recentTs.length >= max) return true;
  recentTs.push(now);
  return false;
}

/** Rename cooldown: returns true (blocked) if renamed within cooldown. Mutates state. */
export function renameCooldown(
  state: { lastRename: number },
  now: number,
  cooldownMs: number = RENAME_COOLDOWN_MS,
): boolean {
  if (now - state.lastRename < cooldownMs) return true;
  state.lastRename = now;
  return false;
}
