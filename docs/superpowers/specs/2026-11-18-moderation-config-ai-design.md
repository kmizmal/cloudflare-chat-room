# 敏感词过滤配置化 + Workers AI 评审 — 设计

**日期：** 2026-11-18
**状态：** 已批准（用户 2026-11-18 确认四项决策）
**前置：** 原聊天室设计见 `2026-11-18-cloudflare-chat-room-design.md`

## Intent

在现有"词表命中 → `***`"的同步过滤之上，增加两层能力：

1. **配置集中化（方案 1）**：AI 开关、模型、模式、阈值、定时复核参数全部放在 `src/config.ts` 的导出常量里，类型安全、零外部配置、本地 `npm run dev` 开箱即用。用户明确否决了 wrangler 变量/secret 方案（维护 `.dev.vars`、改配置仍要 deploy 或 `secret put`，得不偿失）。
2. **Workers AI 评审 + 定时回写**：命中词表的消息送 AI 复核降低误杀；定时全量复核近期消息，用指令模型抽出违规词写回"动态词表"，让词库随实际流量自增长。

用户选择：配置 = 方案 1；AI 角色 = 命中后复核 + 定时全量复核回写敏感词规则。

## Goals

- AI 开关 / 模型 / 模式 / 阈值 / 定时参数全部代码常量化，`src/config.ts` 一处可改。
- 热路径：命中静态词表或动态词表 → 送 AI 复核 → `unsafe` 拦截/打码、`safe` 放行原文（消除纯词表的误杀）。
- 未命中词表的消息**不调用 AI**（省延迟与 Neuron 费用）。
- 定时全量复核：扫描近期消息 → 指令模型抽违规词 → 写入动态词表（可关闭、有上限）。
- AI 调用失败/超时时 fail-open（仍按词表打码），不影响聊天可用性。
- 保持 Hibernation 安全、零新增绑定（除 `[ai]` binding）。

## Non-goals

- 不引入 wrangler `[vars]` / secrets / `.dev.vars`（用户否决）。
- 不引入 KV / D1 / 外部向量库；动态词表放房间 DO 已有的 SQLite。
- 不做管理后台、人工审核队列、多语言模型切换 UI。
- 不把静态词表换成 148KB 上游词库（沿用现有起步词表 + 换词说明）。

## Constraints

- Workers AI 通过 `[ai] binding = "AI"` 暴露，`env.AI.run(model, inputs)` 调用；模型输出格式以 Context7 `/websites/developers_cloudflare_workers-ai` 为准。
- `llama-guard-3-8b` 输入 `messages[]`（须 user/assistant 交替），输出文本含 `safe`/`unsafe` + 类别码；不输出具体违规词 → 抽词需指令模型（`@cf/meta/llama-3.1-8b-instruct` + JSON mode）。
- Workers AI 限流：文本生成付费模型 20 rpm（标准计费）/ 50 rpm（预付费）；免费额度 10,000 Neurons/天，超出需 Paid。热路径只调命中消息，定时复核限制每房间条数，避免打爆。
- DO 单线程 + input gate：`await env.AI.run()` 期间该房间消息暂停投递，保证顺序；超时上限 5s（可配）。
- 当前 `compatibility_date = "2026-04-07"`；alarm 语义以此日期的运行时为准。

## Approaches considered

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 代码常量（方案 1）+ 动态词表存 DO SQLite | 零外部配置、零新基础设施、类型安全；改配置要 deploy | **采用** |
| wrangler `[vars]` / secrets 管配置 | 改配置不动代码，但要维护 `.dev.vars`/secret，仍是字符串 | 否决（用户嫌麻烦） |
| KV 存动态词表 + wrangler 变量管 AI | 运行时可读写词库，但多一层绑定与一致性问题 | 否决（DO SQLite 已够） |
| 定时结果只写日志、不回写词库 | 最简单，但不满足"回写敏感词规则" | 否决 |

## Architecture & decisions

### 1. `src/config.ts`（新增，纯常量）

```ts
export const MODERATION = {
  aiEnabled: false,  // opt-in：本地零依赖零费用；上线后手动改为 true
  model: "@cf/meta/llama-guard-3-8b",
  reviewMode: "hit-only" as const,   // hit-only | all
  maxReviewChars: 500,
  timeoutMs: 5000,
  failOpen: true,
  unsafeAction: "censor" as const,   // censor(***) | block(丢弃、不入库不广播，给发送者报错)
} as const;

export const REVIEW_CRON = {
  enabled: true,
  lookbackHours: 24,
  maxMessagesPerRoom: 100,
  extractionModel: "@cf/meta/llama-3.1-8b-instruct",
  minWordLength: 2,
  maxWordsPerRun: 20,
  minHitCount: 2,        // 至少被判违规 2 次才写入动态词表，抑制单次误判
  jitterWindowMinutes: 120, // 各房间 alarm 按 roomId 分散的窗口
} as const;
```

### 2. `src/moderation.ts`（新增，可测）

- `reviewText(text: string, ai: Ai, cfg): Promise<"safe" | "unsafe" | "error">`
  - 调 `ai.run(cfg.model, { messages: [{ role: "user", content: text }] })`。
  - 解析响应文本首行的 `safe` / `unsafe`；异常/超时返回 `"error"`。
  - `timeoutMs` 用 `AbortSignal.timeout`（Workers 运行时支持）传给 `ai.run` 的 options（若 binding 不支持 signal，则用 `Promise.race` 兜底）。
- `extractWords(text: string, ai: Ai, cfg): Promise<string[]>`
  - 调指令模型 + JSON mode，prompt 要求从给定违规消息中抽取"应加入词表的词/短语"，输出 `{"words":[...]}`。
  - 只保留长度 ≥ `minWordLength` 的项，最多 `maxWordsPerRun` 条。

依赖注入 `ai: Ai` 参数，便于 node:test 用假对象测试（不联网）。

### 3. DO SQLite 动态词表（`src/chatRoom.ts` 修改）

- constructor 的 `blockConcurrencyWhile` 中额外建表：
  ```sql
  CREATE TABLE IF NOT EXISTS dynamic_words (
    word TEXT PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )
  ```
- `private dynamicWords(): string[]`：`SELECT word FROM dynamic_words`，与 `BANWORDS` 合并后传给 `filterWords`。
- `private upsertWord(word: string, hits: number)`：`INSERT ... ON CONFLICT(word) DO UPDATE SET hits = hits + excluded.hits`。
- 热路径缓存：DO 内存里缓存词表 + `lastLoadedTs`，SQLite 读极快且休眠后重建，避免每条消息都查表；写入后失效缓存。
- **词库生命周期：永久保留**（用户决策）——`dynamic_words` 只增不减，不设 TTL、衰减或总量上限。被误判的词一旦累计到 `minHitCount` 会永久生效；README 需明确告知运维风险，并提供手动删词说明（`wrangler d1` 不适用，直接用 DO 存储管理或清空表）。
- 昵称过滤同样使用 `BANWORDS ∪ dynamicWords()`，但昵称**不送 AI 复核**（保持便宜）；改名分支亦然。
- 定时抽词的"原文"= 数据库中实际入库的文本（命中且判 unsafe 被改为 `***` 的消息，其原词本就在词表中，不需要再抽）。

### 4. 热路径（修改 `webSocketMessage` 的 `message` 分支）

```
raw = normalizeMessage(...)
effectiveWords = BANWORDS ∪ dynamicWords()
hit = filterWords(raw, effectiveWords) !== raw

if (hit && MODERATION.aiEnabled):
    verdict = await reviewText(raw, this.env.AI, MODERATION)
    if verdict === "unsafe": cleaned = unsafeAction === "censor" ? "***" : null(拒绝)
    else if verdict === "safe": cleaned = raw      // 保真，消除误杀
    else: cleaned = filterWords(raw, effectiveWords) // fail-open：仍打码
else:
    cleaned = filterWords(raw, effectiveWords)
```

`reviewMode: "all"` 时对未命中消息也评审（不推荐公开聊天室，文档说明代价）。

### 5. 定时全量复核（DO alarm，每房间自治）

选择 **DO alarm 而非 Worker cron**：alarm 天然知道"我是哪个房间"，不需要全局房间注册表（Worker 无状态、不想引入 KV）。

- 每条消息入库后：`if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(nextDailyTimestamp())`（每天固定 UTC 时刻，如 03:00）。
- `async alarm()`：
  1. 读最近 `lookbackHours` 小时内最多 `maxMessagesPerRoom` 条消息。
  2. 逐条 `reviewText`；对 `unsafe` 的原文 `extractWords` 抽词。
  3. 统计词频，把 `hits ≥ minHitCount` 的词 `upsertWord` 写入 `dynamic_words`，失效缓存。
  4. 重新 `setAlarm` 到次日同一时刻（按 roomId 派生确定性 jitter，把各房间分散到时间窗内，避免所有房间同时打爆 AI rpm；基准时刻仍可配）。
- 单次 alarm 总耗时/调用数设上限（按 `maxMessagesPerRoom`），避免撞上 AI rpm 限制；失败记录到 DO 日志，不影响热路径。
- **同步等待（用户决策）**：热路径 `await env.AI.run()` 期间该房间消息暂停投递，命中消息最多阻塞 `timeoutMs`（默认 5s）。接受此卡顿以换取实现简单与判定后才入库/广播的一致性。README 需说明该行为。

### 6. 配置与文档

- `wrangler.toml` 增加 `[ai] binding = "AI"`（本地 dev 由 wrangler 自动提供）。
- README 增加「敏感词过滤配置与 AI 评审」章节：说明改哪个常量、AI 花费/daily neurons、fail-open 行为、alarm 时区、如何关闭 AI。
- `.gitignore` 加入 `.codegraph/`。

## Testing strategy（TDD）

先写失败测试，再实现：

- `test/moderation.test.ts`
  - `reviewText` 解析 `safe` / `unsafe` / 异常 → `"error"`，用假 `ai.run` 注入。
  - `extractWords` 解析 JSON、过滤短词、截断到上限。
  - 合并词表后 `filterWords` 命中动态词。
- `test/validation.test.ts` 追加：动态词与静态词合并后的最长优先替换。
- 更新 `scripts/smoke.mjs`：验证 `[ai]` binding 缺失时热路径 fail-open 不崩（本地无 AI 时）。
- 全量 `npm test` + `npm run typecheck` + `wrangler deploy --dry-run` + 真浏览器两标签互通回归。

## Approved user decisions (2026-11-18)

| 问题 | 用户选择 |
| --- | --- |
| AI 是否阻塞房间 | **同步等待，接受卡顿**——命中最多阻塞 `timeoutMs`，实现简单、判定后才入库广播 |
| 动态词库生命周期 | **永久保留**——只增不减，无 TTL/衰减/上限；误判词一旦累计过阈值永久生效（README 警示并给手工删词方法） |
| 本地 AI 默认 | **默认关（opt-in）**——`aiEnabled:false`，部署前手动开启；本地零依赖零费用 |
| 「规则」形态 | **词/短语字符串**——`dynamic_words` 存字符串 + hits，命中即 `***`，与现有过滤一致 |

构建者自行决定（文档已吸收）：昵称也用合并词表但不过 AI；`block` = 丢弃不入库不广播并给发送者报错；alarm 按 roomId jitter；hits 跨次累计；抽词"原文"= 入库文本。

## What's left to the builder

- 精确解析 llama-guard 输出文本（以实测/模型文档为准），做好大小写与多余空白容错。
- `timeoutMs` 与 binding 是否接受 `signal` 需本地 dry-run 验证；不确定则用 `Promise.race`。
- alarm 时间戳跨时区/重复投递的幂等处理。
