/** CLI approval and input transports (§4.3): interactive in a terminal, otherwise print and park. */
import * as readline from "node:readline/promises";
import type { Actor, ApprovalTransport, ApprovalView, InputTransport, JsonObject, JsonValue } from "@sfield/core";

export interface CliIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
  interactive: boolean;
}

export function defaultIo(): CliIo {
  return { input: process.stdin, output: process.stderr, interactive: !!process.stdin.isTTY && !!process.stderr.isTTY };
}

function formatView(v: ApprovalView): string {
  const lines = [`  action:   ${v.action}`, `  tool:     ${v.toolRef} (${v.effect})`, `  resource: ${v.resource.type}:${v.resource.id}`];
  if (v.amount) lines.push(`  amount:   ${v.amount.value} ${v.amount.currency} (minor units)`);
  lines.push(`  args:     ${JSON.stringify(v.arguments)}`);
  return lines.join("\n");
}

async function ask(io: CliIo, prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: io.input as NodeJS.ReadableStream, output: io.output as NodeJS.WritableStream, terminal: false });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export function cliApprovalTransport(actor: Actor, io: CliIo = defaultIo()): ApprovalTransport {
  return {
    async request({ approval, views, decide }) {
      io.output.write(`\n[sfield] approval ${approval.id} requested (expires ${approval.expiresAt})\n${views.map(formatView).join("\n  ---\n")}\n`);
      if (!io.interactive) {
        io.output.write(`[sfield] non-interactive: the run is parked. Decide with: sfield approvals decide ${approval.id} --approve|--deny\n`);
        return;
      }
      const answer = await ask(io, "[sfield] approve? [y/N] ");
      const decision = /^y(es)?$/i.test(answer) ? "approve" : "deny";
      await decide(decision, actor, decision === "deny" && answer && !/^n(o)?$/i.test(answer) ? answer : undefined);
      io.output.write(`[sfield] ${decision === "approve" ? "approved" : "denied"}\n`);
    },
  };
}

export function cliInputTransport(actor: Actor, io: CliIo = defaultIo()): InputTransport {
  return {
    async request({ request, answer }) {
      const schema = request.responseSchema;
      io.output.write(`\n[sfield] question: ${request.question}\n`);
      if (!io.interactive) {
        io.output.write(`[sfield] non-interactive: the run is parked. Answer with: sfield inputs answer ${request.requestId} --value <json>\n`);
        return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await ask(io, promptFor(schema));
        const parsed = parseAnswer(schema, raw);
        if (parsed.ok) {
          try {
            await answer(parsed.value, actor);
            return;
          } catch (e) {
            io.output.write(`[sfield] ${(e as Error).message}\n`);
          }
        } else io.output.write(`[sfield] ${parsed.reason}\n`);
      }
      io.output.write("[sfield] no valid answer; the question stays pending\n");
    },
  };
}

function promptFor(schema: JsonObject): string {
  if (Array.isArray(schema["enum"])) return `[sfield] one of ${(schema["enum"] as JsonValue[]).map(String).join(" | ")}: `;
  if (schema["type"] === "boolean") return "[sfield] yes/no: ";
  if (schema["type"] === "number" || schema["type"] === "integer") return "[sfield] number: ";
  return "[sfield] answer: ";
}

export function parseAnswer(schema: JsonObject, raw: string): { ok: true; value: JsonValue } | { ok: false; reason: string } {
  if (Array.isArray(schema["enum"])) {
    const match = (schema["enum"] as JsonValue[]).find((c) => String(c).toLowerCase() === raw.toLowerCase());
    return match !== undefined ? { ok: true, value: match } : { ok: false, reason: "answer must be one of the listed choices" };
  }
  if (schema["type"] === "boolean") {
    if (/^(y|yes|true)$/i.test(raw)) return { ok: true, value: true };
    if (/^(n|no|false)$/i.test(raw)) return { ok: true, value: false };
    return { ok: false, reason: "answer yes or no" };
  }
  if (schema["type"] === "number" || schema["type"] === "integer") {
    const n = Number(raw);
    if (!Number.isFinite(n) || (schema["type"] === "integer" && !Number.isInteger(n))) return { ok: false, reason: "answer must be a number" };
    return { ok: true, value: n };
  }
  if (raw.length === 0) return { ok: false, reason: "answer cannot be empty" };
  return { ok: true, value: raw };
}
