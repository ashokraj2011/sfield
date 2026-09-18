/** Trusted function tool adapter (§8.3). Async timeouts are cooperative. */
import type { JsonObject, JsonValue } from "../types/common.js";
import type { AdapterExecutionContext, AdapterResult, PreparationContext, PreparedOperation, ToolAdapter, ToolDefinition, ToolHandler } from "../types/tool.js";
import { SFieldError, sanitizeMessage } from "../errors.js";
import { TimeoutError, withTimeout } from "../util/async.js";
import { ToolError, effectOnThrow } from "./tool-error.js";
import { OMIT } from "../util/refs.js";

export class FunctionAdapter implements ToolAdapter {
  readonly id = "function";
  readonly operationSchema = { type: "object", additionalProperties: false, properties: {} };
  private readonly handlers = new Map<string, { handler: ToolHandler; def: ToolDefinition }>();

  bind(def: ToolDefinition, handler: ToolHandler): void {
    this.handlers.set(def.ref, { handler, def });
  }

  has(ref: string): boolean {
    return this.handlers.has(ref);
  }

  async prepare(def: ToolDefinition, input: JsonObject, ctx: PreparationContext): Promise<PreparedOperation> {
    const resource = def.resource!;
    const id = ctx.resolve(resource.id, "resource.id");
    if (id === undefined || id === (OMIT as unknown)) throw new SFieldError("MISSING_REFERENCE", `resource id for ${def.ref} did not resolve`);
    return {
      adapter: "function",
      operation: { handler: def.ref },
      resource: { type: resource.type, id: String(id) },
      summary: { tool: def.ref, inputs: input },
    };
  }

  async execute(op: PreparedOperation, ctx: AdapterExecutionContext, inputs?: JsonObject): Promise<AdapterResult> {
    const ref = String(op.operation["handler"]);
    const bound = this.handlers.get(ref);
    if (!bound) {
      return { payloadValid: false, effect: "not_started", transport: { durationMs: 0, bytes: 0 }, error: { code: "TOOL_UNAVAILABLE", category: "availability", message: `no handler bound for ${ref}`, retryable: false } };
    }
    const started = Date.now();
    const effect = bound.def.policy.effect;
    try {
      const value = await withTimeout(
        ctx.timeoutMs,
        (signal) =>
          Promise.resolve(
            bound.handler(inputs ?? ((op.summary["inputs"] as JsonObject) ?? {}), {
              principal: ctx.principal,
              signal,
              callId: ctx.callId,
              attemptId: ctx.attemptId,
              runId: ctx.runId,
              logger: noopLogger,
            }),
          ),
        { label: `tool ${ref}`, parent: ctx.signal },
      );
      const payload = (value === undefined ? null : value) as JsonValue;
      const bytes = Buffer.byteLength(JSON.stringify(payload) ?? "null");
      if (bytes > ctx.maxOutputBytes) {
        return {
          payloadValid: false,
          effect: effect === "read" ? "none" : "confirmed",
          transport: { durationMs: Date.now() - started, bytes },
          error: { code: "INVALID_OUTPUT", category: "validation", message: `output of ${bytes} bytes exceeds max_output_bytes ${ctx.maxOutputBytes}`, retryable: false },
        };
      }
      return { payload, payloadValid: true, effect: effect === "read" ? "none" : "confirmed", transport: { durationMs: Date.now() - started, bytes } };
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof TimeoutError) {
        return { payloadValid: false, effect: effect === "read" ? "none" : "unknown", transport: { durationMs, bytes: 0 }, error: { code: "TOOL_TIMEOUT", category: "availability", message: sanitizeMessage(err.message), retryable: false } };
      }
      if (ctx.signal.aborted) {
        return { payloadValid: false, effect: effect === "read" ? "none" : "unknown", transport: { durationMs, bytes: 0 }, error: { code: "CANCELLED", category: "coordination", message: "cancelled", retryable: false } };
      }
      const code = err instanceof ToolError ? err.code : err instanceof Error && /^[A-Z][A-Z0-9_]{2,}$/.test(err.message) ? err.message : "TOOL_ERROR";
      const message = err instanceof Error ? sanitizeMessage(err.message) : "tool failed";
      return {
        payloadValid: false,
        effect: effectOnThrow(effect, err),
        transport: { durationMs, bytes: 0 },
        error: { code, category: code === "NOT_FOUND" || code === "INVALID_INPUT" ? "validation" : "internal", message, retryable: err instanceof ToolError ? err.retryable : false },
      };
    }
  }
}

const noopLogger = { debug(): void {}, info(): void {}, warn(): void {} };
