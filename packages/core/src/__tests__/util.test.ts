import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../util/jcs.js";
import { parseRefPath, resolveBinding, OMIT } from "../util/refs.js";
import { Scrubber, StreamScanner } from "../util/scrub.js";
import { parseSSE } from "../util/sse.js";
import { globToRegExp } from "../util/glob.js";
import { applySelect } from "../schema/select.js";
import { checkSchemaSubset } from "../schema/subset.js";
import { sharedValidator } from "../schema/validator.js";
import { LoopDetector, emptyLoopState } from "../policy/loop-detector.js";
import { shortenForModel } from "../pipeline/views.js";
import { SFieldError } from "../errors.js";

test("JCS canonicalization sorts keys, preserves arrays, and normalizes numbers", () => {
  assert.equal(canonicalize({ b: 1, a: [3, { z: null, y: "x" }], c: -0 }), '{"a":[3,{"y":"x","z":null}],"b":1,"c":0}');
  assert.equal(canonicalize({ "é": 1, e: 2, "Z": 3 }), '{"Z":3,"e":2,"é":1}');
  assert.equal(canonicalize(1e21), "1e+21");
  assert.throws(() => canonicalize(Number.NaN));
});

test("reference paths accept dot properties and fixed indices, reject operators and prototype keys", () => {
  assert.deepEqual(parseRefPath("inputs.items[0].id"), { root: "inputs", segments: ["items", 0, "id"] });
  assert.deepEqual(parseRefPath("inputs.items.0"), { root: "inputs", segments: ["items", 0] });
  for (const bad of ["inputs.*", "inputs[*]", "inputs.a()", "inputs.__proto__", "inputs.a b", "inputs.a+b", "${env:X}"]) {
    assert.throws(() => parseRefPath(bad), (e: unknown) => SFieldError.is(e, "INVALID_REFERENCE"), bad);
  }
});

test("resolveBinding: missing values fail unless omit is permitted; empty string and null are not missing", () => {
  const roots = { inputs: { a: "", b: null, c: { d: 1 } } };
  assert.equal(resolveBinding({ ref: "inputs.a" }, roots, { field: "f", allowOmit: true }), "");
  assert.equal(resolveBinding({ ref: "inputs.b" }, roots, { field: "f", allowOmit: true }), null);
  assert.equal(resolveBinding({ ref: "inputs.c.d" }, roots, { field: "f", allowOmit: true }), 1);
  assert.throws(() => resolveBinding({ ref: "inputs.zz" }, roots, { field: "f", allowOmit: true }), (e: unknown) => SFieldError.is(e, "MISSING_REFERENCE"));
  assert.equal(resolveBinding({ ref: "inputs.zz", onMissing: "omit" }, roots, { field: "f", allowOmit: true }), OMIT);
  assert.throws(() => resolveBinding({ ref: "inputs.zz", onMissing: "omit" }, roots, { field: "f", allowOmit: false }), (e: unknown) => SFieldError.is(e, "INVALID_REFERENCE"));
  assert.throws(() => resolveBinding({ ref: "secrets.x" }, roots, { field: "f", allowOmit: true, allowedRoots: ["inputs"] }), (e: unknown) => SFieldError.is(e, "INVALID_REFERENCE"));
  assert.deepEqual(resolveBinding({ literal: { k: 1 } }, roots, { field: "f", allowOmit: true }), { k: 1 });
});

test("stream scanner withholds a secret split across chunks and scrubs key names", () => {
  const scrubber = new Scrubber(["sk-abcdef123456"]);
  const scanner = new StreamScanner(scrubber);
  const out = scanner.feed("token: sk-abc") + scanner.feed("def123456 done") + scanner.flush();
  assert.equal(out, "token: [REDACTED] done");
  const clean = new StreamScanner(scrubber);
  assert.equal(clean.feed("hello ") + clean.feed("world") + clean.flush(), "hello world");
  assert.deepEqual(scrubber.scrubValue({ api_key: "x", nested: { password: "y", ok: "sk-abcdef123456" } }), { api_key: "[REDACTED]", nested: { password: "[REDACTED]", ok: "[REDACTED]" } });
});

test("SSE parser handles multi-line data, CRLF, split chunks, and the byte cap", async () => {
  const text = "event: a\r\ndata: 1\r\ndata: 2\r\n\r\n: comment\ndata: {\"x\":1}\n\ndata: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  async function* chunks(size: number): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
  }
  const got = [];
  for await (const m of parseSSE(chunks(3), { maxBytes: 10000 })) got.push(m);
  assert.deepEqual(got, [{ event: "a", data: "1\n2" }, { data: '{"x":1}' }, { data: "[DONE]" }]);
  await assert.rejects((async () => { for await (const _m of parseSSE(chunks(50), { maxBytes: 10 })) void _m; })(), /exceeded 10 bytes/);
});

test("glob conversion", () => {
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(globToRegExp("**/*.md").test("c.md"));
  assert.ok(!globToRegExp("*.md").test("a/c.md"));
  assert.ok(globToRegExp("docs/{a,b}/*.txt").test("docs/b/x.txt"));
});

test("outputs.select keeps only named fields including dot paths", () => {
  assert.deepEqual(applySelect({ id: 1, tier: "gold", meta: { a: 1, b: 2 }, extra: true }, ["id", "meta.a"]), { id: 1, meta: { a: 1 } });
});

test("schema subset: closed objects required; unsupported keywords, network refs, and object bounds rejected", () => {
  assert.deepEqual(checkSchemaSubset({ type: "object", additionalProperties: false, properties: { a: { type: "string", format: "date-time" }, b: { type: ["integer", "null"] } }, required: ["a"] }), []);
  const issues = checkSchemaSubset({ type: "object", properties: { a: { type: "string" } }, allOf: [], minProperties: 1 });
  const codes = issues.map((i) => `${i.path}:${i.code}`);
  assert.ok(codes.some((c) => c.includes("additionalProperties")));
  assert.ok(codes.some((c) => c.includes("allOf")));
  assert.ok(codes.some((c) => c.includes("minProperties")));
  assert.ok(checkSchemaSubset({ type: "object", additionalProperties: false, properties: { a: { $ref: "https://example.com/x.json" } } }).length > 0);
  assert.ok(checkSchemaSubset({ type: "object", additionalProperties: false, properties: { a: { type: "string", format: "phone" } } }).length > 0);
  assert.deepEqual(checkSchemaSubset({ $defs: { id: { type: "string" } }, type: "object", additionalProperties: false, properties: { a: { $ref: "#/$defs/id" } } }), []);
});

test("validator applies declared defaults explicitly and reports paths", () => {
  const v = sharedValidator();
  const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" }, n: { type: "integer", default: 5 } } };
  const { value, inserted } = v.applyDefaults(schema, { a: "x" });
  assert.deepEqual(value, { a: "x", n: 5 });
  assert.deepEqual(inserted, ["n"]);
  const bad = v.validate(schema, { a: 1, extra: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.message.includes("extra")));
  assert.ok(bad.errors.some((e) => e.path === "a"));
});

test("loop detector: warn then fail within the window; polls exempt; mutations always fail on repeat", () => {
  const state = emptyLoopState();
  const d = new LoopDetector({ enabled: true, identical_call_window: 3, on_first: "warn", on_repeat: "warn", max_polls_per_run: 2 }, state);
  const now = Date.now();
  assert.equal(d.check({ identity: "x", effect: "read", turn: 1, now }).action, "execute");
  d.record("x", 1, "c1", now);
  const v2 = d.check({ identity: "x", effect: "read", turn: 2, now });
  assert.equal(v2.action, "warn");
  d.record("x", 2, "c2", now, { warned: true });
  // on_repeat warn is honored for reads
  assert.equal(d.check({ identity: "x", effect: "read", turn: 3, now }).action, "warn");
  // outside the window it is fresh again
  assert.equal(d.check({ identity: "x", effect: "read", turn: 5, now }).action, "execute");
  // mutations: second repeat always fails regardless of on_repeat
  d.record("m", 1, "m1", now);
  assert.equal(d.check({ identity: "m", effect: "write", turn: 2, now }).action, "warn");
  d.record("m", 2, "m2", now, { warned: true });
  assert.equal(d.check({ identity: "m", effect: "write", turn: 3, now }).action, "fail");
  // polls
  d.record("p", 1, "p1", now - 5000);
  const poll = d.check({ identity: "p", effect: "read", pollable: { minIntervalMs: 2000 }, turn: 2, now });
  assert.deepEqual(poll, { action: "execute", poll: true });
  d.record("p", 2, "p2", now - 4000, { poll: true });
  d.record("p", 3, "p3", now - 3000, { poll: true });
  assert.equal(d.check({ identity: "p", effect: "read", pollable: { minIntervalMs: 2000 }, turn: 4, now }).action, "warn", "poll ceiling reached");
});

test("shortenForModel labels partial excerpts", () => {
  const big = { data: "x".repeat(5000) };
  const s = shortenForModel(big, 1000);
  assert.equal(s.partial, true);
  assert.ok(JSON.stringify(s.content).length <= 1100);
  assert.deepEqual(shortenForModel({ a: 1 }, 1000), { content: { a: 1 }, partial: false });
});
