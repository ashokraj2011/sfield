/** Test harness: an SField instance over ephemeral persistence, a fake provider, and a dev authorizer. */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, ApprovalTransport, ApprovalView, InputTransport, JsonObject, JsonValue, Principal, SFieldOptions } from "@sfield/core";
import { SField, EphemeralPersistence, createDevAuthorizer } from "@sfield/core";
import { FakeProvider, fakeProviderPlugin, type Script } from "./fake-provider.js";

export const TEST_PRINCIPAL: Principal = { tenantId: "t1", subjectId: "u1", roles: ["user"], attributes: { plan: "pro" } };
export const TEST_ACTOR: Actor = { tenantId: "t1", subjectId: "u1" };

export interface HarnessOptions extends Partial<Omit<SFieldOptions, "config" | "preset">> {
  config: JsonObject;
  script?: Script;
  provider?: FakeProvider;
  files?: Record<string, string>;
  principal?: Principal;
}

export interface Harness {
  sf: SField;
  provider: FakeProvider;
  persistence: EphemeralPersistence;
  dir: string;
  principal: Principal;
}

/** A minimal complete configuration with the fake provider bound as `default`. */
export function baseConfig(overrides: JsonObject = {}): JsonObject {
  return {
    version: 1,
    models: { default: { provider: "fake", model: "fake-1", credential: { env: "FAKE_KEY" } } },
    agents: {},
    ...overrides,
  };
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "sfield-test-"));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const provider = opts.provider ?? new FakeProvider(opts.script ?? [{ text: "ok" }]);
  const persistence = (opts.persistence as EphemeralPersistence | undefined) ?? new EphemeralPersistence();
  const principal = opts.principal ?? TEST_PRINCIPAL;
  const { config, script: _s, provider: _p, files: _f, principal: _pr, ...rest } = opts;
  const sf = await SField.create({
    config,
    configDir: dir,
    deployment: "ephemeral",
    persistence,
    authorizer: opts.authorizer ?? createDevAuthorizer(principal),
    plugins: [fakeProviderPlugin(provider), ...(opts.plugins ?? [])],
    devPrincipal: principal,
    env: { FAKE_KEY: "fake-secret-value-123456", ...(opts.env ?? {}) },
    quiet: true,
    ...rest,
    limits: { grants: { interactionTools: ["ask_user", "memory.remember", "memory.forget"] }, ...(opts.limits ?? {}) },
  });
  return { sf, provider, persistence, dir, principal };
}

/** Records approval requests and lets the test decide later. */
export class RecordingApprovalTransport implements ApprovalTransport {
  readonly requests: Array<{ approvalId: string; views: ApprovalView[]; decide: (decision: "approve" | "deny", actor: Actor, comment?: string) => Promise<void> }> = [];
  async request(view: Parameters<ApprovalTransport["request"]>[0]): Promise<void> {
    this.requests.push({ approvalId: view.approval.id, views: view.views, decide: view.decide });
  }
}

/** Decides synchronously inside the notification, like an interactive CLI. */
export function autoApprovalTransport(decision: "approve" | "deny", actor: Actor = TEST_ACTOR): ApprovalTransport & { count: number } {
  const t = {
    count: 0,
    async request(view: Parameters<ApprovalTransport["request"]>[0]): Promise<void> {
      t.count++;
      await view.decide(decision, actor);
    },
  };
  return t;
}

export class RecordingInputTransport implements InputTransport {
  readonly requests: Array<{ requestId: string; question: string; answer: (value: JsonValue, actor: Actor) => Promise<void> }> = [];
  async request(view: Parameters<InputTransport["request"]>[0]): Promise<void> {
    this.requests.push({ requestId: view.request.requestId, question: view.request.question, answer: view.answer });
  }
}

export function autoInputTransport(answer: JsonValue | ((question: string) => JsonValue), actor: Actor = TEST_ACTOR): InputTransport & { count: number } {
  const t = {
    count: 0,
    async request(view: Parameters<InputTransport["request"]>[0]): Promise<void> {
      t.count++;
      await view.answer(typeof answer === "function" ? answer(view.request.question) : answer, actor);
    },
  };
  return t;
}

export async function collectEvents(run: { events(): AsyncIterable<{ type: string; payload: JsonObject }> }): Promise<Array<{ type: string; payload: JsonObject }>> {
  const out: Array<{ type: string; payload: JsonObject }> = [];
  for await (const ev of run.events()) out.push({ type: ev.type, payload: ev.payload });
  return out;
}
