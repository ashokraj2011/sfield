/** `sfield eval --suite dir [--candidate digest] [--live] [--baseline REPORT_ID]`: an evaluation report bound to the candidate digest (§16.6, §25.3). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SField, newId } from "@sfield/core";
import type { EvalReportRecord, JsonObject, RunResult } from "@sfield/core";
import { FakeProvider, fakeProviderPlugin, type ScriptedTurn } from "@sfield/testing";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { loadWiring } from "../wiring.js";
import { eprintln, println, printJson } from "../output.js";

interface EvalCase {
  name: string;
  agent: string;
  message: string;
  expect: { state?: string; output_includes?: string[]; output_regex?: string; tools_called?: string[]; max_cost_microusd?: number };
  replay?: ScriptedTurn[];
}

interface Suite {
  id: string;
  dataset_version: string;
  cases: EvalCase[];
}

export async function evalCommand(args: ParsedArgs): Promise<number> {
  const suiteDir = flagString(args.flags, "suite");
  if (!suiteDir) {
    println("usage: sfield eval --suite <dir> [--candidate <digest>] [--live] [--baseline REPORT_ID]");
    return 2;
  }
  const suitePath = resolve(process.cwd(), suiteDir, "suite.yaml");
  if (!existsSync(suitePath)) {
    eprintln(`${suitePath} not found (expected suite.yaml with id, dataset_version, cases[])`);
    return 1;
  }
  const suite = parseYaml(readFileSync(suitePath, "utf8")) as Suite;
  const live = flagBool(args.flags, "live");
  const wiring = await loadWiring(args);
  const validation = await SField.validate(wiring.options);
  if (!validation.ok || !validation.effective) {
    eprintln("configuration invalid; run sfield validate");
    return 1;
  }
  const candidate = flagString(args.flags, "candidate") ?? validation.digest!;
  if (candidate !== validation.digest) {
    eprintln(`candidate ${candidate} does not match the compiled configuration ${validation.digest}`);
    return 1;
  }
  let options = { ...wiring.options, quiet: true };
  let provider: FakeProvider | undefined;
  if (!live) {
    // Replay: recorded model observations replace the provider; every model in the config is rebound to it.
    provider = new FakeProvider([{ text: "" }]);
    const cfg = validation.effective;
    const models: JsonObject = {};
    for (const m of Object.values(cfg.models)) models[m.id] = { provider: "fake", model: `replay:${m.model ?? m.binding ?? m.id}`, credential: { env: "SFIELD_REPLAY" } };
    const doc = typeof options.config === "string" ? (parseYaml(readFileSync(options.config, "utf8")) as JsonObject) : options.config;
    options = { ...options, config: { ...doc, models }, configDir: typeof options.config === "string" ? resolve(options.config, "..") : options.configDir, plugins: [...(options.plugins ?? []), fakeProviderPlugin(provider)], env: { ...(options.env ?? process.env), SFIELD_REPLAY: "replay" } as Record<string, string | undefined>, preset: options.preset === "local" ? "memory" : options.preset };
  }
  const sf = await SField.create(options);
  const results: Array<{ name: string; pass: boolean; verified: boolean; reasons: string[]; cost: number; latencyMs: number; state: string }> = [];
  try {
    for (const c of suite.cases) {
      const reasons: string[] = [];
      if (provider) provider.reset(c.replay ?? [{ text: "(no replay recorded for this case)" }]);
      const started = Date.now();
      let result: RunResult | undefined;
      try {
        const session = await sf.sessions.open({ agent: c.agent });
        const handle = await session.send({ message: { text: c.message } });
        result = await handle.result();
      } catch (e) {
        reasons.push(`run failed: ${(e as Error).message}`);
      }
      const latencyMs = Date.now() - started;
      const expectState = c.expect.state ?? "completed";
      if (result && result.state !== expectState) reasons.push(`state ${result.state} (expected ${expectState})`);
      const text = result?.output === undefined ? "" : typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      for (const s of c.expect.output_includes ?? []) if (!text.includes(s)) reasons.push(`output missing "${s}"`);
      if (c.expect.output_regex && !new RegExp(c.expect.output_regex).test(text)) reasons.push(`output does not match /${c.expect.output_regex}/`);
      if (c.expect.tools_called && result) {
        const calls = await sf.audit.calls(result.runId);
        for (const t of c.expect.tools_called) if (!calls.some((x) => x.toolRef === t || x.toolRef.startsWith(`${t}@`))) reasons.push(`tool ${t} not called`);
      }
      if (c.expect.max_cost_microusd !== undefined && result && result.usage.costMicroUsd > c.expect.max_cost_microusd) reasons.push(`cost ${result.usage.costMicroUsd} > ${c.expect.max_cost_microusd}`);
      const pass = reasons.length === 0;
      results.push({ name: c.name, pass, verified: pass && result?.state === "completed", reasons, cost: result?.usage.costMicroUsd ?? 0, latencyMs, state: result?.state ?? "error" });
      println(`${pass ? "PASS" : "FAIL"} ${c.name}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`);
    }
    const passRate = results.length ? results.filter((r) => r.pass).length / results.length : 0;
    const verifiedSuccessRate = results.length ? results.filter((r) => r.verified).length / results.length : 0;
    const totalCost = results.reduce((s, r) => s + r.cost, 0);
    const meanLatency = results.length ? results.reduce((s, r) => s + r.latencyMs, 0) / results.length : 0;
    const report: EvalReportRecord = {
      id: newId("eval"),
      suite: suite.id,
      datasetVersion: String(suite.dataset_version),
      candidateDigest: candidate,
      modelTargets: Object.values(validation.effective.models).map((m) => m.model ?? m.binding ?? m.id),
      mode: live ? "live" : "replay",
      passRate,
      verifiedSuccessRate,
      cases: { inline: results as unknown as JsonObject[] },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    };
    const baselineId = flagString(args.flags, "baseline");
    if (baselineId) {
      const baseline = await sf.lock.evalReports().get(baselineId);
      if (!baseline) {
        eprintln(`baseline report ${baselineId} not found`);
        return 1;
      }
      report.baselineDigest = baseline.candidateDigest;
      const bCases = ((baseline.cases as { inline?: Array<{ cost: number; latencyMs: number }> }).inline ?? []);
      const bCost = bCases.reduce((s, r) => s + r.cost, 0);
      const bLatency = bCases.length ? bCases.reduce((s, r) => s + r.latencyMs, 0) / bCases.length : 0;
      report.costDeltaRatio = bCost > 0 ? (totalCost - bCost) / bCost : 0;
      report.latencyDeltaRatio = bLatency > 0 ? (meanLatency - bLatency) / bLatency : 0;
    }
    await sf.lock.evalReports().put(report);
    const outDir = resolve(process.cwd(), suiteDir, "reports");
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `${report.id}.json`);
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    println(`report ${report.id}: pass ${(passRate * 100).toFixed(0)}%, verified ${(verifiedSuccessRate * 100).toFixed(0)}%, ${results.length} cases, mode ${report.mode}, candidate ${candidate}`);
    println(`wrote ${outFile}`);
    if (flagBool(args.flags, "json")) printJson(report);
    return passRate === 1 ? 0 : 1;
  } finally {
    await sf.close();
  }
}
