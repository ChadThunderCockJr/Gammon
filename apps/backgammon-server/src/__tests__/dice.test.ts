import { describe, expect, it } from "vitest";
import { createDiceProof, deriveDice, verifyDiceDerivation, type DiceDerivationContext } from "../dice.js";

const randomness = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function context(overrides: Partial<DiceDerivationContext> = {}): DiceDerivationContext {
  return {
    drandRandomness: randomness,
    drandRound: 12345,
    drandChainHash: "quicknet-chain-hash",
    gameId: "00000000-0000-4000-8000-000000000001",
    cashQuoteId: null,
    playerWhite: "xion1white",
    playerBlack: "xion1black",
    roller: "white",
    turnNumber: 1,
    rulesVersion: "free-v1",
    openingRoll: false,
    ...overrides,
  };
}

function proofContext(overrides: Partial<DiceDerivationContext> = {}) {
  const { drandRandomness: _randomness, drandRound: _round, ...result } = context(overrides);
  return result;
}

describe("deriveDice", () => {
  it("returns deterministic faces between 1 and 6", () => {
    const first = deriveDice(context());
    const second = deriveDice(context());
    expect(first).toEqual(second);
    expect(first[0]).toBeGreaterThanOrEqual(1);
    expect(first[0]).toBeLessThanOrEqual(6);
    expect(first[1]).toBeGreaterThanOrEqual(1);
    expect(first[1]).toBeLessThanOrEqual(6);
  });

  it("domain-separates turns, games, quotes, rollers, and rules", () => {
    const domains = [
      context(),
      context({ turnNumber: 2 }),
      context({ gameId: "00000000-0000-4000-8000-000000000002" }),
      context({ cashQuoteId: "00000000-0000-4000-8000-000000000003" }),
      context({ roller: "black" }),
      context({ rulesVersion: "cash-v1" }),
    ].map((input) => deriveDice(input).join(","));
    expect(new Set(domains).size).toBeGreaterThan(2);
  });

  it("never returns an opening-roll tie", () => {
    for (let turnNumber = 1; turnNumber <= 100; turnNumber += 1) {
      const [whiteDie, blackDie] = deriveDice(context({ openingRoll: true, turnNumber }));
      expect(whiteDie).not.toBe(blackDie);
    }
  });
});

describe("dice proofs", () => {
  const beacon = {
    round: 12345,
    randomness,
    signature: "bls_sig_hex",
  };

  it("binds the complete derivation domain", () => {
    const proof = createDiceProof(beacon, proofContext());
    expect(proof.drandRound).toBe(beacon.round);
    expect(proof.drandRandomness).toBe(beacon.randomness);
    expect(proof.drandSignature).toBe(beacon.signature);
    expect(proof.derivationVersion).toBe("gammon.dice-result.v2");
    expect(proof.gameId).toBe("00000000-0000-4000-8000-000000000001");
    expect(proof.dice).toHaveLength(2);
    expect(verifyDiceDerivation(proof)).toBe(true);
  });

  it("rejects tampered results and context", () => {
    const proof = createDiceProof(beacon, proofContext());
    const flippedDie = proof.dice[0] === 1 ? 2 : 1;
    expect(verifyDiceDerivation({ ...proof, dice: [flippedDie, proof.dice[1]] })).toBe(false);
    expect(verifyDiceDerivation({ ...proof, turnNumber: proof.turnNumber + 1 })).toBe(false);
    expect(verifyDiceDerivation({ ...proof, cashQuoteId: "different-quote" })).toBe(false);
  });
});
