/** Secret resolution (§5.5, §18.2): references resolve at call time and never enter configuration or logs. */
import type { SecretResolver } from "./types/options.js";
import { SFieldError } from "./errors.js";

export class EnvSecretResolver implements SecretResolver {
  private readonly resolved = new Set<string>();
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async resolve(ref: { env: string } | { name: string }): Promise<string> {
    if (!("env" in ref)) throw new SFieldError("MISSING_CREDENTIAL", `secret ${JSON.stringify(ref.name)} cannot be resolved by the environment resolver`, { suggestion: "Pass a SecretResolver to SField.create" });
    const v = this.env[ref.env];
    if (v === undefined || v === "") throw new SFieldError("MISSING_CREDENTIAL", `environment variable ${ref.env} is not set`, { suggestion: `Set ${ref.env}` });
    this.resolved.add(v);
    return v;
  }

  async inspect(ref: { env: string } | { name: string }): Promise<{ present: boolean }> {
    if (!("env" in ref)) return { present: false };
    const v = this.env[ref.env];
    return { present: v !== undefined && v !== "" };
  }

  /** Values resolved so far, for output scrubbing. */
  knownValues(): string[] {
    return [...this.resolved];
  }
}

/** Tries the host resolver first, then the environment. */
export class CompositeSecretResolver implements SecretResolver {
  constructor(
    private readonly primary: SecretResolver,
    private readonly fallback: SecretResolver,
  ) {}
  async resolve(ref: { env: string } | { name: string }): Promise<string> {
    if ("env" in ref) return this.fallback.resolve(ref);
    return this.primary.resolve(ref);
  }
  async inspect(ref: { env: string } | { name: string }): Promise<{ present: boolean }> {
    if ("env" in ref) return this.fallback.inspect ? this.fallback.inspect(ref) : { present: true };
    return this.primary.inspect ? this.primary.inspect(ref) : { present: true };
  }
  knownValues(): string[] {
    return [...(this.primary.knownValues?.() ?? []), ...(this.fallback.knownValues?.() ?? [])];
  }
}
