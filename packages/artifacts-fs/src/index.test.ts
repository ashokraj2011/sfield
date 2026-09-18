import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsArtifacts } from "./index.js";

test("fs artifacts: put/commit/get verify digest and tenant; gc removes stale uncommitted uploads", async () => {
  const store = fsArtifacts({ root: mkdtempSync(join(tmpdir(), "sfield-art-")), orphanGraceMs: 10 });
  const bytes = new TextEncoder().encode("hello");
  const ref = await store.put({ bytes, mediaType: "text/plain", classification: "internal", tenantId: "t1" });
  assert.equal(ref.bytes, 5);
  await store.commit(ref, { tenantId: "t1" });
  assert.equal(new TextDecoder().decode(await store.get(ref, { tenantId: "t1", maxBytes: 100 })), "hello");
  await assert.rejects(store.get(ref, { tenantId: "t2", maxBytes: 100 }));
  await assert.rejects(store.get({ ...ref, digest: "sha256:0" }, { tenantId: "t1", maxBytes: 100 }));
  await assert.rejects(store.get(ref, { tenantId: "t1", maxBytes: 2 }));
  const orphan = await store.put({ bytes, mediaType: "text/plain", classification: "internal", tenantId: "t1" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await store.gc(), 1);
  await assert.rejects(store.get(orphan, { tenantId: "t1", maxBytes: 100 }));
  assert.equal(new TextDecoder().decode(await store.get(ref, { tenantId: "t1", maxBytes: 100 })), "hello", "committed artifact survives gc");
});
