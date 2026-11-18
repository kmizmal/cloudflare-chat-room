import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewText, extractWords } from "../src/moderation.ts";

type FakeAi = {
  run: (model: string, inputs: unknown) => Promise<{ response: string }>;
};

function fakeAi(response: string): FakeAi {
  return { run: async () => ({ response }) };
}

const reviewCfg = { model: "@cf/meta/llama-guard-3-8b", timeoutMs: 1000 };
const extractCfg = {
  extractionModel: "@cf/meta/llama-3.1-8b-instruct",
  minWordLength: 2,
  maxWordsPerRun: 1,
};

test("reviewText 识别 unsafe", async () => {
  assert.equal(await reviewText("坏话", fakeAi("unsafe\nS1") as any, reviewCfg), "unsafe");
});

test("reviewText 识别 safe", async () => {
  assert.equal(await reviewText("正常内容", fakeAi("safe") as any, reviewCfg), "safe");
});

test("reviewText 异常返回 error", async () => {
  const ai = { run: async () => { throw new Error("boom"); } } as any;
  assert.equal(await reviewText("内容", ai, reviewCfg), "error");
});

test("reviewText 非预期输出返回 error", async () => {
  assert.equal(await reviewText("内容", fakeAi("unknown") as any, reviewCfg), "error");
});

test("extractWords 解析并过滤", async () => {
  const words = await extractWords(
    "违规文本",
    fakeAi('{"words":["坏词","x","坏词"]}') as any,
    extractCfg,
  );
  assert.deepEqual(words, ["坏词"]);
});

test("extractWords 异常返回空数组", async () => {
  const ai = { run: async () => { throw new Error("boom"); } } as any;
  assert.deepEqual(await extractWords("违规文本", ai, extractCfg), []);
});
