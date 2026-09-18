/** In-memory ArtifactStore for ephemeral deployments and tests (§17.4). */
import type { ArtifactRef, DataClassification } from "../types/common.js";
import type { ArtifactStore } from "../types/persistence.js";
import { SFieldError } from "../errors.js";
import { digestBytes, newId } from "../util/digest.js";

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, { bytes: Uint8Array; ref: ArtifactRef; tenantId: string; committed: boolean }>();

  async put(input: { bytes: Uint8Array; mediaType: string; classification: DataClassification; tenantId: string; runId?: string }): Promise<ArtifactRef> {
    const ref: ArtifactRef = { id: newId("art"), digest: digestBytes(input.bytes), bytes: input.bytes.byteLength, mediaType: input.mediaType, classification: input.classification };
    this.items.set(ref.id, { bytes: input.bytes, ref, tenantId: input.tenantId, committed: false });
    return ref;
  }

  async commit(ref: ArtifactRef, opts: { tenantId: string }): Promise<void> {
    const item = this.items.get(ref.id);
    if (item && item.tenantId === opts.tenantId) item.committed = true;
  }

  async get(ref: ArtifactRef, opts: { tenantId: string; maxBytes: number }): Promise<Uint8Array> {
    const item = this.items.get(ref.id);
    if (!item || item.tenantId !== opts.tenantId) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} is not available`);
    if (item.ref.digest !== ref.digest) throw new SFieldError("STATE_UNAVAILABLE", `artifact ${ref.id} digest mismatch`);
    if (item.bytes.byteLength > opts.maxBytes) throw new SFieldError("REQUEST_TOO_LARGE", `artifact ${ref.id} exceeds ${opts.maxBytes} bytes`);
    return item.bytes;
  }

  async delete(ref: ArtifactRef, opts: { tenantId: string }): Promise<void> {
    const item = this.items.get(ref.id);
    if (item && item.tenantId === opts.tenantId) this.items.delete(ref.id);
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.items.size;
  }
}
