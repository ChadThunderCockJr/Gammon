import { describe, it, expect } from "vitest";
import { getSettlementMultiplier } from "../escrow.js";

describe("getSettlementMultiplier", () => {
  it("returns 1 for normal win at cube 1", () => {
    expect(getSettlementMultiplier("normal", 1)).toBe(1);
  });

  it("returns 2 for gammon at cube 1", () => {
    expect(getSettlementMultiplier("gammon", 1)).toBe(2);
  });

  it("returns 3 for backgammon at cube 1", () => {
    expect(getSettlementMultiplier("backgammon", 1)).toBe(3);
  });

  it("multiplies by cube value", () => {
    expect(getSettlementMultiplier("normal", 4)).toBe(4);
    expect(getSettlementMultiplier("gammon", 2)).toBe(4);
    expect(getSettlementMultiplier("backgammon", 8)).toBe(24);
  });

  it("handles max cube value", () => {
    expect(getSettlementMultiplier("normal", 64)).toBe(64);
    expect(getSettlementMultiplier("gammon", 64)).toBe(128);
    expect(getSettlementMultiplier("backgammon", 64)).toBe(192);
  });
});
