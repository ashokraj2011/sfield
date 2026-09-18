/** Scripted model provider for deterministic runtime tests. */
import type { CompiledModelRequest, JsonObject, ModelBinding, ModelCapabilities, ModelProvider, ModelStreamError, ModelStreamEvent, NeutralModelRequest, NeutralPart, SFieldPlugin, StopReason, Usage } from "@sfield/core";
import { digestJson, stableBody } from "@sfield/core";

export interface ScriptedTurn {
  text?: string;
  /** Text streamed as deltas before the final message (defaults to `text`). */
  deltas?: string[];
  toolCalls?: Array<{ alias: string; arguments: JsonObject; id?: string }>;
  stopReason?: StopReason;
  stopSequence?: string;
  usage?: Partial<Usage>;
  error?: ModelStreamError;
  opaque?: JsonObject[];
  /** Milliseconds to wait before completing (cancellation tests). */
  delayMs?: number;
}

export type Script = ScriptedTurn[] | ((request: NeutralModelRequest, index: number) => ScriptedTurn);

export class FakeProvider implements ModelProvider {
  readonly id: string;
  readonly requests: NeutralModelRequest[] = [];
  readonly compiled: CompiledModelRequest[] = [];
  private index = 0;
  constructor(private script: Script, opts: { id?: string } = {}) {
    this.id = opts.id ?? "fake";
  }

  reset(script?: Script): void {
    this.index = 0;
    this.requests.length = 0;
    this.compiled.length = 0;
    if (script) this.script = script;
  }

  async describe(binding: ModelBinding): Promise<ModelCapabilities> {
    return {
      inputLimit: binding.limits.contextWindow,
      outputLimit: binding.limits.maxOutputTokens,
      toolUse: true,
      structuredOutput: "json_schema",
      strictTools: true,
      streamingUsage: true,
      media: [],
      opaqueContinuation: true,
      tokenCounting: "estimated",
      continueStopReason: true,
    };
  }

  async compile(request: NeutralModelRequest): Promise<CompiledModelRequest> {
    const tools = [...request.tools].sort((a, b) => (a.alias < b.alias ? -1 : 1));
    const aliasMap: Record<string, string> = {};
    for (const t of tools) aliasMap[t.alias] = t.ref;
    const body = stableBody({
      model: request.binding.model,
      instructions: request.instructions,
      messages: request.messages as unknown as JsonObject[],
      tools: tools.map((t) => ({ name: t.alias, description: t.description, parameters: t.inputSchema as JsonObject })),
      output: (request.outputSchema as JsonObject | undefined) ?? null,
      params: request.params as unknown as JsonObject,
    });
    const compiled: CompiledModelRequest = {
      provider: this.id,
      url: "fake://model",
      method: "POST",
      headers: {},
      body,
      aliasMap,
      overheadTokens: tools.reduce((n, t) => n + t.tokens, 0),
      degradations: [],
      equivalence: { toolsExact: true, schemaExact: true, notes: [] },
      digest: digestJson(body),
    };
    this.requests.push(request);
    this.compiled.push(compiled);
    return compiled;
  }

  async *stream(compiled: CompiledModelRequest, opts: { signal: AbortSignal; secrets?: { resolve(ref: { env: string } | { name: string }): Promise<string> }; binding?: ModelBinding }): AsyncIterable<ModelStreamEvent> {
    const request = this.requests[this.requests.length - 1]!;
    // Like a real adapter, resolve the credential when the client needs it (never logged).
    if (opts.binding?.credential && opts.secrets) await opts.secrets.resolve(opts.binding.credential).catch(() => undefined);
    const turn = typeof this.script === "function" ? this.script(request, this.index) : this.script[Math.min(this.index, this.script.length - 1)];
    this.index++;
    if (!turn) {
      yield { type: "error", error: { code: "PROVIDER_UNAVAILABLE", message: "script exhausted", retryable: false } };
      return;
    }
    if (turn.delayMs) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, turn.delayMs);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      if (opts.signal.aborted) {
        yield { type: "error", error: { code: "CANCELLED", message: "cancelled", retryable: false } };
        return;
      }
    }
    if (turn.error) {
      yield { type: "error", error: turn.error };
      return;
    }
    const deltas = turn.deltas ?? (turn.text !== undefined ? [turn.text] : []);
    for (const d of deltas) yield { type: "text_delta", text: d };
    const parts: NeutralPart[] = [];
    for (const o of turn.opaque ?? []) parts.push({ type: "opaque", provider: this.id, block: o });
    if (turn.text !== undefined) parts.push({ type: "text", text: turn.text });
    for (const [i, c] of (turn.toolCalls ?? []).entries()) parts.push({ type: "tool_call", callId: "", toolRef: "", alias: c.alias, arguments: c.arguments, providerCallId: c.id ?? `toolu_${this.index}_${i}` });
    const stopReason: StopReason = turn.stopReason ?? (turn.toolCalls?.length ? "tool_use" : "end_turn");
    const usage: Usage = { inputTokens: 120, outputTokens: 30, reported: true, ...(turn.usage ?? {}) };
    const done: ModelStreamEvent = { type: "done", message: { role: "assistant", parts }, stopReason, usage };
    if (turn.stopSequence !== undefined) done.stopSequence = turn.stopSequence;
    yield done;
  }
}

export function fakeProviderPlugin(provider: FakeProvider): SFieldPlugin {
  return {
    manifest: { id: `provider-${provider.id}`, version: "0.1.0", apiVersion: 1, coreCompatibility: "^0.1.0", buildDigest: "sha256:fakeprovider0000", requires: [] },
    register(r) {
      r.provider(provider);
    },
  };
}
