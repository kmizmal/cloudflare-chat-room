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
