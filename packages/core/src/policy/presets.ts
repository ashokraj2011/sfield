/** Policy presets (§9.1). Effects describe business impact only. */
import type { Effect } from "../types/common.js";
import type { HostLimits } from "../types/options.js";
import type { ToolDefinition } from "../types/tool.js";

export type PolicyPreset = "read_only" | "supervised" | "bounded_auto";

const ALLOWED: Record<PolicyPreset, readonly Effect[]> = {
  read_only: ["read"],
  supervised: ["read", "write", "destructive"],
  bounded_auto: ["read", "write", "destructive"],
};

export function effectAllowed(preset: PolicyPreset, effect: Effect): boolean {
  return ALLOWED[preset].includes(effect);
}

export interface ApprovalDecision {
  required: boolean;
  reason: string;
}

/** Tool, preset, and host requirements are cumulative; the strictest wins. */
export function approvalRequired(preset: PolicyPreset, tool: ToolDefinition, limits: HostLimits): ApprovalDecision {
  if (tool.policy.requiresApproval) return { required: true, reason: "tool.requires_approval" };
  // Built-in memory writes are governed by user confirmation (§10.3), not by action approval.
  if (tool.source === "builtin") return { required: false, reason: "builtin" };
  const effect = tool.policy.effect;
  switch (preset) {
    case "read_only":
      return { required: false, reason: "read" };
    case "supervised":
      return effect === "read" ? { required: false, reason: "read" } : { required: true, reason: `preset supervised: every ${effect} call` };
    case "bounded_auto":
      if (effect === "destructive") return { required: true, reason: "preset bounded_auto: destructive" };
      if (effect === "write") {
        return limits.grants?.autonomousWrites ? { required: false, reason: "host grant autonomousWrites" } : { required: true, reason: "preset bounded_auto: writes need the host grant autonomousWrites" };
      }
      return { required: false, reason: "read" };
  }
}
