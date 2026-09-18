/** Effective configuration explanation with provenance (§5.2, §21.2). */
import type { JsonValue } from "../types/common.js";
import type { EffectiveConfig } from "./types.js";

export interface ExplainedField {
  path: string;
  value: JsonValue;
  source: string;
}

export function explainConfig(config: EffectiveConfig, agentId?: string): { digest: string; fields: ExplainedField[]; notes: EffectiveConfig["notes"]; lock: EffectiveConfig["lock"] } {
  const fields: ExplainedField[] = [];
  const roots: Array<[string, JsonValue]> = agentId
    ? [[`agents.${agentId}`, config.agents[agentId] as unknown as JsonValue]]
    : [
        ["models", config.models as unknown as JsonValue],
        ["connections", config.connections as unknown as JsonValue],
        ["sources", config.sources as unknown as JsonValue],
        ["tools", config.tools as unknown as JsonValue],
        ["agents", config.agents as unknown as JsonValue],
        ["extensions", config.extensions as unknown as JsonValue],
      ];
  for (const [root, value] of roots) collect(value, root, config.provenance, fields);
  const notes = agentId ? config.notes.filter((n) => n.path.startsWith(`agents.${agentId}`) || !n.path.startsWith("agents.")) : config.notes;
  return { digest: config.digest, fields, notes, lock: config.lock };
}

function collect(value: JsonValue | undefined, path: string, prov: Record<string, string>, out: ExplainedField[]): void {
  if (value === undefined) return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) out.push({ path, value, source: prov[path] ?? "computed" });
    for (const [k, v] of entries) collect(v as JsonValue, `${path}.${k}`, prov, out);
    return;
  }
  const display: JsonValue = typeof value === "string" && value.length > 200 ? `${value.slice(0, 197)}...` : value;
  out.push({ path, value: display, source: prov[path] ?? sourceFallback(path, prov) });
}

function sourceFallback(path: string, prov: Record<string, string>): string {
  // Sub-fields of a configured value inherit the parent's source (e.g. arrays, instruction files).
  const parts = path.split(".");
  while (parts.length > 1) {
    parts.pop();
    const p = parts.join(".");
    if (prov[p]) return prov[p]!;
    const arr = p.replace(/\[\d+\]$/, "");
    if (prov[arr]) return prov[arr]!;
  }
  return "computed";
}

export function formatExplanation(explained: ReturnType<typeof explainConfig>): string {
  const lines = [`digest: ${explained.digest}`];
  const width = Math.min(72, Math.max(...explained.fields.map((f) => f.path.length), 10));
  for (const f of explained.fields) {
    const v = typeof f.value === "string" ? f.value.replace(/\n/g, "\\n") : JSON.stringify(f.value);
    lines.push(`${f.path.padEnd(width)}  ${v}  (${f.source})`);
  }
  if (explained.notes.length) {
    lines.push("notes:");
    for (const n of explained.notes) lines.push(`  ${n.path} [${n.code}] ${n.message}`);
  }
  return lines.join("\n");
}
