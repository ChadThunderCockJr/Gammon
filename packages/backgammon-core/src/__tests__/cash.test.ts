import { describe, expect, it } from "vitest";
import {
  CASH_GAME_RULES_V1,
  cashLiability,
  formatMicroUsd,
  maximumReserve,
  parseMicroUsd,
  parseUsdToMicroUsd,
  settleCashGame,
  type CubeValue,
  type ResultMultiplier,
} from "../cash";

describe("cash-game money", () => {
  it("parses only canonical whole-cent dollar inputs", () => {
    expect(parseUsdToMicroUsd("0.25")).toBe(250_000n);
    expect(parseUsdToMicroUsd("10")).toBe(10_000_000n);
    expect(formatMicroUsd(10_250_000n)).toBe("$10.25");

    for (const invalid of ["-1", "+1", "01", "1.001", "1e2", "NaN", " 1.00x "]) {
      expect(() => parseUsdToMicroUsd(invalid)).toThrow();
    }
    for (const invalid of ["-1", "1.0", "1e6", "01"]) {
      expect(() => parseMicroUsd(invalid)).toThrow();
    }
  });

  it("prefunds the maximum backgammon liability at the cube cap", () => {
    expect(maximumReserve(parseUsdToMicroUsd("1"))).toBe(24_000_000n);
  });

  it("conserves every supported cube and result outcome", () => {
    const stake = parseUsdToMicroUsd("1.25");
    const cubes: CubeValue[] = [1, 2, 4, 8];
    const results: ResultMultiplier[] = [1, 2, 3];

    for (const cube of cubes) {
      for (const result of results) {
        const settlement = settleCashGame(stake, cube, result, cube > 1);
        expect(
          settlement.winnerPayoutMicroUsd +
            settlement.loserRefundMicroUsd +
            settlement.rakeMicroUsd,
        ).toBe(settlement.totalDepositedMicroUsd);
        expect(settlement.liabilityMicroUsd).toBe(
          cashLiability(stake, cube, result, cube > 1),
        );
      }
    }
  });

  it("applies Jacoby before the cube is turned", () => {
    const stake = parseUsdToMicroUsd("1");
    expect(cashLiability(stake, 1, 3, false, CASH_GAME_RULES_V1)).toBe(1_000_000n);
    expect(cashLiability(stake, 2, 3, true, CASH_GAME_RULES_V1)).toBe(6_000_000n);
  });
});
