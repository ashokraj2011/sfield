/** Error taxonomy (§19.4). Every error has a stable code, category, and retry disposition. */
import type { ErrorCategory, JsonObject, PublicError } from "./types/common.js";

const CATEGORY_BY_CODE: Record<string, ErrorCategory> = {
  // Configuration
  UNKNOWN_BINDING: "configuration",
  DUPLICATE_TOOL: "configuration",
  DUPLICATE_DEFINITION: "configuration",
  INVALID_REFERENCE: "configuration",
  UNSUPPORTED_SCHEMA: "configuration",
  INVALID_CONFIG: "configuration",
  UNKNOWN_KEY: "configuration",
  UNKNOWN_TOOL: "configuration",
  UNKNOWN_AGENT: "configuration",
  UNKNOWN_MODEL: "configuration",
  UNKNOWN_SOURCE: "configuration",
  UNKNOWN_ADAPTER: "configuration",
  UNKNOWN_PLUGIN: "configuration",
  UNKNOWN_REFERENCE_NAMESPACE: "configuration",
  AMBIGUOUS_TOOL_VERSION: "configuration",
  INCLUDE_CYCLE: "configuration",
  MISSING_CREDENTIAL: "configuration",
  MISSING_PRESET: "configuration",
  PRESET_REFUSED: "configuration",
  LOCK_MANIFEST_UNAPPROVED: "configuration",
  LOCK_MANIFEST_MISMATCH: "configuration",
  EVAL_EVIDENCE_MISSING: "configuration",
  EVAL_THRESHOLD_NOT_MET: "configuration",
  EVAL_EVIDENCE_EXPIRED: "configuration",
  EVAL_BASELINE_UNAVAILABLE: "configuration",
  REGISTRATION_CLOSED: "configuration",
  PLUGIN_INCOMPATIBLE: "configuration",
  UNSUPPORTED_DEPLOYMENT: "configuration",
  UNSUPPORTED_CAPABILITY: "configuration",
  // Validation
  INVALID_INPUT: "validation",
  INVALID_OUTPUT: "validation",
  CONTEXT_LIMIT: "validation",
  UNSUPPORTED_MEDIA: "validation",
  MISSING_REFERENCE: "validation",
  REQUIRED_CONTEXT_UNAVAILABLE: "validation",
  INCOMPLETE_OUTPUT: "validation",
  REPEATED_CALL: "validation",
  LOOP_DETECTED: "validation",
  REQUEST_TOO_LARGE: "validation",
  MEMORY_CAPACITY: "validation",
  CONFIRMATION_REQUIRED: "validation",
  // Authorization
  ACCESS_DENIED: "authorization",
  APPROVAL_REQUIRED: "authorization",
  APPROVAL_EXPIRED: "authorization",
  APPROVAL_DENIED: "authorization",
  APPROVAL_ALREADY_DECIDED: "authorization",
  APPROVAL_INVALID: "authorization",
  POLICY_CHANGED: "authorization",
  EFFECT_NOT_ALLOWED: "authorization",
  PREREQUISITE_FAILED: "authorization",
  EVIDENCE_EXPIRED: "authorization",
  CLASSIFICATION_DENIED: "authorization",
  REVOKED: "authorization",
  // Availability
  PROVIDER_UNAVAILABLE: "availability",
  SOURCE_TIMEOUT: "availability",
  SOURCE_UNAVAILABLE: "availability",
  STATE_UNAVAILABLE: "availability",
  TOOL_TIMEOUT: "availability",
  TOOL_UNAVAILABLE: "availability",
  HOOK_TIMEOUT: "availability",
  // Accounting
  BUDGET_EXHAUSTED: "accounting",
  USAGE_UNKNOWN: "accounting",
  // Coordination
  CONVERSATION_BUSY: "coordination",
  VERSION_CONFLICT: "coordination",
  OWNERSHIP_LOST: "coordination",
  OWNERSHIP_UNAVAILABLE: "coordination",
  RUN_NOT_RESUMABLE: "coordination",
  CANCELLED: "coordination",
  // Effect uncertainty
  OUTCOME_UNKNOWN: "effect_uncertainty",
  RECONCILIATION_REQUIRED: "effect_uncertainty",
  // Request identity
  IDEMPOTENCY_CONFLICT: "request_identity",
  // Internal
  INTERNAL: "internal",
  NOT_FOUND: "internal",
  NOT_SUPPORTED: "internal",
};

export function categoryOf(code: string): ErrorCategory {
  return CATEGORY_BY_CODE[code] ?? "internal";
}

export interface SFieldErrorOptions {
  category?: ErrorCategory;
  retryable?: boolean;
  path?: string;
  suggestion?: string;
  runId?: string;
  callId?: string;
  status?: number;
  details?: JsonObject;
  cause?: unknown;
}

export class SFieldError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly path?: string;
  readonly suggestion?: string;
  readonly runId?: string;
  readonly callId?: string;
  readonly status?: number;
  readonly details?: JsonObject;

  constructor(code: string, message: string, opts: SFieldErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "SFieldError";
    this.code = code;
    this.category = opts.category ?? categoryOf(code);
    this.retryable = opts.retryable ?? false;
    if (opts.path !== undefined) this.path = opts.path;
    if (opts.suggestion !== undefined) this.suggestion = opts.suggestion;
    if (opts.runId !== undefined) this.runId = opts.runId;
    if (opts.callId !== undefined) this.callId = opts.callId;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.details !== undefined) this.details = opts.details;
  }

  toPublic(): PublicError {
    const pub: PublicError = {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.runId) pub.runId = this.runId;
    if (this.callId) pub.callId = this.callId;
    if (this.path) pub.path = this.path;
    if (this.suggestion) pub.suggestion = this.suggestion;
    return pub;
  }

  static is(err: unknown, code?: string): err is SFieldError {
    return err instanceof SFieldError && (code === undefined || err.code === code);
  }

  static from(err: unknown, fallbackCode = "INTERNAL"): SFieldError {
    if (err instanceof SFieldError) return err;
    if (err instanceof Error) {
      if (err.name === "AbortError") return new SFieldError("CANCELLED", "operation aborted", { cause: err });
      return new SFieldError(fallbackCode, sanitizeMessage(err.message), { cause: err });
    }
    return new SFieldError(fallbackCode, sanitizeMessage(String(err)));
  }
}

/** Configuration error with a config path, stable code, explanation, and suggested correction (§4.4). */
export class ConfigError extends SFieldError {
  constructor(code: string, message: string, path: string, suggestion?: string, details?: JsonObject) {
    super(code, message, { category: "configuration", path, suggestion, details });
    this.name = "ConfigError";
  }
}

export class ConfigErrors extends SFieldError {
  readonly errors: ConfigError[];
  constructor(errors: ConfigError[]) {
    super(
      errors[0]?.code ?? "INVALID_CONFIG",
      errors.length === 1 ? errors[0]!.message : `${errors.length} configuration errors; first: ${errors[0]!.message}`,
      { category: "configuration", path: errors[0]?.path },
    );
    this.name = "ConfigErrors";
    this.errors = errors;
  }
  format(): string {
    return this.errors
      .map((e) => `${e.path} [${e.code}] ${e.message}${e.suggestion ? ` — ${e.suggestion}` : ""}`)
      .join("\n");
  }
}

/** Removes newlines and bounds length; adapter/provider messages are sanitized before crossing boundaries (§18.2). */
export function sanitizeMessage(message: string, max = 500): string {
  const oneLine = message.replace(/[\r\n\t]+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
