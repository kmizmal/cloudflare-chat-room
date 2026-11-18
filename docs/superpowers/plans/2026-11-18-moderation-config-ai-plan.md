# 敏感词过滤配置化 + Workers AI 评审 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI 评审与过滤配置收在代码常量里，命中词表才同步送 Workers AI 复核，并把定时复核抽出的违规词写回每房间 DO SQLite 的动态词表。

**Architecture:** 新增 `src/config.ts`（全部常量）与 `src/moderation.ts`（注入式、可测的 AI 判定/抽词封装）；`ChatRoom` 的 SQLite 增加 `dynamic_words` 表，热路径合并静态/动态词表后过滤，命中且 `aiEnabled` 时同步 `await` 判定（用户接受阻塞），定时靠 per-room DO alarm 抽词回写（永久保留、按 roomId jitter）；`[ai] binding` 加入配置，AI 默认关闭（opt-in）。

**Tech Stack:** TypeScript、Cloudflare Workers、Durable Objects（SQLite backend + Hibernation + alarm）、Workers AI binding（`@cf/meta/llama-guard-3-8b` / `@cf/meta/llama-3.1-8b-instruct`）、node:test + tsx、wrangler 4.164、Miniflare。

**Spec:** `docs/superpowers/specs/2026-11-18-moderation-config-ai-design.md`（含用户四项决策与构建者自行决定项）

## Global Constraints

- 配置一律放 `src/config.ts` 常量——用户否决 wrangler `[vars]` / secrets / `.dev.vars`。
- `aiEnabled: false` 默认；部署启用需手动改代码并重新 deploy。
- AI 热路径**同步等待**（用户决策），超时上限 `MODERATION.timeoutMs`（默认 5000ms）；失败/超时 fail-open 仍按词表打码。
- 动态词表**永久保留**：只增不减，无 TTL / 衰减 / 上限；误判词一旦累计 `minHitCount` 永久生效，README 必须警示。
- 「规则」= 词/短语字符串 + hits；命中即 `***`，不做结构化规则。
- 不新增 KV / D1 / 外部服务；除 `[ai] binding = "AI"` 外无新绑定。
- 昵称同样过合并词表，但**不送 AI**；`block` 动作 = 丢弃、不入库不广播、给发送者 `error`。
- alarm 按 roomId 派生确定性 jitter 分散触发；hits 跨 run 累计（`upsert` 加 hits）。
- Context7 文档依据：`/websites/developers_cloudflare_workers-ai`（`env.AI.run` 调用、`messages[]` 输入、输出 `safe`/`unsafe`、JSON mode、限流/Neuron 计费）；以项目锁定 `wrangler@4.164.0` 与 `@cloudflare/workers-types@^5.20261117.1` 为准。

## Review Focus

| 输入/条件 | 期望行为 | 归属任务 |
| --- | --- | --- |
| AI 响应含 `unsafe` / `safe` / 非预期文本、抛异常 | 分别返回 `"unsafe"` / `"safe"` / `"error"`，异常不冒泡打断消息流 | Task 2 测试 |
| 抽词返回含短词/重复/超过上限 | 过滤长度 `< minWordLength`、去重、截断到 `maxWordsPerRun` | Task 2 测试 |
| `aiEnabled:false`（默认）时命中词表 | 不调用 AI，仍打码；本地开发零网络零费用 | Task 4 测试 + smoke |
| AI 判定超时/失败（`failOpen`） | 退回词表打码，消息仍入库广播 | Task 4 测试 |
| 动态词写入后新消息命中 | 即使不在静态表也被 `***`；重复 upsert 只加 hits | Task 3 + Task 4 测试 |
| `unsafeAction:"block"` | 消息丢弃、不入库、广播里没有、发送者收到 `error` | Task 4 测试 |
| 定时 alarm 扫描/抽词/回写 | 只处理窗口内消息；`hits >= minHitCount` 才写；写完重排 alarm | Task 5 测试 |

---

### Task 1: 配置常量与 AI 绑定

**Files:**
- Create: `src/config.ts`
- Modify: `src/types.ts`（`Env` 增加 `AI: Ai`）
- Modify: `wrangler.toml`（增加 `[ai] binding = "AI"`）
- Modify: `.gitignore`（增加 `.codegraph/`）

**Interfaces:**
- Produces: `MODERATION`（`aiEnabled`, `model`, `reviewMode`, `maxReviewChars`, `timeoutMs`, `failOpen`, `unsafeAction`）、`REVIEW_CRON`（`enabled`, `lookbackHours`, `maxMessagesPerRoom`, `extractionModel`, `minWordLength`, `maxWordsPerRun`, `minHitCount`），常量值逐字取自 spec §1。
- Consumes: `@cloudflare/workers-types` 的 `Ai` 类型。

- [ ] **Step 1: 新建 `src/config.ts`**

按 spec §1 逐字写出 `MODERATION`（`aiEnabled: false`、`model: "@cf/meta/llama-guard-3-8b"`、`reviewMode: "hit-only"`、`maxReviewChars: 500`、`timeoutMs: 5000`、`failOpen: true`、`unsafeAction: "censor"`）与 `REVIEW_CRON`（`enabled: true`、`lookbackHours: 24`、`maxMessagesPerRoom: 100`、`extractionModel: "@cf/meta/llama-3.1-8b-instruct"`、`minWordLength: 2`、`maxWordsPerRun: 20`、`minHitCount: 2`），用 `as const`。

- [ ] **Step 2: 修改 `src/types.ts` 的 `Env`**

增加 `AI: Ai;` 字段（从 `cloudflare:workers` 或全局类型取 `Ai`，以现有 types 文件风格为准）。

- [ ] **Step 3: 修改 `wrangler.toml` 与 `.gitignore`**

追加：
```toml
[ai]
binding = "AI"
```
`.gitignore` 增加 `.codegraph/` 一行。

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: 无错误（若本地 types 尚无 `Ai`，用 `env.AI` 的 `any` 兜底并在 README 注明）。

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/types.ts wrangler.toml .gitignore
git commit -m "feat: 集中过滤配置并接入 Workers AI binding

协作模型: hy4flash-free"
```

---

### Task 2: AI 判定与抽词封装（TDD）

**Files:**
- Create: `test/moderation.test.ts`
- Create: `src/moderation.ts`

**Interfaces:**
- Produces:
  - `reviewText(text: string, ai: Ai, cfg: { model: string; timeoutMs: number }): Promise<"safe" | "unsafe" | "error">`
  - `extractWords(text: string, ai: Ai, cfg: { extractionModel: string; minWordLength: number; maxWordsPerRun: number }): Promise<string[]>`
- Consumes: Task 1 的 `MODERATION` / `REVIEW_CRON`（仅类型Shape，不强制引用）。

- [ ] **Step 1: 写失败测试 `test/moderation.test.ts`**

用假 `ai: { run: async (model, inputs) => ... }` 注入（不联网）：
```ts
test("reviewText 识别 unsafe", ...)   // fake run 返回 { response: "unsafe\nS1" } → "unsafe"
test("reviewText 识别 safe", ...)     // 返回 { response: "safe" } → "safe"
test("reviewText 异常返回 error", ...) // run 抛错 → "error"
test("reviewText 非预期输出返回 error", ...) // { response: "unknown" } → "error"
test("extractWords 解析并过滤", ...)  // 返回 { response: '{"words":["坏词","x","坏词"]}' }，minWordLength=2, maxWordsPerRun=1 → ["坏词"]
test("extractWords 异常返回空数组", ...) // run 抛错 → []
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- test/moderation.test.ts`
Expected: FAIL（`Cannot find module './moderation'` 或函数未导出）。

- [ ] **Step 3: 实现 `src/moderation.ts`**

- `reviewText`：截断 `text` 到 cfg 限制由调用方负责；调 `ai.run(cfg.model, { messages: [{ role: "user", content: text }] })`；用 `Promise.race([call, timeout])` 实现超时（不依赖 binding 是否支持 signal）；解析 `String(result?.response ?? "").trim().split(/\s+/)[0].toLowerCase()` 为 `safe`/`unsafe`，其余 `"error"`；异常一律 `"error"`。
- `extractWords`：调 `ai.run(cfg.extractionModel, { messages: [{ role: "user", content: prompt }] })`，prompt 要求"从违规文本中抽取应加入词表的词或短语，只输出 JSON：{\"words\":[...]}"；解析 `response` 中 JSON 的 `words` 数组，过滤 `typeof w === "string" && [...w].length >= minWordLength`，去重后 `.slice(0, maxWordsPerRun)`；异常返回 `[]`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/moderation.test.ts`
Expected: 6 tests PASS。

- [ ] **Step 5: Commit**

```bash
git add src/moderation.ts test/moderation.test.ts
git commit -m "feat: 注入式 Workers AI 判定与抽词封装

协作模型: hy4flash-free"
```

---

### Task 3: DO SQLite 动态词表

**Files:**
- Modify: `src/chatRoom.ts`（constructor 建表、`dynamicWords()`、`upsertWord()`、内存缓存）
- Test: `test/chatroom-words.test.ts`（纯函数/EM 层可 extracted 到 `src/moderation.ts` 的 `mergeWords` 以便测；本任务在 Task 2 文件追加测试）

**Interfaces:**
- Produces: `mergeWords(staticWords: readonly string[], dynamic: readonly string[]): string[]`（放 `src/validation.ts`，去重合并——便于单测）。
- Consumes: `filterWords`（`src/validation.ts`）、`BANWORDS`（`src/banwords.ts`）。

- [ ] **Step 1: 写失败测试**

在 `test/validation.test.ts` 追加：
```ts
test("mergeWords 合并静态与动态词表并去重", () => {
  expect(mergeWords(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/validation.test.ts`
Expected: FAIL（`mergeWords is not a function`）。

- [ ] **Step 3: 实现 `mergeWords` 与 DO 动态词表**

- `src/validation.ts` 导出 `mergeWords`。
- `src/chatRoom.ts` 的 `blockConcurrencyWhile` 内追加建表：
  ```sql
  CREATE TABLE IF NOT EXISTS dynamic_words (
    word TEXT PRIMARY KEY,
    hits INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )
  ```
- `ChatRoom` 增加私有字段 `private wordCache: string[] | null = null;`。
- `private dynamicWords(): string[]`：若 `wordCache` 为 null，执行 `SELECT word FROM dynamic_words` 取 `raw().toArray()` 的字符串列存入缓存；返回该数组。
- `private upsertWord(word: string, hits: number): void`：执行 `INSERT INTO dynamic_words (word, hits, created_at) VALUES (?, ?, ?) ON CONFLICT(word) DO UPDATE SET hits = hits + excluded.hits`，参数 `word, hits, Math.floor(Date.now()/1000)`；执行后 `this.wordCache = null`。

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- test/validation.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/validation.ts src/chatRoom.ts test/validation.test.ts
git commit -m "feat: 房间 DO 增加动态词表存储与合并

协作模型: hy4flash-free"
```

---

### Task 4: 热路径接入评审（含默认关闭/fail-open/block）

**Files:**
- Modify: `src/chatRoom.ts`（`webSocketMessage` 的 `message` 与 `rename` 分支）
- Test: `test/chatroom-moderation.test.ts`（新文件，通过把评审决策抽成纯函数 `decideCleaned(raw, hit, cfg, verdict)` 放 `src/moderation.ts` 做单测；DO 集成由 smoke 覆盖）

**Interfaces:**
- Produces: `decideCleaned(raw: string, hit: boolean, verdict: "safe"|"unsafe"|"error", cfg: { aiEnabled: boolean; failOpen: boolean; unsafeAction: "censor"|"block" }): string | null`
  - `null` 表示丢弃（block）。
- Consumes: `reviewText`（Task 2）、`mergeWords` + `dynamicWords`（Task 3）、`MODERATION`（Task 1）。

- [ ] **Step 1: 写失败测试**

`test/chatroom-moderation.test.ts`：
```ts
test("未命中词表时不需 AI：原文保留", ...)       // hit=false → raw
test("命中但 AI 关闭：打码", ...)               // hit=true, aiEnabled=false → "***"
test("命中且 AI 判 safe：放行原文", ...)         // verdict safe → raw
test("命中且 AI 判 unsafe + censor：打码", ...)  // → "***"
test("命中且 AI 判 unsafe + block：丢弃", ...)   // → null
test("AI 失败且 failOpen=true：仍打码", ...)     // verdict error → "***"
test("AI 失败且 failOpen=false：丢弃", ...)      // → null
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/chatroom-moderation.test.ts`
Expected: FAIL（函数未导出）。

- [ ] **Step 3: 实现 `decideCleaned` 并接入热路径**

- `src/moderation.ts` 导出 `decideCleaned` 纯函数（按上表实现，不调用 AI）。
- `src/chatRoom.ts` 的 `message` 分支：
  1. `raw = normalizeMessage(event.text)`；空则报错返回。
  2. `const effectiveWords = mergeWords(BANWORDS, this.dynamicWords());`
  3. `const hit = filterWords(raw, effectiveWords) !== raw;`
  4. `const shouldReview = MODERATION.aiEnabled && (MODERATION.reviewMode === "all" || hit)`；若 `shouldReview`，调 `reviewText(raw.slice(0, MODERATION.maxReviewChars), this.env.AI, MODERATION)` 得 verdict；否则 verdict 固定 `"error"`（表示未评审，由 `decideCleaned` 按 `aiEnabled` 决定打码或放行）。
  5. `const cleaned = decideCleaned(raw, hit, verdict, MODERATION);`
  6. `if (cleaned === null)` → `serverSend(ws, { type: "error", text: "消息未通过审核。" })`，return（不入库不广播）。
  7. 其余入库/广播不变（`cleaned` 替换原 `filterWords(raw, BANWORDS)`）。
- `rename` 分支：名字过滤改为 `filterWords(name, mergeWords(BANWORDS, this.dynamicWords()))`，不调 AI。连接时的 `name` 同样合并（保持与改名一致）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 全部 PASS（含旧 11 项 + 新增）。

- [ ] **Step 5: 端到端冒烟**

Run: `npm run dev`（后台）+ `node scripts/smoke.mjs http://localhost:8787`
Expected: 18 项全过；默认 `aiEnabled:false` 下命中词仍 `***`，无 AI 网络调用。

- [ ] **Step 6: Commit**

```bash
git add src/moderation.ts src/chatRoom.ts test/chatroom-moderation.test.ts
git commit -m "feat: 热Path 命中词才同步送 AI 复核并支持 block

协作模型: hy4flash-free"
```

---

### Task 5: DO alarm 定时复核回写

**Files:**
- Modify: `src/chatRoom.ts`（`alarm()`、入库后 `setAlarm`、jitter 计算）
- Test: `test/chatroom-alarm.test.ts`（新文件）或把可测部分抽纯函数到 `src/moderation.ts`：`jitteredAlarmTime(roomId: string, baseUtcHour: number, now: number): number`、`countWords(words: string[]): Array<[string, number]>`。

**Interfaces:**
- Produces: `jitteredAlarmTime(roomId: string, baseUtcHour: number, now: number): number`；`countWords(words: string[]): Array<[string, number]>`。
- Consumes: `reviewText`、`extractWords`（Task 2）、`REVIEW_CRON`（Task 1）、`upsertWord`（Task 3）。

- [ ] **Step 1: 写失败测试**

```ts
test("jitteredAlarmTime 同房间同日稳定且落在时间窗内", ...)
test("countWords 统计词频并过滤空词", ...) // ["a","b","a"] → [["a",2],["b",1]]
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/chatroom-alarm.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现纯函数与 alarm**

- `src/moderation.ts` 导出两个纯函数：
  - `jitteredAlarmTime(roomId, baseUtcHour, now)`：对 roomId 做简单字符串 hash，取模得到 0–`REVIEW_CRON.jitterWindowMinutes`（新增常量，默认 120）分钟偏移；对 UTC 当天 `baseUtcHour:00` 加偏移，若结果 ≤ `now` 则加 24 小时（保证返回未来时刻）。
  - `countWords(words)`：过滤空串，返回按次数降序的 `[word, count][]`。
- `src/chatRoom.ts`：
  - 在 `message` 入库成功后：`if (REVIEW_CRON.enabled && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(jitteredAlarmTime(this.roomId, 3, Date.now()));`
  - `async alarm(): Promise<void>`：
    1. `SELECT text FROM messages WHERE ts >= ? ORDER BY id DESC LIMIT ?`（窗口 `now - lookbackHours*3600`，上限 `maxMessagesPerRoom`）。
    2. 逐条 `await reviewText(text, this.env.AI, MODERATION)`；仅 `"unsafe"` 的原文送 `extractWords(text, this.env.AI, REVIEW_CRON)`。
    3. 汇总所有词，`countWords` 后取 `count >= minHitCount` 的调用 `upsertWord(word, count)`。
    4. `await this.ctx.storage.setAlarm(jitteredAlarmTime(this.roomId, 3, Date.now()))` 重排。
    5. 整体 try/catch，异常仅 `console.error`，不抛出。
  - `REVIEW_CRON` 增加 `jitterWindowMinutes = 120`（同步更新 spec/config）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 全 PASS。

- [ ] **Step 5: dry-run 打包**

Run: `npx wrangler deploy --dry-run --outdir /tmp/build`
Expected: 成功，输出包体大小（AI binding 不报错）。

- [ ] **Step 6: Commit**

```bash
git add src/moderation.ts src/chatRoom.ts src/config.ts test/chatroom-alarm.test.ts docs/superpowers/specs/2026-11-18-moderation-config-ai-design.md
git commit -m "feat: DO alarm 定时全量复核并回写动态词表

协作模型: hy4flash-free"
```

---

### Task 6: 文档收尾与最终验证

**Files:**
- Modify: `README.md`（新增「敏感词过滤配置与 AI 评审」章节）
- Modify: `docs/superpowers/specs/2026-11-18-moderation-config-ai-design.md`（确认状态已批准）

**Interfaces:** 无新接口。

- [ ] **Step 1: README 增章**

写明：全部配置在 `src/config.ts`；`aiEnabled:false` 默认（本地零依赖零费用），上线改 true 并 `npm run deploy`；Workers AI 需登录 Cloudflare 且本地/线上均按 Neuron 计费（10,000 Neurons/天免费额度）；热路径命中才评审且**同步阻塞最多 timeoutMs**；fail-open 行为；动态词表永久保留（误判风险 + 手工删词警示）；`unsafeAction:"block"` 语义；alarm 每天按 roomId 抖动触发。更新文末「从参考项目借鉴 / 为 Workers 调整」表，补充本迭代。

- [ ] **Step 2: 全量验证**

Run:
```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run --outdir /tmp/build
```
Expected: 测试全绿、typecheck 干净、dry-run 成功。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 补充过滤配置与 AI 评审说明

协作模型: hy4flash-free"
```

- [ ] **Step 4: Push**

```bash
git push origin main
```
