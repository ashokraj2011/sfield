import type { PublicError } from "@sfield/core";
import { ConfigErrors, SFieldError } from "@sfield/core";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function println(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function eprintln(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function formatError(e: unknown): string {
  if (e instanceof ConfigErrors) return e.errors.map(formatPublic).join("\n");
  if (e instanceof SFieldError) return formatPublic(e.toPublic());
  if (e instanceof Error) return e.message;
  return String(e);
}

export function formatPublic(e: PublicError): string {
  const path = e.path ? `${e.path} ` : "";
  return `${path}[${e.code}] ${e.message}${e.suggestion ? `\n    → ${e.suggestion}` : ""}`;
}

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}
