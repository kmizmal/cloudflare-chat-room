import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeRoomId,
  normalizeName,
  normalizeMessage,
  safeColor,
  escapeHtml,
  filterWords,
  rateLimited,
  DEFAULT_NAME_COLOR,
  MAX_MESSAGE,
  MAX_NAME,
  renameCooldown,
  escapeXml,
} from "../src/validation.ts";
import { record2svg, parseSvgParams } from "../src/svg.ts";

test("sanitizeRoomId accepts valid ids and rejects traversal/empty", () => {
  assert.equal(sanitizeRoomId("demo"), "demo");
  assert.equal(sanitizeRoomId("A_b-9"), "A_b-9");
  assert.equal(sanitizeRoomId("../etc"), null);
  assert.equal(sanitizeRoomId("a".repeat(33)), null);
  assert.equal(sanitizeRoomId(""), null);
  assert.equal(sanitizeRoomId("hello world"), null);
});

test("normalizeName strips control chars and enforces length", () => {
  assert.equal(normalizeName("  Alice\nBob  "), "AliceBob");
  assert.equal(normalizeName("   "), null);
  assert.equal(normalizeName(null), null);
  assert.equal([...normalizeName("字".repeat(40))!].length, MAX_NAME);
});

test("normalizeMessage rejects empty and caps length", () => {
  assert.equal(normalizeMessage("  hello  "), "hello");
  assert.equal(normalizeMessage("   "), null);
  assert.equal([...normalizeMessage("x".repeat(1200))!].length, MAX_MESSAGE);
  assert.equal(normalizeMessage(42), null);
});

test("safeColor falls back on invalid colors", () => {
  assert.equal(safeColor("#fff", DEFAULT_NAME_COLOR), "#fff");
  assert.equal(safeColor("#12345678", "#000"), "#12345678");
  assert.equal(safeColor("#12345", DEFAULT_NAME_COLOR), DEFAULT_NAME_COLOR);
  assert.equal(safeColor("red; background:url(x)", DEFAULT_NAME_COLOR), DEFAULT_NAME_COLOR);
});

test("escapeHtml neutralizes markup and quotes", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'y'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
  );
});

test("filterWords censors case-insensitively, longest first", () => {
  assert.equal(filterWords("you suck and ballshit", ["shit", "suck"]), "you *** and ball***");
  assert.equal(filterWords("nothing here", ["bad"]), "nothing here");
});

test("rateLimited blocks after 20 in window, allows again after window", () => {
  const ts: number[] = [];
  for (let i = 0; i < 20; i++) assert.equal(rateLimited(ts, 1000 + i), false);
  assert.equal(rateLimited(ts, 1019), true);
  assert.equal(rateLimited(ts, 11000), false); // old entries expired
});

test("renameCooldown blocks within cooldown and allows after", () => {
  const state = { lastRename: 0 };
  assert.equal(renameCooldown(state, 10_000), false);
  assert.equal(state.lastRename, 10_000);
  assert.equal(renameCooldown(state, 12_000), true);
  assert.equal(renameCooldown(state, 15_000), false);
});

test("escapeXml is safe inside SVG text and attributes", () => {
  const out = escapeXml(`</title><script>alert('x')</script>&`);
  assert.equal(out.includes("<script>"), false);
  assert.equal(out, "&lt;/title&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
});

test("parseSvgParams clamps hostile numeric input", () => {
  const p = parseSvgParams(new URLSearchParams("width=-9e99&height=abc&limit=9999&fontSize=0&theme=light"));
  assert.equal(p.width, 2000);
  assert.equal(p.height, 300);
  assert.equal(p.limit, 100);
  assert.equal(p.fontSize, 12);
  assert.equal(p.theme, "light");
});

test("record2svg escapes message text and title", () => {
  const svg = record2svg(
    [{ id: 1, uid: "u1", name: "<b>n</b>", text: "<script>x</script>", ts: 1794991363, namecolor: "#117743", msgcolor: "#3d3d3d" }],
    { width: 400, height: 200, limit: 20, theme: "", title: "<t>", fontSize: 12 },
    "demo",
  );
  assert.equal(svg.includes("<script>x"), false);
  assert.equal(svg.includes("&lt;script&gt;x&lt;/script&gt;"), true);
  assert.equal(svg.includes("<title>&lt;t&gt;</title>"), true);
  assert.equal(svg.includes("<b>n</b>"), false);
});
