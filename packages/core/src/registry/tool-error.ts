/** Error a trusted function handler may throw to report an explicit code and effect knowledge. */
import type { Effect } from "../types/common.js";

export class ToolError extends Error {
  readonly code: string;
  readonly effect: "none" | "confirmed" | "unknown" | undefined;
  readonly retryable: boolean;
  constructor(code: string, message?: string, opts: { effect?: "none" | "confirmed" | "unknown"; retryable?: boolean } = {}) {
    super(message ?? code);
    this.name = "ToolError";
    this.code = code;
    this.effect = opts.effect;
    this.retryable = opts.retryable ?? false;
  }
}

/** Default effect knowledge when a handler throws without saying (§9.6): reads had none, mutations are unknown. */
export function effectOnThrow(effect: Effect, err: unknown): "none" | "unknown" {
  if (err instanceof ToolError && err.effect === "none") return "none";
  return effect === "read" ? "none" : "unknown";
}
