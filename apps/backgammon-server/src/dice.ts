import { createHash } from "node:crypto";
import type { DrandBeacon } from "./drand.js";

// ── Types ─────────────────────────────────────────────────────────

export interface DrandDiceProof {
  drandRound: number;
  drandRandomness: string;  // 32 bytes hex
  drandSignature: string;   // BLS signature hex
  playerWhite: string;
  playerBlack: string;
  turnNumber: number;
  dice: [number, number];
}

// ── Dice derivation ───────────────────────────────────────────────

/** Derive deterministic dice from drand randomness + game context */
export function deriveDice(
  drandRandomness: string,
  playerWhite: string,
  playerBlack: string,
  turnNumber: number,
): [number, number] {
  const combined = createHash("sha256")
    .update(drandRandomness + playerWhite + playerBlack + String(turnNumber))
    .digest();

  const die1 = (combined[0] % 6) + 1;
  const die2 = (combined[1] % 6) + 1;
  return [die1, die2];
}

/** Create a full dice proof from a drand beacon */
export function createDiceProof(
  beacon: DrandBeacon,
  playerWhite: string,
  playerBlack: string,
  turnNumber: number,
): DrandDiceProof {
  const dice = deriveDice(beacon.randomness, playerWhite, playerBlack, turnNumber);
  return {
    drandRound: beacon.round,
    drandRandomness: beacon.randomness,
    drandSignature: beacon.signature,
    playerWhite,
    playerBlack,
    turnNumber,
    dice,
  };
}

/** Verify that dice were correctly derived from drand randomness (does NOT verify BLS sig — that requires drand-client or @noble/curves) */
export function verifyDiceDerivation(proof: DrandDiceProof): boolean {
  const expected = deriveDice(proof.drandRandomness, proof.playerWhite, proof.playerBlack, proof.turnNumber);
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
