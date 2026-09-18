import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ParsedArgs } from "../args.js";
import { flagString } from "../args.js";
import { businessStarter, localStarter } from "../templates.js";
import { println } from "../output.js";

export async function init(args: ParsedArgs): Promise<number> {
  const name = args.positionals[1];
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    println("usage: sfield init <name> [--preset local] [--template business-agent]");
    return 2;
  }
  const template = flagString(args.flags, "template");
  const preset = flagString(args.flags, "preset") ?? "local";
  if (preset !== "local") {
    println(`init supports --preset local (got ${preset})`);
    return 2;
  }
  const files = template === "business-agent" ? businessStarter(name) : template === undefined ? localStarter(name) : null;
  if (!files) {
    println(`unknown template ${template}; available: business-agent`);
    return 2;
  }
  const dir = resolve(process.cwd(), name);
  if (existsSync(dir)) {
    println(`${dir} already exists`);
    return 1;
  }
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  println(`created ${name}/ (${files.length} files)`);
  println("");
  println("next:");
  println(`  cd ${name}`);
  println("  npm install");
  println("  cp .env.example .env   # then set ANTHROPIC_API_KEY (or an openai_compatible runtime)");
  if (template === "business-agent") println("  npm run backend         # local mock billing API, in another terminal");
  println("  npm start");
  return 0;
}
