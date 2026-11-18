import type { AiBinding } from "./types";

type ReviewCfg = { model: string; timeoutMs: number };
type ExtractCfg = {
  extractionModel: string;
  minWordLength: number;
  maxWordsPerRun: number;
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export async function reviewText(
  text: string,
  ai: AiBinding,
  cfg: ReviewCfg,
): Promise<"safe" | "unsafe" | "error"> {
  try {
    const call = ai.run(cfg.model, {
      messages: [{ role: "user", content: text }],
    }) as Promise<{ response?: unknown }>;
    const result = await withTimeout(call, cfg.timeoutMs, { response: "" });
    const first = String(result?.response ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    return first === "safe" || first === "unsafe" ? first : "error";
  } catch {
    return "error";
  }
}

/** Deterministic per-room alarm time: base UTC hour + hash jitter, always in the future. */
export function jitteredAlarmTime(roomId: string, baseUtcHour: number, now: number, jitterWindowMinutes = 120): number {
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) hash = (hash * 31 + roomId.charCodeAt(i)) | 0;
  const minutes = Math.abs(hash) % (jitterWindowMinutes + 1);
  const date = new Date(now);
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), baseUtcHour, 0, 0);
  const withJitter = base + minutes * 60_000;
  return withJitter <= now ? withJitter + 24 * 60 * 60_000 : withJitter;
}

/** Count word frequencies, dropping blanks, ordered by descending count. */
export function countWords(words: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const w of words) {
    if (typeof w !== "string" || w.trim() === "") continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

type DecideCfg = {
  aiEnabled: boolean;
  failOpen: boolean;
  unsafeAction: "censor" | "block";
};

/** Decide the stored/broadcast text after a word-list hit and optional AI verdict. */
export function decideCleaned(
  raw: string,
  hit: boolean,
  verdict: "safe" | "unsafe" | "error",
  cfg: DecideCfg,
): string | null {
  if (!hit) return raw;
  if (!cfg.aiEnabled) return "***";
  if (verdict === "safe") return raw;
  if (verdict === "unsafe") return cfg.unsafeAction === "block" ? null : "***";
  return cfg.failOpen ? "***" : null;
}

export async function extractWords(
  text: string,
  ai: AiBinding,
  cfg: ExtractCfg,
): Promise<string[]> {
  try {
    const prompt =
      '从违规文本中抽取应加入词表的词或短语，只输出 JSON：{"words":["词1","词2"]}\n文本：' +
      text;
    const call = ai.run(cfg.extractionModel, {
      messages: [{ role: "user", content: prompt }],
    }) as Promise<{ response?: unknown }>;
    const result = await call;
    const raw = result?.response;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const words = Array.isArray((parsed as any)?.words) ? (parsed as any).words : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of words) {
      if (typeof w !== "string" || [...w].length < cfg.minWordLength || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= cfg.maxWordsPerRun) break;
    }
    return out;
  } catch {
    return [];
  }
}
