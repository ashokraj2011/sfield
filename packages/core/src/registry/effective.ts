/** Effective tool selection (§8.4): intersection of registry, agent, host grants, principal grants, and revocations. */
import type { EffectiveAgentConfig } from "../config/types.js";
import type { HostLimits } from "../types/options.js";
import type { ToolDefinition } from "../types/tool.js";
import { ASK_USER, MEMORY_FORGET, MEMORY_REMEMBER } from "./builtins.js";
import type { ToolRegistry } from "./registry.js";

export interface EffectiveToolSet {
  business: ToolDefinition[];
  builtins: ToolDefinition[];
  excluded: Array<{ ref: string; reason: string }>;
  /** Alias -> ref for provider wire names. */
  aliases: Record<string, string>;
}

export interface EffectiveToolsInput {
  agent: EffectiveAgentConfig;
  registry: ToolRegistry;
  limits: HostLimits;
  hasInputTransport: boolean;
  /** Principal-level grants; absent means all agent tools. */
  principalGrants?: string[];
}

export function computeEffectiveTools(input: EffectiveToolsInput): EffectiveToolSet {
  const { agent, registry, limits } = input;
  const excluded: EffectiveToolSet["excluded"] = [];
  const revokedTools = new Set(limits.revocations?.tools ?? []);
  const hostTools = limits.grants?.tools;
  const business: ToolDefinition[] = [];
  for (const ref of agent.tools) {
    const def = registry.get(ref);
    if (!def) {
      excluded.push({ ref, reason: "not_registered" });
      continue;
    }
    if (revokedTools.has(ref) || revokedTools.has(def.id)) {
      excluded.push({ ref, reason: "revoked" });
      continue;
    }
    if (hostTools && !hostTools.includes(def.id) && !hostTools.includes(ref)) {
      excluded.push({ ref, reason: "host_grant" });
      continue;
    }
    if (input.principalGrants && !input.principalGrants.includes(def.id) && !input.principalGrants.includes(ref)) {
      excluded.push({ ref, reason: "principal_grant" });
      continue;
    }
    if (limits.grants?.effects && !limits.grants.effects.includes(def.policy.effect)) {
      excluded.push({ ref, reason: "effect_not_granted" });
      continue;
    }
    business.push(def);
  }
  // Above the maximum, selection is deterministic by configured order (pins first). Ranker plugins are a later extension.
  const max = Math.min(agent.context.max_tools, limits.maxExposedTools ?? Number.POSITIVE_INFINITY);
  if (business.length > max) {
    for (const def of business.splice(max)) excluded.push({ ref: def.ref, reason: "max_tools" });
  }
  const granted = new Set(limits.grants?.interactionTools ?? []);
  const builtins: ToolDefinition[] = [];
  if (input.hasInputTransport && granted.has("ask_user")) builtins.push(ASK_USER);
  else if (input.hasInputTransport) excluded.push({ ref: ASK_USER.ref, reason: "host_grant" });
  if (agent.memory.preferences === "explicit") {
    if (granted.has("memory.remember")) builtins.push(MEMORY_REMEMBER);
    else excluded.push({ ref: MEMORY_REMEMBER.ref, reason: "host_grant" });
    if (granted.has("memory.forget")) builtins.push(MEMORY_FORGET);
    else excluded.push({ ref: MEMORY_FORGET.ref, reason: "host_grant" });
  }
  const aliases: Record<string, string> = {};
  for (const def of [...business, ...builtins]) aliases[aliasFor(def, aliases)] = def.ref;
  return { business, builtins, excluded, aliases };
}

/** Stable provider wire alias for an exact version: dots become underscores; collisions get a version suffix (§13.2). */
export function aliasFor(def: ToolDefinition, taken: Record<string, string>): string {
  const base = def.id.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 56);
  if (!taken[base] || taken[base] === def.ref) return base;
  return `${base}_v${def.version.replace(/[^0-9A-Za-z]/g, "_")}`.slice(0, 64);
}
