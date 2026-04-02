import { describe, it, expect } from "vitest";
import { deriveDice, createDiceProof, verifyDiceDerivation } from "../dice.js";

describe("deriveDice", () => {
  const randomness = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const playerWhite = "xion1white";
  const playerBlack = "xion1black";

  it("returns two numbers between 1 and 6", () => {
    const [d1, d2] = deriveDice(randomness, playerWhite, playerBlack, 1);
    expect(d1).toBeGreaterThanOrEqual(1);
    expect(d1).toBeLessThanOrEqual(6);
    expect(d2).toBeGreaterThanOrEqual(1);
    expect(d2).toBeLessThanOrEqual(6);
  });

  it("is deterministic with same inputs", () => {
    const a = deriveDice(randomness, playerWhite, playerBlack, 1);
    const b = deriveDice(randomness, playerWhite, playerBlack, 1);
    expect(a).toEqual(b);
  });

  it("produces different results for different turn numbers", () => {
    const a = deriveDice(randomness, playerWhite, playerBlack, 1);
    const b = deriveDice(randomness, playerWhite, playerBlack, 2);
    // Could theoretically be equal, but with SHA256 hash it's astronomically unlikely
    // Test with enough turns to be confident
    const results = Array.from({ length: 20 }, (_, i) =>
      deriveDice(randomness, playerWhite, playerBlack, i + 1).join(",")
    );
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(10); // at least half should differ
  });

  it("produces different results for different randomness", () => {
    const r1 = "1111111111111111111111111111111111111111111111111111111111111111";
    const r2 = "2222222222222222222222222222222222222222222222222222222222222222";
    const a = deriveDice(r1, playerWhite, playerBlack, 1);
    const b = deriveDice(r2, playerWhite, playerBlack, 1);
    expect(a).not.toEqual(b);
  });

  it("produces different results for swapped players", () => {
    const a = deriveDice(randomness, playerWhite, playerBlack, 1);
    const b = deriveDice(randomness, playerBlack, playerWhite, 1);
    expect(a).not.toEqual(b);
  });
});

describe("createDiceProof", () => {
  it("creates a proof with correct structure", () => {
    const beacon = {
      round: 12345,
      randomness: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      signature: "bls_sig_hex",
    };
    const proof = createDiceProof(beacon, "xion1white", "xion1black", 1);

    expect(proof.drandRound).toBe(12345);
    expect(proof.drandRandomness).toBe(beacon.randomness);
    expect(proof.drandSignature).toBe(beacon.signature);
    expect(proof.playerWhite).toBe("xion1white");
    expect(proof.playerBlack).toBe("xion1black");
    expect(proof.turnNumber).toBe(1);
    expect(proof.dice).toHaveLength(2);
    expect(proof.dice[0]).toBeGreaterThanOrEqual(1);
    expect(proof.dice[1]).toBeLessThanOrEqual(6);
  });
});

describe("verifyDiceDerivation", () => {
  it("verifies a valid proof", () => {
    const beacon = {
      round: 99,
      randomness: "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      signature: "sig",
    };
    const proof = createDiceProof(beacon, "xion1a", "xion1b", 5);
    expect(verifyDiceDerivation(proof)).toBe(true);
  });

  it("rejects a tampered proof", () => {
    const beacon = {
      round: 99,
      randomness: "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      signature: "sig",
    };
    const proof = createDiceProof(beacon, "xion1a", "xion1b", 5);
    // Tamper with dice: flip die1 to a guaranteed-different value
    const flippedDie1 = proof.dice[0] === 1 ? 2 : 1;
    const tampered = { ...proof, dice: [flippedDie1, proof.dice[1]] as [number, number] };
    expect(verifyDiceDerivation(tampered)).toBe(false);
  });

  it("rejects proof with wrong turn number", () => {
    const beacon = {
      round: 99,
      randomness: "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      signature: "sig",
    };
    const proof = createDiceProof(beacon, "xion1a", "xion1b", 5);
    const wrong = { ...proof, turnNumber: 6 };
    expect(verifyDiceDerivation(wrong)).toBe(false);
  });
});
