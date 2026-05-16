export const EQUITY_BLUNDER_THRESHOLD = -0.06;
export const EQUITY_MISTAKE_THRESHOLD = -0.02;

export function getEquityDiffColor(rank: number, diff: number): string {
  if (rank === 0) return "var(--color-success)";
  if (diff < EQUITY_BLUNDER_THRESHOLD) return "var(--color-danger)";
  if (diff < EQUITY_MISTAKE_THRESHOLD) return "var(--color-warning)";
  return "var(--color-text-muted)";
}
