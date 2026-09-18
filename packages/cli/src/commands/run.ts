import type { ParsedArgs } from "../args.js";
import { flagBool, flagString } from "../args.js";
import { eprintln, println, printJson } from "../output.js";
import { openField } from "./shared.js";

export async function run(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub === "inspect") return runInspect(args);
  if (sub === "resume") return runResume(args);
  const agent = flagString(args.flags, "agent");
  const message = flagString(args.flags, "message") ?? args.positionals.slice(1).join(" ");
  if (!agent || !message) {
    println('usage: sfield run --agent <id> --message "..." [--conversation ID] [--json]');
    return 2;
  }
  const sf = await openField(args);
  try {
    const session = await sf.sessions.open({ agent, conversationId: flagString(args.flags, "conversation") });
    const handle = await session.send({ message: { text: message }, idempotencyKey: flagString(args.flags, "idempotency-key") });
    eprintln(`[sfield] run ${handle.id} (conversation ${session.conversationId})`);
    let streamed = false;
    for await (const ev of handle.events()) {
      if (ev.type === "text_delta") {
        process.stdout.write(String(ev.payload["text"]));
        streamed = true;
      } else if (ev.type === "generation_reset") {
        eprintln("\n[sfield] provider retry: output restarted");
      } else if (ev.type === "tool_started") eprintln(`[sfield] tool ${String(ev.payload["toolRef"])} started`);
      else if (ev.type === "tool_finished") eprintln(`[sfield] tool ${String(ev.payload["toolRef"])} ${String(ev.payload["status"])} (effect ${String(ev.payload["effect"])})`);
      else if (ev.type === "run_suspended" || ev.type === "reconciliation_required") eprintln(`[sfield] run parked: ${String(ev.payload["state"])}`);
    }
    const result = await handle.result();
    if (streamed) process.stdout.write("\n");
    if (flagBool(args.flags, "json")) printJson(result);
    else {
      println(`state: ${result.state}${result.error ? ` (${result.error.code}: ${result.error.message})` : ""}`);
      if (!streamed && result.output !== undefined) println(typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2));
      if (result.pending) println(`pending: approvals ${result.pending.approvals.join(", ") || "-"}; inputs ${result.pending.inputs.join(", ") || "-"}`);
      if (result.effects.length) println(`effects: ${result.effects.map((e) => `${e.toolRef} ${e.outcome} on ${e.resource.type}:${e.resource.id}`).join("; ")}`);
      println(`usage: ${result.usage.turns} turns, ${result.usage.modelCalls} model calls, ${result.usage.toolCalls} tool calls, ${result.usage.totalTokens} tokens (${result.usage.tokensReported ? "reported" : "estimated"}), cost ${result.usage.costMicroUsd} µUSD (${result.usage.costLabel})`);
      println(`run: ${handle.id}  (sfield run inspect ${handle.id})`);
    }
    return result.state === "completed" ? 0 : result.pending ? 3 : 1;
  } finally {
    await sf.close();
  }
}

export async function runInspect(args: ParsedArgs): Promise<number> {
  const runId = args.positionals[2];
  if (!runId) {
    println("usage: sfield run inspect RUN_ID");
    return 2;
  }
  const sf = await openField(args);
  try {
    const handle = await sf.runs.get({ runId });
    const snapshot = await handle.snapshot();
    const calls = await sf.audit.calls(runId);
    const attempts = await sf.audit.modelAttempts(runId);
    const events = await sf.audit.events(runId, 0);
    const audit = await sf.audit.read({ runId });
    const checkpoint = await sf.audit.checkpoint(runId);
    if (flagBool(args.flags, "json")) {
      printJson({ snapshot, calls, modelAttempts: attempts, events: events.events, audit, contextIds: checkpoint?.contextPacketIds ?? [] });
      return 0;
    }
    println(`run ${snapshot.runId}: ${snapshot.state} (agent ${snapshot.agentId}, config ${snapshot.configDigest})`);
    if (snapshot.error) println(`  error: [${snapshot.error.code}] ${snapshot.error.message}`);
    println(`  usage: ${JSON.stringify(snapshot.usage)}`);
    println(`  contexts: ${(checkpoint?.contextPacketIds ?? []).join(", ") || "-"}  (sfield context explain <id>)`);
    println("  model attempts:");
    for (const a of attempts) println(`    ${a.attemptId} ${a.model} ${a.status} ${a.stopReason ?? ""} ${a.usage ? `${a.usage.inputTokens}/${a.usage.outputTokens} tokens` : ""} ${a.costMicroUsd ?? 0} µUSD ${a.durationMs} ms`);
    println("  tool calls:");
    for (const c of calls) println(`    ${c.callId} ${c.toolRef} ${c.state} effect=${c.result?.effect ?? "-"} status=${c.result?.status ?? "-"}${c.result?.error ? ` error=${c.result.error.code}` : ""}${c.approvalId ? ` approval=${c.approvalId}` : ""}`);
    println("  events:");
    for (const e of events.events) println(`    #${e.seq} ${e.timestamp} ${e.type}`);
    println("  audit:");
    for (const a of audit) println(`    ${a.at} ${a.type}${a.callId ? ` ${a.callId}` : ""}`);
    return 0;
  } finally {
    await sf.close();
  }
}

export async function runResume(args: ParsedArgs): Promise<number> {
  const runId = args.positionals[2];
  if (!runId) {
    println("usage: sfield run resume RUN_ID");
    return 2;
  }
  const sf = await openField(args);
  try {
    const handle = await sf.runs.resume({ runId });
    for await (const ev of handle.events()) if (ev.type === "text_delta") process.stdout.write(String(ev.payload["text"]));
    const result = await handle.result();
    println(`\nstate: ${result.state}${result.error ? ` (${result.error.code}: ${result.error.message})` : ""}`);
    return result.state === "completed" ? 0 : 1;
  } finally {
    await sf.close();
  }
}
