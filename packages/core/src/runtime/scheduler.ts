/** In-process scheduler: one execution per ownership scope at a time; wake-ups resume parked runs (§14.1, §17.3). */
import type { ExecutionPersistence } from "../types/persistence.js";
import type { TelemetrySink } from "../types/options.js";
import { Deferred } from "../util/async.js";
import type { AgentRuntime } from "./runtime.js";

export class Scheduler {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private runtime!: AgentRuntime;
  private closing = false;
  private active = 0;
  private readonly idle = new Deferred<void>();

  constructor(
    private readonly persistence: ExecutionPersistence,
    private readonly telemetry?: TelemetrySink,
  ) {}

  attach(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  /** True once shutdown started: admission is stopped (§20.2). */
  get isClosing(): boolean {
    return this.closing;
  }

  registerAbort(runId: string, controller: AbortController): void {
    this.aborts.set(runId, controller);
  }

  /** Queues an execution of the run behind any execution already queued on its scope. */
  schedule(runId: string, scopeId: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error("scheduler is closing"));
    const prev = this.queues.get(scopeId) ?? Promise.resolve();
    const exec = prev
      .catch(() => undefined)
      .then(async () => {
        this.active++;
        try {
          await this.runtime.execute(runId);
        } finally {
          this.active--;
          this.aborts.delete(runId);
          if (this.active === 0 && this.closing) this.idle.resolve();
        }
      });
    this.queues.set(scopeId, exec);
    this.executions.set(runId, exec);
    exec.catch(() => undefined).then(() => {
      if (this.queues.get(scopeId) === exec) this.queues.delete(scopeId);
    });
    return exec;
  }

  /** Resolves when the most recent execution of the run ends (terminal or parked). */
  completion(runId: string): Promise<void> {
    return this.executions.get(runId) ?? Promise.resolve();
  }

  async wakeup(runId: string): Promise<void> {
    const run = await this.persistence.getRun(runId);
    if (!run) return;
    this.telemetry?.event?.("sfield.run.wakeup", { runId });
    this.schedule(runId, run.scopeId).catch(() => undefined);
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    await this.persistence.requestCancel(runId, reason);
    const controller = this.aborts.get(runId);
    if (controller && !controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"));
  }

  /** Stops admission and waits for active executions up to drainMs (§20.2). */
  async drain(drainMs: number): Promise<{ drained: boolean; active: number }> {
    this.closing = true;
    if (this.active === 0) return { drained: true, active: 0 };
    const timer = new Promise<void>((resolve) => setTimeout(resolve, drainMs));
    await Promise.race([this.idle.promise, timer]);
    if (this.active > 0) for (const c of this.aborts.values()) c.abort(new Error("shutdown"));
    await Promise.race([this.idle.promise, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    return { drained: this.active === 0, active: this.active };
  }
}
