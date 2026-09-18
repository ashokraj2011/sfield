import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SField } from "@sfield/core";
import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { loadWiring } from "../wiring.js";
import { formatPublic, println, printJson, eprintln } from "../output.js";
import { openField } from "./shared.js";

export async function validate(args: ParsedArgs): Promise<number> {
  const wiring = await loadWiring(args);
  const report = await SField.validate(wiring.options);
  if (!report.ok) {
    eprintln(`configuration invalid (${report.errors.length} error${report.errors.length === 1 ? "" : "s"}):`);
    for (const e of report.errors) eprintln(`  ${formatPublic(e)}`);
    return 1;
  }
  if (flagBool(args.flags, "require-approved")) {
    const sf = await openField(args);
    try {
      const status = await sf.lock.status();
      if (!status.approved) {
        eprintln(`lock manifest ${status.digest} is not approved [LOCK_MANIFEST_UNAPPROVED]\n    → sfield lock approve ${status.digest}`);
        return 1;
      }
      println(`ok: ${status.digest} approved by ${status.approved.approver} at ${status.approved.decidedAt}`);
    } finally {
      await sf.close();
    }
    return 0;
  }
  if (flagBool(args.flags, "json")) printJson({ ok: true, digest: report.digest, notes: report.notes, agents: Object.keys(report.effective?.agents ?? {}), tools: Object.keys(report.effective?.lock.tools ?? {}) });
  else {
    println(`ok: ${report.digest}`);
    println(`  wiring: ${wiring.source}`);
    println(`  agents: ${Object.keys(report.effective?.agents ?? {}).join(", ") || "none"}`);
    println(`  tools:  ${Object.keys(report.effective?.lock.tools ?? {}).join(", ") || "none"}`);
    for (const n of report.notes) println(`  note: ${n.path} [${n.code}] ${n.message}`);
  }
  return 0;
}

export async function lockBuild(args: ParsedArgs): Promise<number> {
  const wiring = await loadWiring(args);
  const report = await SField.validate(wiring.options);
  if (!report.ok || !report.effective) {
    for (const e of report.errors) eprintln(`  ${formatPublic(e)}`);
    return 1;
  }
  const out = resolve(process.cwd(), flagString(args.flags, "out") ?? "sfield.lock.json");
  const lock = { ...report.effective.lock, createdAt: new Date().toISOString() };
  if (existsSync(out) && !flagBool(args.flags, "force")) {
    const prev = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(out, "utf8"))) as { configDigest?: string };
    if (prev.configDigest === lock.configDigest) {
      println(`unchanged: ${out} already pins ${lock.configDigest}`);
      return 0;
    }
  }
  writeFileSync(out, `${JSON.stringify(lock, null, 2)}\n`);
  println(`wrote ${out} (${Object.keys(lock.tools).length} tools, digest ${lock.configDigest})`);
  return 0;
}
