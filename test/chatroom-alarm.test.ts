import { test } from "node:test";
import assert from "node:assert/strict";
import { jitteredAlarmTime, countWords } from "../src/moderation.ts";
import { REVIEW_CRON } from "../src/config.ts";

test("jitteredAlarmTime 同房间同日稳定且落在时间窗内", () => {
  // Fixed "now": 2026-11-18 00:00:00 UTC. Base hour 3, window 120 min.
  const now = Date.UTC(2026, 10, 18, 0, 0, 0);
  const t1 = jitteredAlarmTime("demo", 3, now);
  const t2 = jitteredAlarmTime("demo", 3, now);
  assert.equal(t1, t2, "同一 roomId 同一时刻结果必须稳定");
  assert.ok(t1 > now, "结果必须是将来时刻");
  const base = Date.UTC(2026, 10, 18, 3, 0, 0);
  const jitterMs = REVIEW_CRON.jitterWindowMinutes * 60_000;
  const offset = t1 - base;
  assert.ok(offset >= 0 && offset <= jitterMs, `offset ${offset} 应落在 0..${jitterMs}`);

  const other = jitteredAlarmTime("other-room", 3, now);
  assert.notEqual(other, t1, "不同房间应尽量分散到不同时刻");
});

test("countWords 统计词频并过滤空词", () => {
  assert.deepEqual(countWords(["a", "b", "a", "", "  ", "c", "c", "c"]), [
    ["c", 3],
    ["a", 2],
    ["b", 1],
  ]);
});
