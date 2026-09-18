/** Model gateway (§13): compile, dispatch with metered attempts, normalize, account. */
import type { SecretResolver, TelemetrySink } from "../types/options.js";
import type { CompiledModelRequest, ModelAttemptRecord, ModelBinding, ModelCapabilities, ModelProvider, ModelStreamError, NeutralMessage, NeutralModelRequest, StopReason, Usage } from "../types/model.js";
import { SFieldError } from "../errors.js";
import { sleep } from "../util/async.js";
import { nowIso } from "../util/digest.js";
import { costMicroUsd } from "./pricing.js";

export interface GatewayOptions {
  providers: Map<string, ModelProvider>;
  secrets: SecretResolver;
  telemetry?: TelemetrySink;
  /** Base backoff in ms for retryable transport failures. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

export interface DispatchOptions {
  runId: string;
  signal: AbortSignal;
  /** Allocates a new attempt id and reserves capacity; returns null when no further attempts are allowed. */
  beginAttempt: () => Promise<{ attemptId: string } | null>;
  onAttempt: (rec: ModelAttemptRecord) => Promise<void>;
  onDelta?: (text: string) => void;
  /** Emitted when a retry follows already-shown deltas (§13.4). */
  onReset?: () => void;
}

export interface DispatchResult {
  message: Extract<NeutralMessage, { role: "assistant" }>;
  stopReason: StopReason;
  stopSequence?: string;
  usage: Usage;
  attempts: ModelAttemptRecord[];
  costMicroUsd: number;
  costLabel: "priced" | "best_effort" | "unpriced";
  compiled: CompiledModelRequest;
}

export class ModelGateway {
  private readonly capabilities = new Map<string, ModelCapabilities>();
  constructor(private readonly opts: GatewayOptions) {}

  provider(id: string): ModelProvider {
    const p = this.opts.providers.get(id);
    if (!p) throw new SFieldError("UNKNOWN_BINDING", `model provider ${id} is not registered`);
    return p;
  }

  hasProvider(id: string): boolean {
    return this.opts.providers.has(id);
  }

  async describe(binding: ModelBinding): Promise<ModelCapabilities> {
    const key = `${binding.provider}:${binding.identity.id}:${binding.identity.revision}`;
    let caps = this.capabilities.get(key);
    if (!caps) {
      caps = await this.provider(binding.provider).describe(binding);
      this.capabilities.set(key, caps);
    }
    return caps;
  }

  compile(request: NeutralModelRequest): Promise<CompiledModelRequest> {
    return this.provider(request.binding.provider).compile(request);
  }

  async countTokens(request: NeutralModelRequest): Promise<number | null> {
    const provider = this.provider(request.binding.provider);
    if (!provider.countTokens) return null;
    const compiled = await provider.compile(request);
    try {
      return await provider.countTokens(compiled, { secrets: this.opts.secrets, binding: request.binding });
    } catch {
      return null;
    }
  }

  /**
   * Dispatches with bounded, separately metered transport attempts. Each attempt yields exactly one terminal
   * `done` or `error`. Partial streamed tool arguments never authorize execution: only the final message does.
   */
  async dispatch(request: NeutralModelRequest, opts: DispatchOptions): Promise<DispatchResult> {
    const provider = this.provider(request.binding.provider);
    const compiled = await provider.compile(request);
    const attempts: ModelAttemptRecord[] = [];
    let shownDeltas = false;
    let lastError: ModelStreamError | undefined;
    const backoff = this.opts.backoffMs ?? 500;
    const maxBackoff = this.opts.maxBackoffMs ?? 8000;
    for (let n = 1; ; n++) {
      if (opts.signal.aborted) throw new SFieldError("CANCELLED", "run cancelled", { runId: opts.runId });
      const attempt = await opts.beginAttempt();
      if (!attempt) {
        throw new SFieldError(lastError?.code === "CONTEXT_EXCEEDED" ? "CONTEXT_LIMIT" : "PROVIDER_UNAVAILABLE", lastError ? `${lastError.code}: ${lastError.message}` : "no provider attempts available", { runId: opts.runId, retryable: false, details: lastError ? { code: lastError.code, status: lastError.status ?? null } : undefined });
      }
      const started = Date.now();
      const rec: ModelAttemptRecord = { attemptId: attempt.attemptId, modelBindingId: request.binding.identity.id, model: request.binding.model, startedAt: nowIso(), durationMs: 0, status: "unknown", compiledDigest: compiled.digest };
      if (shownDeltas) opts.onReset?.();
      let done: Extract<Awaited<ReturnType<typeof collect>>, { type: "done" }> | undefined;
      let error: ModelStreamError | undefined;
      try {
        const result = await collect(provider.stream(compiled, { signal: opts.signal, attemptId: attempt.attemptId, secrets: this.opts.secrets, binding: request.binding }), (t) => {
          shownDeltas = true;
          opts.onDelta?.(t);
        });
        if (result.type === "done") done = result;
        else error = result.error;
      } catch (err) {
        error = { code: opts.signal.aborted ? "CANCELLED" : "PROVIDER_STREAM_ERROR", message: err instanceof Error ? err.message : String(err), retryable: !opts.signal.aborted };
      }
      rec.durationMs = Date.now() - started;
      if (done) {
        rec.status = "succeeded";
        rec.stopReason = done.stopReason;
        rec.usage = done.usage;
        const { cost, label } = costMicroUsd(done.usage, request.binding.prices);
        rec.costMicroUsd = cost;
        if (request.binding.prices) rec.priceVersion = request.binding.prices.version;
        if (done.usage.providerRequestId) rec.providerRequestId = done.usage.providerRequestId;
        attempts.push(rec);
        await opts.onAttempt(rec);
        this.opts.telemetry?.metric?.("sfield.model.attempt_ms", rec.durationMs, { provider: provider.id, status: "succeeded" });
        const out: DispatchResult = { message: done.message, stopReason: done.stopReason, usage: done.usage, attempts, costMicroUsd: attempts.reduce((s, a) => s + (a.costMicroUsd ?? 0), 0), costLabel: label, compiled };
        if (done.stopSequence !== undefined) out.stopSequence = done.stopSequence;
        return out;
      }
      lastError = error;
      rec.status = error?.code === "CANCELLED" ? "cancelled" : "failed";
      rec.error = error;
      // Unknown usage on a failed attempt stays conservative (§15.3): no usage recorded means the reservation is held.
      attempts.push(rec);
      await opts.onAttempt(rec);
      this.opts.telemetry?.metric?.("sfield.model.attempt_ms", rec.durationMs, { provider: provider.id, status: rec.status });
      if (!error || !error.retryable || opts.signal.aborted) {
        const code = error?.code === "CANCELLED" ? "CANCELLED" : error?.code === "CONTEXT_EXCEEDED" ? "CONTEXT_LIMIT" : error?.code === "PROVIDER_AUTH" ? "PROVIDER_UNAVAILABLE" : error?.code ?? "PROVIDER_UNAVAILABLE";
        throw new SFieldError(code, error ? `${error.code}: ${error.message}` : "provider failed", { runId: opts.runId, retryable: false, status: error?.status, details: { attempts: attempts.length, providerCode: error?.code ?? null } });
      }
      const wait = Math.min(maxBackoff, error.retryAfterMs ?? backoff * 2 ** (n - 1)) * (0.5 + Math.random() * 0.5);
      await sleep(wait, opts.signal).catch(() => undefined);
    }
  }
}

async function collect(
  stream: AsyncIterable<import("../types/model.js").ModelStreamEvent>,
  onDelta: (text: string) => void,
): Promise<{ type: "done"; message: Extract<NeutralMessage, { role: "assistant" }>; stopReason: StopReason; usage: Usage; stopSequence?: string } | { type: "error"; error: ModelStreamError }> {
  for await (const ev of stream) {
    if (ev.type === "text_delta") onDelta(ev.text);
    else if (ev.type === "done") return ev;
    else if (ev.type === "error") return ev;
  }
  return { type: "error", error: { code: "PROVIDER_STREAM_ERROR", message: "stream ended without a terminal event", retryable: true } };
}
