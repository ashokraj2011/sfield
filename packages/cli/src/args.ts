/** Minimal argument parser: positionals plus `--flag value` / `--flag` / `--no-flag`. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value: string | boolean = eq === -1 ? true : a.slice(eq + 1);
      if (value === true && key.startsWith("no-")) {
        key = key.slice(3);
        value = false;
      } else if (value === true && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        value = argv[++i]!;
      }
      const existing = flags[key];
      if (existing !== undefined && typeof value === "string") flags[key] = Array.isArray(existing) ? [...existing, value] : typeof existing === "string" ? [existing, value] : value;
      else flags[key] = value;
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

export function flagString(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  if (Array.isArray(v)) return v[v.length - 1];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(flags: ParsedArgs["flags"], key: string): boolean {
  const v = flags[key];
  return v === true || v === "true";
}
