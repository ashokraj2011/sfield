import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { println, printJson } from "../output.js";
import { openField } from "./shared.js";

export async function configExplain(args: ParsedArgs): Promise<number> {
  const sf = await openField(args);
  try {
    const agent = flagString(args.flags, "agent");
    if (flagBool(args.flags, "json")) printJson(sf.config.explain(agent));
    else println(sf.config.explainText(agent));
  } finally {
    await sf.close();
  }
  return 0;
}

export async function lockApprove(args: ParsedArgs): Promise<number> {
  const digest = args.positionals[2];
  if (!digest) {
    println("usage: sfield lock approve <digest> [--eval-report ID] [--approver NAME] [--comment TEXT] [--no-baseline]");
    return 2;
  }
  const sf = await openField(args);
  try {
    const current = sf.config.digest();
    if (digest !== current) {
      println(`refusing: the running configuration compiles to ${current}, not ${digest}`);
      return 1;
    }
    const { record, changed } = await sf.lock.approve({ digest, approver: flagString(args.flags, "approver") ?? process.env["USER"] ?? "operator", comment: flagString(args.flags, "comment"), evalReportId: flagString(args.flags, "eval-report"), noBaseline: flagBool(args.flags, "no-baseline") });
    println(`${changed ? "approved" : "already approved"}: ${record.digest} by ${record.approver} at ${record.decidedAt}${record.evalReportId ? ` (evidence ${record.evalReportId})` : ""}`);
  } finally {
    await sf.close();
  }
  return 0;
}

export async function lockStatus(args: ParsedArgs): Promise<number> {
  const sf = await openField(args);
  try {
    printJson(await sf.lock.status());
  } finally {
    await sf.close();
  }
  return 0;
}
