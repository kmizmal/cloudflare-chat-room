import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCleaned } from "../src/moderation.ts";

const cfg = (over: Partial<Parameters<typeof decideCleaned>[3]> = {}) => ({
  aiEnabled: true,
  failOpen: true,
  unsafeAction: "censor" as const,
  ...over,
});

test("未命中词表时不需 AI：原文保留", () => {
  assert.equal(decideCleaned("normal", false, "error", cfg()), "normal");
});

test("命中但 AI 关闭：打码", () => {
  assert.equal(decideCleaned("bad", true, "error", cfg({ aiEnabled: false })), "***");
});

test("命中且 AI 判 safe：放行原文", () => {
  assert.equal(decideCleaned("bad", true, "safe", cfg()), "bad");
});

test("命中且 AI 判 unsafe + censor：打码", () => {
  assert.equal(decideCleaned("bad", true, "unsafe", cfg()), "***");
});

test("命中且 AI 判 unsafe + block：丢弃", () => {
  assert.equal(decideCleaned("bad", true, "unsafe", cfg({ unsafeAction: "block" })), null);
});

test("AI 失败且 failOpen=true：仍打码", () => {
  assert.equal(decideCleaned("bad", true, "error", cfg({ failOpen: true })), "***");
});

test("AI 失败且 failOpen=false：丢弃", () => {
  assert.equal(decideCleaned("bad", true, "error", cfg({ failOpen: false })), null);
});
