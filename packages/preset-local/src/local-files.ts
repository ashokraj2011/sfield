/** `local_files` retrieval type (§4.3, §5.5): lexical search over a knowledge directory, no vectors. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue, RetrievalBinding, RetrievalQuery, RetrievalTypeFactory, RetrievedItem } from "@sfield/core";
import { digestJson, matchesAny } from "@sfield/core";

export interface LocalFilesConfig {
  path: string;
  include?: string[];
  max_file_bytes?: number;
  chunk_chars?: number;
}

interface Chunk {
  id: string;
  file: string;
  rel: string;
  version: string;
  text: string;
  tokens: string[];
  startLine: number;
  endLine: number;
  observedAt: string;
}

const DEFAULT_INCLUDE = ["**/*.md", "**/*.txt", "**/*.markdown"];
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with", "what", "how", "do", "does", "i", "my", "me", "it", "this", "that", "be", "can", "you", "your"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

export class LocalFilesBinding implements RetrievalBinding {
  readonly identity;
  private readonly root: string;
  private readonly include: string[];
  private readonly maxFileBytes: number;
  private readonly chunkChars: number;
  private index = new Map<string, { version: string; chunks: Chunk[] }>();

  constructor(
    readonly sourceId: string,
    config: LocalFilesConfig,
    configDir: string,
  ) {
    this.root = resolve(configDir, config.path);
    this.include = config.include ?? DEFAULT_INCLUDE;
    this.maxFileBytes = config.max_file_bytes ?? 1_000_000;
    this.chunkChars = config.chunk_chars ?? 1500;
    this.identity = { id: `retrieval:${sourceId}`, revision: digestJson({ path: this.root, include: this.include }).slice(7, 23), accountScope: this.root, classification: "internal" as const };
  }

  /** Walks the directory and refreshes chunks for changed files. */
  refresh(): void {
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const abs = join(dir, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(abs);
          continue;
        }
        const rel = relative(this.root, abs).split(sep).join("/");
        if (!matchesAny(rel, this.include) || st.size > this.maxFileBytes) continue;
        seen.add(rel);
        const version = `${st.mtimeMs}:${st.size}`;
        const existing = this.index.get(rel);
        if (existing && existing.version === version) continue;
        const text = readFileSync(abs, "utf8");
        this.index.set(rel, { version, chunks: this.chunk(rel, abs, version, text, st.mtime.toISOString()) });
      }
    };
    walk(this.root);
    for (const key of [...this.index.keys()]) if (!seen.has(key)) this.index.delete(key);
  }

  private chunk(rel: string, file: string, version: string, text: string, observedAt: string): Chunk[] {
    const lines = text.split(/\r?\n/);
    const chunks: Chunk[] = [];
    let buf: string[] = [];
    let start = 1;
    let size = 0;
    const flush = (end: number): void => {
      const body = buf.join("\n").trim();
      if (body.length) {
        chunks.push({ id: `${rel}#${chunks.length + 1}`, file, rel, version, text: body, tokens: tokenize(body), startLine: start, endLine: end, observedAt });
      }
      buf = [];
      size = 0;
      start = end + 1;
    };
    lines.forEach((line, i) => {
      const boundary = (/^#{1,6}\s/.test(line) && buf.length > 0) || size + line.length > this.chunkChars;
      if (boundary) flush(i);
      buf.push(line);
      size += line.length + 1;
    });
    flush(lines.length);
    return chunks;
  }

  async search(query: RetrievalQuery): Promise<{ items: RetrievedItem[]; partial: boolean }> {
    this.refresh();
    const terms = tokenize(query.text);
    const all = [...this.index.values()].flatMap((f) => f.chunks);
    if (all.length === 0) return { items: [], partial: false };
    const scored: Array<{ chunk: Chunk; score: number }> = [];
    if (terms.length === 0) {
      for (const chunk of all.slice(0, query.maxItems)) scored.push({ chunk, score: 0 });
    } else {
      const df = new Map<string, number>();
      for (const c of all) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
      const n = all.length;
      for (const chunk of all) {
        let score = 0;
        for (const t of new Set(terms)) {
          const tf = chunk.tokens.filter((x) => x === t).length;
          if (tf === 0) continue;
          const idf = Math.log(1 + n / (df.get(t) ?? 1));
          score += idf * (tf / (tf + 1.2 * (0.25 + 0.75 * (chunk.tokens.length / 200))));
        }
        if (score > 0) scored.push({ chunk, score });
      }
      scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    }
    let bytes = 0;
    const items: RetrievedItem[] = [];
    for (const { chunk, score } of scored) {
      if (items.length >= query.maxItems) break;
      const size = Buffer.byteLength(chunk.text, "utf8");
      if (bytes + size > query.maxBytes && items.length > 0) break;
      bytes += size;
      items.push({
        id: chunk.id,
        sourceId: this.sourceId,
        sourceVersion: chunk.version,
        title: chunk.rel,
        text: chunk.text,
        citation: { label: chunk.rel, uri: pathToFileURL(chunk.file).href, locator: `lines ${chunk.startLine}-${chunk.endLine}` },
        classification: "internal",
        observedAt: chunk.observedAt,
        score,
        aclEvidence: "local_files:developer",
      });
    }
    return { items, partial: scored.length > items.length };
  }

  async authorizeItem(): Promise<boolean> {
    return true; // local development knowledge is readable by the local principal
  }
}

export const localFilesRetrievalType: RetrievalTypeFactory = {
  type: "local_files",
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1 },
      include: { type: "array", items: { type: "string", minLength: 1 } },
      max_file_bytes: { type: "integer", minimum: 1 },
      chunk_chars: { type: "integer", minimum: 100 },
    },
  },
  substitutableFields: ["path"],
  create(sourceId: string, config: Record<string, JsonValue>, ctx: { configDir: string }): RetrievalBinding {
    return new LocalFilesBinding(sourceId, config as unknown as LocalFilesConfig, ctx.configDir);
  },
};
