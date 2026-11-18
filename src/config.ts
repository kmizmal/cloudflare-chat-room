// 敏感词过滤与 AI 评审的全部可调参数。
// 用户决策：配置集中在此处，不使用 wrangler vars / secrets / .dev.vars。
// AI 默认关闭；上线启用时将 aiEnabled 改为 true 并重新 deploy。

export const MODERATION = {
  aiEnabled: false, // opt-in：本地零依赖零费用；线上手动开启
  model: "@cf/meta/llama-guard-3-8b",
  reviewMode: "hit-only" as const, // "hit-only" | "all"
  maxReviewChars: 500,
  timeoutMs: 5000,
  failOpen: true,
  unsafeAction: "censor" as const, // "censor" -> ***；"block" -> 丢弃、不入库不广播、报错
} as const;

export const REVIEW_CRON = {
  enabled: true,
  lookbackHours: 24,
  maxMessagesPerRoom: 100,
  extractionModel: "@cf/meta/llama-3.1-8b-instruct",
  minWordLength: 2,
  maxWordsPerRun: 20,
  minHitCount: 2,
  jitterWindowMinutes: 120,
} as const;
