/** Plugin registration and lifecycle (§6.2). register() is synchronous and side-effect free; start() runs after validation. */
import type { ContextTransform, HostBindings, PluginManifest, Registrar, SFieldPlugin, SecretResolver } from "../types/options.js";
import type { ModelProvider } from "../types/model.js";
import type { RetrievalTypeFactory } from "../types/retrieval.js";
import type { DefineToolInput, ToolAdapter, ToolDefinition } from "../types/tool.js";
import type { JsonObject } from "../types/common.js";
import { SFieldError } from "../errors.js";
import type { ToolRegistry } from "../registry/registry.js";

export const CORE_API_VERSION = 1;
export const CORE_VERSION = "0.1.0";

export interface Registrations {
  providers: Map<string, ModelProvider>;
  retrievalTypes: Map<string, RetrievalTypeFactory>;
  contextTransforms: Map<string, ContextTransform>;
  manifests: PluginManifest[];
}

export class PluginManager {
  readonly registrations: Registrations = { providers: new Map(), retrievalTypes: new Map(), contextTransforms: new Map(), manifests: [] };
  private readonly plugins: SFieldPlugin[] = [];
  private started: SFieldPlugin[] = [];

  constructor(private readonly registry: ToolRegistry) {}

  registerProvider(provider: ModelProvider): void {
    if (this.registrations.providers.has(provider.id)) throw new SFieldError("DUPLICATE_DEFINITION", `provider ${provider.id} registered twice`);
    this.registrations.providers.set(provider.id, provider);
  }

  registerRetrievalType(factory: RetrievalTypeFactory): void {
    if (this.registrations.retrievalTypes.has(factory.type)) throw new SFieldError("DUPLICATE_DEFINITION", `retrieval type ${factory.type} registered twice`);
    this.registrations.retrievalTypes.set(factory.type, factory);
  }

  /** Validates the manifest and runs register() with a registrar bound to this instance. */
  load(plugin: SFieldPlugin): void {
    const m = plugin.manifest;
    if (!m || typeof m.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(m.id)) throw new SFieldError("PLUGIN_INCOMPATIBLE", "plugin manifest needs a valid id");
    if (m.apiVersion !== CORE_API_VERSION) throw new SFieldError("PLUGIN_INCOMPATIBLE", `plugin ${m.id} targets api version ${String(m.apiVersion)}, core provides ${CORE_API_VERSION}`);
    if (typeof m.buildDigest !== "string" || m.buildDigest.length < 8) throw new SFieldError("PLUGIN_INCOMPATIBLE", `plugin ${m.id} needs a build digest`);
    if (!compatible(m.coreCompatibility, CORE_VERSION)) throw new SFieldError("PLUGIN_INCOMPATIBLE", `plugin ${m.id} requires core ${m.coreCompatibility}, running ${CORE_VERSION}`);
    if (this.registrations.manifests.some((x) => x.id === m.id)) throw new SFieldError("DUPLICATE_DEFINITION", `plugin ${m.id} loaded twice`);
    const registrar: Registrar = {
      adapter: (adapter: ToolAdapter) => this.registry.registerAdapter(adapter),
      tool: (tool: ToolDefinition | DefineToolInput) => {
        this.registry.registerCode(tool, "bundle");
      },
      provider: (provider: ModelProvider) => this.registerProvider(provider),
      retrievalType: (factory: RetrievalTypeFactory) => this.registerRetrievalType(factory),
      contextTransform: (transform: ContextTransform) => {
        if (this.registrations.contextTransforms.has(transform.id)) throw new SFieldError("DUPLICATE_DEFINITION", `context transform ${transform.id} registered twice`);
        this.registrations.contextTransforms.set(transform.id, transform);
      },
    };
    plugin.register(registrar);
    this.registrations.manifests.push(m);
    this.plugins.push(plugin);
  }

  /** Checks declared requirements against host bindings (§6.2): requirements, not permissions. */
  checkRequirements(bindings: HostBindings, extra: { secrets: (name: string) => boolean }): void {
    for (const m of this.registrations.manifests) {
      for (const req of m.requires) {
        const ok =
          req.kind === "model" ? !!bindings.models?.[req.name] : req.kind === "connection" ? !!bindings.connections?.[req.name] : req.kind === "retrieval" ? !!bindings.retrieval?.[req.name] : req.kind === "secret" ? extra.secrets(req.name) : true;
        if (!ok) throw new SFieldError("UNKNOWN_BINDING", `plugin ${m.id} requires ${req.kind} binding ${JSON.stringify(req.name)}`, { path: `plugins.${m.id}.requires`, suggestion: `Pass bindings.${req.kind === "model" ? "models" : req.kind === "connection" ? "connections" : "retrieval"}.${req.name} to SField.create` });
      }
    }
  }

  async start(ctx: { config: JsonObject; bindings: HostBindings; secrets: SecretResolver; signal: AbortSignal }): Promise<void> {
    for (const p of this.plugins) {
      if (p.start) await p.start({ config: (ctx.config[p.manifest.id] as JsonObject) ?? {}, bindings: ctx.bindings, secrets: ctx.secrets, signal: ctx.signal });
      this.started.push(p);
    }
  }

  async health(): Promise<Record<string, { ok: boolean; detail?: string }>> {
    const out: Record<string, { ok: boolean; detail?: string }> = {};
    for (const p of this.started) {
      try {
        out[p.manifest.id] = p.health ? await p.health() : { ok: true };
      } catch (e) {
        out[p.manifest.id] = { ok: false, detail: (e as Error).message };
      }
    }
    return out;
  }

  async stop(signal: AbortSignal): Promise<void> {
    for (const p of [...this.started].reverse()) {
      try {
        if (p.stop) await p.stop({ signal });
      } catch {
        // stop failures do not block shutdown
      }
    }
    this.started = [];
  }
}

/** Minimal caret/exact compatibility: "^0.1.0", "0.1.x", "*", or exact. */
export function compatible(range: string, version: string): boolean {
  if (!range || range === "*") return true;
  const v = version.split(".").map(Number);
  if (range.startsWith("^")) {
    const r = range.slice(1).split(".").map(Number);
    if (r[0] !== v[0]) return false;
    if (r[0] === 0) return r[1] === v[1] && (v[2] ?? 0) >= (r[2] ?? 0);
    return (v[1] ?? 0) > (r[1] ?? 0) || ((v[1] ?? 0) === (r[1] ?? 0) && (v[2] ?? 0) >= (r[2] ?? 0));
  }
  if (range.endsWith(".x")) return range.slice(0, -2) === version.split(".").slice(0, range.split(".").length - 1).join(".");
  return range === version;
}
