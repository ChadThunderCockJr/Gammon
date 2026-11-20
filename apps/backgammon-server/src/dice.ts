import { createHash } from "node:crypto";
import type { DrandBeacon } from "./drand.js";
import {
  canonicalDiceCommitmentInput,
  canonicalDiceDerivationInput,
  type DiceDerivationDomain,
} from "@xion-beginner/backgammon-core";

// ── Types ─────────────────────────────────────────────────────────

export type DiceDerivationContext = DiceDerivationDomain;

export interface DrandDiceProof extends DiceDerivationContext {
  readonly drandSignature: string;
  readonly dice: [number, number];
  readonly derivationVersion: "gammon.dice-result.v2";
}

type CommitmentContext = Omit<DiceDerivationContext, "drandRandomness">;
type ProofContext = Omit<DiceDerivationContext, "drandRandomness" | "drandRound">;

export function diceCommitmentContext(input: CommitmentContext): string {
  return createHash("sha256").update(canonicalDiceCommitmentInput(input)).digest("hex");
}

/**
 * Derive deterministic, unbiased dice from a committed drand beacon and the
 * complete game domain. Bytes 252-255 are rejected so every face has exactly
 * 42 representatives. Opening-roll ties consume the next deterministic pair.
 */
export function deriveDice(input: DiceDerivationContext): [number, number] {
  let first: number | null = null;
  for (let counter = 0; ; counter += 1) {
    const block = createHash("sha256").update(canonicalDiceDerivationInput(input, counter)).digest();
    for (const byte of block) {
      if (byte >= 252) continue;
      const value = (byte % 6) + 1;
      if (first === null) {
        first = value;
        continue;
      }
      if (input.openingRoll && first === value) {
        first = null;
        continue;
      }
      return [first, value];
    }
  }
}

export function createDiceProof(
  beacon: DrandBeacon,
  context: ProofContext,
): DrandDiceProof {
  const derivation: DiceDerivationContext = {
    ...context,
    drandRound: beacon.round,
    drandRandomness: beacon.randomness,
  };
  return {
    ...derivation,
    drandSignature: beacon.signature,
    dice: deriveDice(derivation),
    derivationVersion: "gammon.dice-result.v2",
  };
}

/** Verify deterministic derivation. BLS verification is performed by drand-client on ingest. */
export function verifyDiceDerivation(proof: DrandDiceProof): boolean {
  if (proof.derivationVersion !== "gammon.dice-result.v2") return false;
  const expected = deriveDice(proof);
  return expected[0] === proof.dice[0] && expected[1] === proof.dice[1];
}

// ── Dice history (stores proofs per game) ─────────────────────────

export class GameDiceHistory {
  private proofs: Map<number, DrandDiceProof> = new Map(); // turnNumber -> proof

  /** Store a dice proof for a turn */
  addProof(proof: DrandDiceProof): void {
    this.proofs.set(proof.turnNumber, proof);
  }

  /** Get full history for verification (all turns) */
  getHistory(): DrandDiceProof[] {
    return Array.from(this.proofs.values())
      .sort((a, b) => a.turnNumber - b.turnNumber);
  }
}
