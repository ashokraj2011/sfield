/** Declared token estimator with a conservative margin (§12.4). */
export const TOKEN_ESTIMATOR_ID = "chars/3.5+margin@1";
/** Fraction added on top of the raw estimate when fitting. */
export const TOKEN_ESTIMATE_MARGIN = 0.1;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3.5);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? "");
}

export function withMargin(tokens: number): number {
  return Math.ceil(tokens * (1 + TOKEN_ESTIMATE_MARGIN));
}
