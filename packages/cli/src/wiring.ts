/** Host wiring: a module exporting SFieldOptions, or the default local wiring over ./sfield.yaml and ./tools.ts (§21.2). */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SFieldCreateOptions, ToolDefinition } from "@sfield/core";
import { SFieldError } from "@sfield/core";
import { httpPlugin } from "@sfield/http";
import type { ParsedArgs } from "./args.js";
import { flagString } from "./args.js";

export interface Wiring {
  options: SFieldCreateOptions;
  source: string;
}

export async function loadWiring(args: ParsedArgs, opts: { requireConfig?: boolean } = {}): Promise<Wiring> {
  const cwd = process.cwd();
  loadDotEnv(cwd);
  // Explicit --wiring, else a project harness module (harness.ts / harness.js), else the local preset over sfield.yaml + tools.ts.
  const wiringPath = flagString(args.flags, "wiring") ?? ["harness.ts", "harness.js", "harness.mjs"].find((f) => existsSync(resolve(cwd, f)));
  if (wiringPath) {
    const abs = resolve(cwd, wiringPath);
    if (!existsSync(abs)) throw new SFieldError("INVALID_CONFIG", `wiring module ${wiringPath} not found`);
    const mod = (await import(pathToFileURL(abs).href)) as { options?: SFieldCreateOptions; createOptions?: () => Promise<SFieldCreateOptions> | SFieldCreateOptions; default?: SFieldCreateOptions | (() => Promise<SFieldCreateOptions>) };
    let options: SFieldCreateOptions | undefined;
    if (mod.createOptions) options = await mod.createOptions();
    else if (mod.options) options = mod.options;
    else if (typeof mod.default === "function") options = await mod.default();
    else if (mod.default) options = mod.default;
    if (!options) throw new SFieldError("INVALID_CONFIG", `wiring module ${wiringPath} must export options, createOptions(), or a default export`);
    const configFlag = flagString(args.flags, "config");
    if (configFlag) options = { ...options, config: resolve(cwd, configFlag) };
    const plugins = options.plugins ?? [];
    if (!plugins.some((p) => p.manifest.id === "http")) plugins.push(httpPlugin());
    return { options: { quiet: true, ...options, plugins }, source: wiringPath };
  }
  const config = resolve(cwd, flagString(args.flags, "config") ?? "sfield.yaml");
  if (opts.requireConfig !== false && !existsSync(config)) {
    throw new SFieldError("INVALID_CONFIG", `configuration file ${config} not found`, { suggestion: "Run `sfield init <name> --preset local` or pass --config" });
  }
  const preset = (flagString(args.flags, "preset") ?? "local") as "local" | "memory";
  const tools = await loadProjectTools(cwd);
  return { options: { preset, config, tools, plugins: [httpPlugin()], quiet: true }, source: `default (${preset} preset, ${config}${tools.length ? ", tools.ts" : ""})` };
}

async function loadProjectTools(cwd: string): Promise<ToolDefinition[]> {
  for (const name of ["tools.ts", "tools.js", "tools.mjs"]) {
    const abs = resolve(cwd, name);
    if (!existsSync(abs)) continue;
    const mod = (await import(pathToFileURL(abs).href)) as { tools?: ToolDefinition[]; default?: ToolDefinition[] };
    const tools = mod.tools ?? mod.default;
    if (!Array.isArray(tools)) throw new SFieldError("INVALID_CONFIG", `${name} must export an array named tools`);
    return tools;
  }
  return [];
}

function loadDotEnv(cwd: string): void {
  const file = resolve(cwd, ".env");
  if (!existsSync(file)) return;
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(file);
  } catch {
    // an unreadable .env is reported by credential checks later
  }
}
