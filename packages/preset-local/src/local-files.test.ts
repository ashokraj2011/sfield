import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFilesBinding, tokenize } from "./local-files.js";
import { parseAnswer } from "./cli-transports.js";

const principal = { tenantId: "local", subjectId: "developer", roles: [], attributes: {} };

test("local_files: indexes markdown by headings, ranks lexically, cites file and lines, reindexes on change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sfield-kb-"));
  mkdirSync(join(dir, "knowledge", "sub"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "refund-policy.md"), "# Refund policy\n\nRefunds are available within 30 days of delivery.\n\n# Exchanges\n\nExchanges are available within 60 days.\n");
  writeFileSync(join(dir, "knowledge", "sub", "shipping.txt"), "Shipping takes 3-5 business days.\n");
  writeFileSync(join(dir, "knowledge", "ignored.json"), "{}");
  const b = new LocalFilesBinding("policies", { path: "./knowledge" }, dir);
  const r = await b.search({ principal, text: "What is the refund policy?", filters: {}, maxItems: 3, maxBytes: 10000, signal: new AbortController().signal });
  assert.ok(r.items.length >= 1);
  assert.equal(r.items[0]!.citation.label, "refund-policy.md");
  assert.match(r.items[0]!.text, /30 days/);
  assert.match(r.items[0]!.citation.locator!, /^lines \d+-\d+$/);
  assert.ok(r.items[0]!.citation.uri!.startsWith("file://"));
  const ship = await b.search({ principal, text: "shipping days", filters: {}, maxItems: 1, maxBytes: 10000, signal: new AbortController().signal });
  assert.equal(ship.items[0]!.citation.label, "sub/shipping.txt");
  const none = await b.search({ principal, text: "zebra quantum", filters: {}, maxItems: 3, maxBytes: 10000, signal: new AbortController().signal });
  assert.equal(none.items.length, 0, "no match is an empty authorized result, not a failure");
  await new Promise((res) => setTimeout(res, 10));
  writeFileSync(join(dir, "knowledge", "refund-policy.md"), "# Refund policy\n\nRefunds are available within 45 days of delivery.\n");
  const again = await b.search({ principal, text: "refund policy", filters: {}, maxItems: 1, maxBytes: 10000, signal: new AbortController().signal });
  assert.match(again.items[0]!.text, /45 days/);
  assert.deepEqual(tokenize("The Refunds are processed!"), ["refund", "processed"]);
});

test("cli input parsing honours the response schema", () => {
  assert.deepEqual(parseAnswer({ type: "boolean" }, "y"), { ok: true, value: true });
  assert.deepEqual(parseAnswer({ type: "number" }, "4.5"), { ok: true, value: 4.5 });
  assert.equal(parseAnswer({ type: "integer" }, "4.5").ok, false);
  assert.deepEqual(parseAnswer({ type: "string", enum: ["red", "blue"] }, "Blue"), { ok: true, value: "blue" });
  assert.equal(parseAnswer({ type: "string" }, "").ok, false);
});
