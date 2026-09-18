#!/usr/bin/env node
// Re-executes with TypeScript type stripping so project files (tools.ts) can be imported directly (§4.6).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, "..", "dist", "main.js");
const wanted = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
const missing = wanted.filter((f) => !process.execArgv.includes(f));
if (missing.length > 0 && !process.env["SFIELD_NO_REEXEC"]) {
  const child = spawn(process.execPath, [...process.execArgv, ...wanted, main, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, SFIELD_NO_REEXEC: "1" } });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  await import(main);
}
