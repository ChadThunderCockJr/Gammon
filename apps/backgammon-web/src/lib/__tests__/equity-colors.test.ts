import { describe, it, expect } from "vitest";
import {
  getEquityDiffColor,
  EQUITY_BLUNDER_THRESHOLD,
  EQUITY_MISTAKE_THRESHOLD,
} from "../equity-colors";

describe("getEquityDiffColor", () => {
  it("rank 0 is always success green", () => {
    expect(getEquityDiffColor(0, 0)).toBe("var(--color-success)");
    expect(getEquityDiffColor(0, -1)).toBe("var(--color-success)");
  });

  it("diff below blunder threshold is danger", () => {
    expect(getEquityDiffColor(1, EQUITY_BLUNDER_THRESHOLD - 0.01)).toBe(
      "var(--color-danger)",
    );
  });

  it("diff between mistake and blunder is warning", () => {
    expect(getEquityDiffColor(1, EQUITY_MISTAKE_THRESHOLD - 0.01)).toBe(
      "var(--color-warning)",
    );
  });

  it("diff at or above mistake threshold is muted", () => {
    expect(getEquityDiffColor(1, 0)).toBe("var(--color-text-muted)");
    expect(getEquityDiffColor(1, EQUITY_MISTAKE_THRESHOLD)).toBe(
      "var(--color-text-muted)",
    );
  });

  it("exact blunder threshold falls to warning (strict <)", () => {
    expect(getEquityDiffColor(1, EQUITY_BLUNDER_THRESHOLD)).toBe(
      "var(--color-warning)",
    );
  });
});
