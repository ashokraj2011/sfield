/** Known-value and key-name scrubbing (§18.2) and a stateful stream scanner (§18.3). */
import type { JsonValue } from "../types/common.js";

const SECRET_KEY_RE = /(^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|cookie|session[_-]?id)($|[_-])/i;

export class Scrubber {
  private values: string[] = [];
  private readonly source: (() => string[]) | undefined;
  /** `source` supplies values learned later (for example credentials resolved at dispatch time). */
  constructor(values: string[] = [], source?: () => string[]) {
    this.source = source;
    this.addValues(values);
  }
  refresh(): void {
    if (this.source) this.addValues(this.source());
  }
  addValues(values: string[]): void {
    for (const v of values) {
      if (typeof v === "string" && v.length >= 6 && !this.values.includes(v)) this.values.push(v);
    }
    this.values.sort((a, b) => b.length - a.length);
  }
  get known(): readonly string[] {
    return this.values;
  }
  scrubText(text: string): string {
    this.refresh();
    let out = text;
    for (const v of this.values) out = out.split(v).join("[REDACTED]");
    return out;
  }
  scrubValue(value: JsonValue, depth = 0): JsonValue {
    if (depth === 0) this.refresh();
    if (depth > 64) return "[TRUNCATED]";
    if (typeof value === "string") return this.scrubText(value);
    if (Array.isArray(value)) return value.map((v) => this.scrubValue(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : this.scrubValue(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}

/**
 * Stateful text scanner with bounded look-behind: emits text only once it can no longer be the prefix
 * of a known secret value, so a secret split across chunks is still withheld.
 */
export class StreamScanner {
  private pending = "";
  constructor(private readonly scrubber: Scrubber) {}
  feed(chunk: string): string {
    this.scrubber.refresh();
    const maxLen = Math.max(0, ...this.scrubber.known.map((v) => v.length));
    if (maxLen === 0) return chunk;
    this.pending += chunk;
    this.pending = this.scrubber.scrubText(this.pending);
    // Hold back the longest tail that is a proper prefix of any known value.
    let hold = 0;
    for (const v of this.scrubber.known) {
      for (let len = Math.min(v.length - 1, this.pending.length); len > hold; len--) {
        if (v.startsWith(this.pending.slice(this.pending.length - len))) {
          hold = len;
          break;
        }
      }
    }
    const emit = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return emit;
  }
  flush(): string {
    const out = this.scrubber.scrubText(this.pending);
    this.pending = "";
    return out;
  }
}
