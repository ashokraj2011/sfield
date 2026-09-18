/** Built-in interaction tools (§8.4, §10.3, §14.4). Selected separately from business tools; same pipeline. */
import type { ToolDefinition } from "../types/tool.js";
import { normalizeTool } from "./define-tool.js";

function builtin(spec: Parameters<typeof normalizeTool>[0]): ToolDefinition {
  // normalizeTool refuses built-in ids for user code; construct through a private path.
  const id = spec.id;
  const def = normalizeTool({ ...spec, id: `builtin_${id.replace(/\./g, "_")}`, adapter: "function", handler: async () => null }, { source: "builtin" });
  return { ...def, id, ref: `${id}@${def.version}`, handler: undefined, adapter: "builtin" };
}

export const ASK_USER: ToolDefinition = builtin({
  id: "ask_user",
  version: "1.0.0",
  description:
    "Ask the user one clarifying question and wait for their answer. Use only when the request is ambiguous or missing information you cannot obtain from tools. Do not use it to request permission for an action; approvals are handled separately.",
  inputs: {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: 1000 },
      response_type: { type: "string", enum: ["string", "boolean", "number"], description: "Expected answer type; defaults to string." },
      choices: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20, description: "Optional fixed choices for the answer." },
    },
  },
  outputs: {
    type: "object",
    additionalProperties: false,
    required: ["status", "value"],
    properties: {
      status: { type: "string", enum: ["answered", "pending", "expired"] },
      value: { type: ["string", "null"], description: "The answer as text (numbers and booleans are JSON-encoded)." },
    },
  },
  policy: { effect: "read", action: "input.request", classification: "internal", timeoutMs: 1000 },
});

export const MEMORY_REMEMBER: ToolDefinition = builtin({
  id: "memory.remember",
  version: "1.0.0",
  description:
    "Save a communication or service preference the user has explicitly asked to remember (for example 'always reply in Hindi'). Only call when the user directly requested it or confirmed it; the user will be asked to confirm. Never store secrets, credentials, balances, or business records.",
  inputs: {
    type: "object",
    additionalProperties: false,
    required: ["content"],
    properties: {
      content: { type: "string", minLength: 1, maxLength: 500, description: "The preference in one sentence." },
      key: { type: "string", pattern: "^[a-z][a-z0-9_.]{0,63}$", description: "Optional stable key such as language or contact_channel; a new value supersedes the old one." },
    },
  },
  outputs: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["saved", "confirmation_pending", "rejected"] },
      memory_id: { type: ["string", "null"] },
      reason: { type: ["string", "null"] },
    },
  },
  resource: { type: "memory", id: { literal: "subject" } },
  policy: { effect: "write", action: "memory.write", classification: "confidential", timeoutMs: 5000 },
});

export const MEMORY_FORGET: ToolDefinition = builtin({
  id: "memory.forget",
  version: "1.0.0",
  description: "Forget a previously saved preference by its memory id when the user asks to remove it.",
  inputs: {
    type: "object",
    additionalProperties: false,
    required: ["memory_id"],
    properties: { memory_id: { type: "string", minLength: 1, maxLength: 128 } },
  },
  outputs: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { type: "string", enum: ["forgotten", "not_found"] } },
  },
  resource: { type: "memory", id: { ref: "inputs.memory_id" } },
  policy: { effect: "write", action: "memory.forget", classification: "confidential", timeoutMs: 5000 },
});

export const BUILTIN_TOOLS: readonly ToolDefinition[] = Object.freeze([ASK_USER, MEMORY_REMEMBER, MEMORY_FORGET]);

export function isBuiltinTool(def: ToolDefinition): boolean {
  return def.source === "builtin";
}
