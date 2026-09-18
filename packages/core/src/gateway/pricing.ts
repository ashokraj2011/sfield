/** Price computation in integer micro-USD with disjoint billable categories (§13.5, §15.1). */
import type { PriceTable, Usage } from "../types/model.js";

export function costMicroUsd(usage: Usage, prices: PriceTable | undefined): { cost: number; label: "priced" | "best_effort" | "unpriced" } {
  if (!prices) return { cost: 0, label: "unpriced" };
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // Anthropic reports input_tokens excluding cache categories; treat categories as disjoint.
  const input = usage.inputTokens;
  const output = usage.outputTokens + (usage.reasoningTokens ?? 0);
  let cost = Math.ceil((input * prices.inputPerMTok) / 1_000_000) + Math.ceil((output * prices.outputPerMTok) / 1_000_000);
  if (prices.cacheReadPerMTok !== undefined) cost += Math.ceil((cacheRead * prices.cacheReadPerMTok) / 1_000_000);
  if (prices.cacheWritePerMTok !== undefined) cost += Math.ceil((cacheWrite * prices.cacheWritePerMTok) / 1_000_000);
  return { cost, label: usage.reported ? "priced" : "best_effort" };
}

/** Conservative upper estimate for a reservation: full input estimate plus the reserved output. */
export function estimateMaxCost(inputTokens: number, maxOutputTokens: number, prices: PriceTable | undefined): number {
  if (!prices) return 0;
  return Math.ceil((inputTokens * prices.inputPerMTok) / 1_000_000) + Math.ceil((maxOutputTokens * prices.outputPerMTok) / 1_000_000);
}
