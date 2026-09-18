export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | number = Date.UTC(2026, 0, 1)) {
    this.t = typeof start === "number" ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(date: Date): void {
    this.t = date.getTime();
  }
}

/** UTC period key for budget scopes (§15.3). */
export function periodKey(date: Date, period: "day" | "month"): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (period === "month") return `${y}-${m}`;
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
