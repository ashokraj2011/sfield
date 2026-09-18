import type { ParsedArgs } from "../args.js";
import { flagBool } from "../args.js";
import { loadWiring } from "../wiring.js";
import { println, printJson } from "../output.js";
import { SField } from "@sfield/core";

/** Reports missing bindings and unsupported guarantees without printing secrets (§4.7, §19.5). */
export async function doctor(args: ParsedArgs): Promise<number> {
  const wiring = await loadWiring(args);
  const report = await SField.validate(wiring.options);
  const findings: Array<{ level: "ok" | "warn" | "error"; text: string }> = [];
  findings.push({ level: "ok", text: `wiring: ${wiring.source}` });
  if (!report.ok) {
    for (const e of report.errors) findings.push({ level: "error", text: `${e.path ?? ""} [${e.code}] ${e.message}${e.suggestion ? ` → ${e.suggestion}` : ""}` });
    print(findings, flagBool(args.flags, "json"));
    return 1;
  }
  const sf = await SField.create({ ...wiring.options, quiet: true });
  try {
    const health = await sf.health();
    const cfg = sf.config.effective();
    findings.push({ level: health.ok ? "ok" : "warn", text: `health: ${health.ok ? "ok" : `degraded (${health.degraded.join(", ")})`}; deployment ${health.deployment}; digest ${health.configDigest}` });
    const components = sf.presetComponents;
    if (health.preset) {
      findings.push({ level: "warn", text: `development preset "${health.preset}" in use — not for production (§4.3)` });
      for (const [k, v] of Object.entries(components)) findings.push({ level: "warn", text: `  preset component ${k}: ${v}` });
    } else findings.push({ level: "ok", text: "no development preset components in use" });
    for (const m of Object.values(cfg.models)) findings.push({ level: "ok", text: `model ${m.id}: ${m.form === "binding" ? `host binding ${m.binding}` : `${m.provider} ${m.model}${m.base_url ? ` @ ${m.base_url}` : ""} (credential ${m.credential && "env" in m.credential ? `env ${m.credential.env}` : "host secret"})`}${m.fallback ? `, fallback ${m.fallback}` : ""}` });
    for (const s of Object.values(cfg.sources)) findings.push({ level: "ok", text: `source ${s.id}: ${s.form === "binding" ? `host binding ${s.binding}` : `${s.type} ${JSON.stringify(s.config)}`}` });
    for (const c of Object.values(cfg.connections)) findings.push({ level: "ok", text: `connection ${c.id}: ${c.base_url} (hosts ${c.allowed_hosts.join(", ")}; ${c.auth ? `${c.auth.type} auth` : "no auth"}; ${c.classification})` });
    findings.push({ level: "ok", text: `tools: ${Object.keys(cfg.lock.tools).join(", ") || "none"}` });
    for (const a of Object.values(cfg.agents)) findings.push({ level: "ok", text: `agent ${a.id}: model ${a.model}, preset ${a.policy.preset}, tools [${a.tools.join(", ")}], memory conversation=${a.memory.conversation} preferences=${a.memory.preferences}` });
    const mem = sf.memory.for().capabilities();
    findings.push({ level: "ok", text: `memory deletion: canonical ${mem.physical.canonical}, index ${mem.physical.index}, derived ${mem.physical.derived}; vectors ${mem.vectors ? "yes" : "no (exact listing)"}` });
    if (health.deployment !== "service") findings.push({ level: "warn", text: `deployment ${health.deployment}: single-process ownership; multi-replica coordination and shared rate-limit authority are not available (§17.1)` });
    const lock = await sf.lock.status();
    findings.push({ level: lock.approved || !lock.required ? "ok" : "error", text: `lock manifest ${lock.digest}: ${lock.approved ? `approved by ${lock.approved.approver}` : lock.required ? "approval required and missing" : "approval not required in this deployment"}` });
    for (const n of cfg.notes) findings.push({ level: "warn", text: `note ${n.path} [${n.code}] ${n.message}` });
    print(findings, flagBool(args.flags, "json"));
    return findings.some((f) => f.level === "error") ? 1 : 0;
  } finally {
    await sf.close();
  }
}

function print(findings: Array<{ level: string; text: string }>, json: boolean): void {
  if (json) printJson(findings);
  else for (const f of findings) println(`${f.level === "ok" ? "  ok  " : f.level === "warn" ? " warn " : " ERR  "} ${f.text}`);
}
