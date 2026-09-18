/** Filesystem ArtifactStore (§17.4): immutable content by digest, committed manifests, GC of orphans. */
import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactRef, ArtifactStore, DataClassification } from "@sfield/core";
import { SFieldError, digestBytes, newId, nowIso } from "@sfield/core";

export interface FsArtifactsOptions {
  root: string;
  /** Uncommitted uploads older than this are removable by gc(); default 1 hour. */
  orphanGraceMs?: number;
}

interface Manifest {
  ref: ArtifactRef;
  tenantId: string;
  runId?: string;
  committed: boolean;
  createdAt: string;
}

const SAFE = /^[A-Za-z0-9_.-]{1,128}$/;

export class FsArtifactStore implements ArtifactStore {
  private readonly root: string;
  private readonly orphanGraceMs: number;
  constructor(opts: FsArtifactsOptions) {
    this.root = resolve(opts.root);
    this.orphanGraceMs = opts.orphanGraceMs ?? 3600_000;
  }

  private dir(tenantId: string): string {
    if (!SAFE.test(tenantId)) throw new SFieldError("INVALID_INPUT", "tenant id is not a safe path segment");
    return join(this.root, encodeURIComponent(tenantId));
  }

  private paths(tenantId: string, id: string): { bin: string; manifest: string } {
    if (!SAFE.test(id)) throw new SFieldError("INVALID_INPUT", "artifact id is not a safe path segment");
    const d = this.dir(tenantId);
    return { bin: join(d, `${id}.bin`), manifest: join(d, `${id}.json`) };
  }

  async put(input: { bytes: Uint8Array; mediaType: string; classification: DataClassification; tenantId: string; runId?: string }): Promise<ArtifactRef> {
    const ref: ArtifactRef = { id: newId("art"), digest: digestBytes(input.bytes), bytes: input.bytes.byteLength, mediaType: input.mediaType, classification: input.classification };
    const { bin, manifest } = this.paths(input.tenantId, ref.id);
    await mkdir(this.dir(input.tenantId), { recursive: true });
    await writeFile(bin, input.bytes, { flag: "wx" });
    const m: Manifest = { ref, tenantId: input.tenantId, committed: false, createdAt: nowIso() };
    if (input.runId) m.runId = input.runId;
    await writeFile(manifest, JSON.stringify(m), { flag: "wx" });
    return ref;
  }

  async commit(ref: ArtifactRef, opts: { tenantId: string; runId?: string }): Promise<void> {
    const m = await this.manifest(opts.tenantId, ref.id);
    if (!m) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} is not available`);
    if (m.ref.digest !== ref.digest) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} digest mismatch`);
    m.committed = true;
    if (opts.runId) m.runId = opts.runId;
    await writeFile(this.paths(opts.tenantId, ref.id).manifest, JSON.stringify(m));
  }

  async get(ref: ArtifactRef, opts: { tenantId: string; maxBytes: number }): Promise<Uint8Array> {
    const m = await this.manifest(opts.tenantId, ref.id);
    if (!m || m.tenantId !== opts.tenantId) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} is not available`);
    if (m.ref.digest !== ref.digest) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} digest mismatch`);
    if (m.ref.bytes > opts.maxBytes) throw new SFieldError("REQUEST_TOO_LARGE", `artifact ${ref.id} exceeds ${opts.maxBytes} bytes`);
    const bytes = await readFile(this.paths(opts.tenantId, ref.id).bin);
    if (digestBytes(bytes) !== ref.digest) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} content does not match its digest`);
    return bytes;
  }

  async delete(ref: ArtifactRef, opts: { tenantId: string }): Promise<void> {
    const { bin, manifest } = this.paths(opts.tenantId, ref.id);
    await rm(bin, { force: true });
    await rm(manifest, { force: true });
  }

  /** Removes uncommitted uploads older than the grace period (§17.4). Returns the number removed. */
  async gc(now = Date.now()): Promise<number> {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const tenant of await readdir(this.root)) {
      const dir = join(this.root, tenant);
      if (!(await stat(dir)).isDirectory()) continue;
      for (const file of await readdir(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const m = JSON.parse(await readFile(join(dir, file), "utf8")) as Manifest;
          if (!m.committed && now - Date.parse(m.createdAt) > this.orphanGraceMs) {
            await rm(join(dir, file), { force: true });
            await rm(join(dir, file.replace(/\.json$/, ".bin")), { force: true });
            removed++;
          }
        } catch {
          // unreadable manifest: leave it for inspection
        }
      }
    }
    return removed;
  }

  private async manifest(tenantId: string, id: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(this.paths(tenantId, id).manifest, "utf8")) as Manifest;
    } catch {
      return null;
    }
  }
}

export function fsArtifacts(opts: FsArtifactsOptions): FsArtifactStore {
  return new FsArtifactStore(opts);
}
