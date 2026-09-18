import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { println, printJson, table } from "../output.js";
import { openField } from "./shared.js";
import type { JsonValue } from "@sfield/core";

export async function contextExplain(args: ParsedArgs): Promise<number> {
  const id = args.positionals[2];
  if (!id) {
    println("usage: sfield context explain CONTEXT_ID");
    return 2;
  }
  const sf = await openField(args);
  try {
    const ex = await sf.context.explain({ contextId: id });
    if (flagBool(args.flags, "json")) {
      printJson(ex);
      return 0;
    }
    println(`context ${ex.contextId} for run ${ex.runId} (agent ${ex.agentId})`);
    println(`  budget: limit ${ex.budget.inputLimit}, output reserve ${ex.budget.outputReserve}, estimated input ${ex.budget.estimatedInput}${ex.budget.estimated ? " (estimated)" : ""}, safety margin ${ex.budget.safetyMargin}`);
    println("  included:");
    println(table(ex.included.map((b) => [`    ${b.kind}`, b.sourceIds.join(","), b.freshness, `${b.tokens} tok`, b.rank !== undefined ? `rank ${b.rank}` : "", b.transformation ?? ""])));
    println("  omitted:");
    for (const o of ex.omitted) println(`    ${o.sourceId}: ${o.reason}${o.tokens ? ` (${o.tokens} tok)` : ""}`);
    println("  tools:");
    for (const t of ex.tools) println(`    ${t.alias} → ${t.ref} (${t.tokens} tok${t.builtin ? ", builtin" : ""})`);
    return 0;
  } finally {
    await sf.close();
  }
}

export async function memoryList(args: ParsedArgs): Promise<number> {
  const sf = await openField(args);
  try {
    const principal = sf.devPrincipal;
    const subject = flagString(args.flags, "subject");
    const handle = sf.memory.for(subject && principal ? { ...principal, subjectId: subject } : undefined);
    const page = await handle.list({ kind: flagString(args.flags, "kind") as "preference" | "fact" | undefined, includeExpired: flagBool(args.flags, "all") }, { limit: Number(flagString(args.flags, "limit") ?? 50) });
    if (flagBool(args.flags, "json")) printJson(page);
    else println(table([["ID", "KIND", "STATUS", "ORIGIN", "EXPIRES", "CONTENT"], ...page.items.map((i) => [i.id, i.kind, i.status, i.origin, i.expiresAt.slice(0, 10), (i.structured ? `${i.structured.key}: ` : "") + i.content.slice(0, 60)])]));
    return 0;
  } finally {
    await sf.close();
  }
}

export async function memoryForget(args: ParsedArgs): Promise<number> {
  const id = args.positionals[2];
  if (!id) {
    println("usage: sfield memory forget MEMORY_ID");
    return 2;
  }
  const sf = await openField(args);
  try {
    const receipt = await sf.memory.for().forget({ id }, { idempotencyKey: `cli:${id}` });
    printJson(receipt);
    return receipt.count > 0 ? 0 : 1;
  } finally {
    await sf.close();
  }
}

export async function approvalsList(args: ParsedArgs): Promise<number> {
  const sf = await openField(args);
  try {
    const list = await sf.approvals.list({ status: flagBool(args.flags, "all") ? undefined : ["pending"] });
    if (flagBool(args.flags, "json")) printJson(list);
    else println(table([["ID", "RUN", "STATUS", "EXPIRES", "ACTION"], ...list.map((a) => [a.id, a.runId, a.status, a.expiresAt, a.view.map((v) => `${v.action} ${v.resource.type}:${v.resource.id}`).join("; ")])]));
    return 0;
  } finally {
    await sf.close();
  }
}

export async function approvalsDecide(args: ParsedArgs): Promise<number> {
  const id = args.positionals[2];
  const approve = flagBool(args.flags, "approve");
  const deny = flagBool(args.flags, "deny");
  if (!id || approve === deny) {
    println("usage: sfield approvals decide APPROVAL_ID --approve|--deny [--comment TEXT] [--resume]");
    return 2;
  }
  const sf = await openField(args);
  try {
    const principal = sf.devPrincipal;
    if (!principal) {
      println("approvals decide needs an authenticated actor; use the host API in production");
      return 1;
    }
    const rec = await sf.approvals.decide({ approvalId: id, actor: { tenantId: principal.tenantId, subjectId: principal.subjectId }, decision: approve ? "approve" : "deny", comment: flagString(args.flags, "comment") });
    println(`${rec.status}: ${rec.id} (run ${rec.runId})`);
    if (flagBool(args.flags, "resume")) {
      const handle = await sf.runs.resume({ runId: rec.runId });
      for await (const ev of handle.events()) if (ev.type === "text_delta") process.stdout.write(String(ev.payload["text"]));
      const result = await handle.result();
      println(`\nstate: ${result.state}`);
    } else {
      // The decision recorded a wake-up; let the in-process scheduler finish resuming before exit.
      const handle = await sf.runs.get({ runId: rec.runId });
      await handle.result();
      println(`run ${rec.runId} is now ${(await handle.snapshot()).state}`);
    }
    return 0;
  } finally {
    await sf.close();
  }
}

export async function inputsAnswer(args: ParsedArgs): Promise<number> {
  const id = args.positionals[2];
  const raw = flagString(args.flags, "value");
  if (!id || raw === undefined) {
    println('usage: sfield inputs answer REQUEST_ID --value <json>');
    return 2;
  }
  let value: JsonValue;
  try {
    value = JSON.parse(raw) as JsonValue;
  } catch {
    value = raw;
  }
  const sf = await openField(args);
  try {
    const principal = sf.devPrincipal;
    if (!principal) {
      println("inputs answer needs an authenticated actor; use the host API in production");
      return 1;
    }
    const rec = await sf.inputs.answer({ requestId: id, actor: { tenantId: principal.tenantId, subjectId: principal.subjectId }, value });
    const handle = await sf.runs.get({ runId: rec.runId });
    await handle.result();
    println(`answered ${rec.requestId}; run ${rec.runId} is now ${(await handle.snapshot()).state}`);
    return 0;
  } finally {
    await sf.close();
  }
}
