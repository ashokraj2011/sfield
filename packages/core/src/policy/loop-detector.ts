/** Repeated-call detection (§14.2, §14.7). Per run; decisions are recorded in audit by the runtime. */
import type { Effect } from "../types/common.js";
import type { EffectiveAgentConfig } from "../config/types.js";
import type { LoopDetectorState } from "../types/runtime.js";

export type LoopVerdict =
  | { action: "execute"; poll?: boolean }
  | { action: "warn"; earlier: { callId: string; turn: number } }
  | { action: "fail"; earlier: { callId: string; turn: number }; code: "LOOP_DETECTED" | "REPEATED_CALL" };

export function emptyLoopState(): LoopDetectorState {
  return { seen: {}, warned: {}, pollCount: 0 };
}

export function callIdentity(toolRef: string, inputsDigest: string, resourceId: string): string {
  return JSON.stringify([toolRef, inputsDigest, resourceId]);
}

export class LoopDetector {
  constructor(
    private readonly config: EffectiveAgentConfig["runtime"]["loop_detection"],
    readonly state: LoopDetectorState,
  ) {}

  check(call: { identity: string; effect: Effect; pollable?: { minIntervalMs: number }; turn: number; now: number; callId?: string }): LoopVerdict {
    if (!this.config.enabled) return { action: "execute" };
    const entries = this.state.seen[call.identity] ?? [];
    const windowStart = call.turn - this.config.identical_call_window + 1;
    // A call re-prepared after a suspension must not be compared with its own earlier record.
    const recent = entries.filter((e) => e.turn >= windowStart && e.callId !== call.callId);
    if (recent.length === 0) return { action: "execute" };
    const last = recent[recent.length - 1]!;
    if (call.pollable && call.effect === "read") {
      const lastAt = Date.parse(last.at);
      if (call.now - lastAt >= call.pollable.minIntervalMs && this.state.pollCount < this.config.max_polls_per_run) {
        return { action: "execute", poll: true };
      }
    }
    const warned = this.state.warned[call.identity] ?? 0;
    const earlier = { callId: last.callId, turn: last.turn };
    if (warned === 0) {
      if (this.config.on_first === "fail") return { action: "fail", earlier, code: "LOOP_DETECTED" };
      return { action: "warn", earlier };
    }
    // Second repeat: mutations always fail; reads honor on_repeat.
    if (call.effect !== "read" || this.config.on_repeat === "fail") return { action: "fail", earlier, code: "LOOP_DETECTED" };
    return { action: "warn", earlier };
  }

  record(identity: string, turn: number, callId: string, now: number, opts: { warned?: boolean; poll?: boolean } = {}): void {
    if (opts.poll) this.state.pollCount++;
    if (opts.warned) this.state.warned[identity] = (this.state.warned[identity] ?? 0) + 1;
    else {
      const list = this.state.seen[identity] ?? [];
      if (list.some((e) => e.callId === callId)) return; // idempotent on re-preparation
      list.push({ turn, callId, at: new Date(now).toISOString() });
      // Keep only entries that can still fall inside any future window.
      this.state.seen[identity] = list.slice(-Math.max(this.config.identical_call_window, 1) * 2);
    }
  }
}
