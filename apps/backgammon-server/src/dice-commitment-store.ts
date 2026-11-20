import type { PoolClient } from "pg";
import { getPool } from "./db.js";
import type { DrandDiceProof } from "./dice.js";

export interface DiceCommitment {
  readonly round: number;
  readonly contextHex: string;
  readonly commitHash: string;
}

async function commitmentRow(client: PoolClient, gameId: string, turnNumber: number) {
  return client.query<{
    drand_round: string;
    context_hex: string;
  }>(
    `SELECT drand_round::text, context_hex
       FROM dice_rolls
      WHERE game_id = $1 AND turn_number = $2
      FOR UPDATE`,
    [gameId, turnNumber],
  );
}

export async function persistFutureRoundCommitment(input: {
  readonly gameId: string;
  readonly turnNumber: number;
  readonly player: string;
  readonly proposedRound: number;
  readonly contextHex: string;
  readonly commitHash: string;
}): Promise<DiceCommitment | null> {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO dice_rolls
        (game_id, turn_number, player, drand_round, context_hex, committed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (game_id, turn_number) DO NOTHING`,
      [input.gameId, input.turnNumber, input.player, input.proposedRound, input.contextHex],
    );
    const result = await commitmentRow(client, input.gameId, input.turnNumber);
    const row = result.rows[0];
    if (!row || !row.context_hex || !row.drand_round) throw new Error("DICE_COMMITMENT_INVALID");
    await client.query("COMMIT");
    return {
      round: Number(row.drand_round),
      contextHex: row.context_hex,
      commitHash: row.context_hex,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function revealCommittedDice(input: {
  readonly gameId: string;
  readonly turnNumber: number;
  readonly player: string;
  readonly round: number;
  readonly contextHex: string;
  readonly die1: number;
  readonly die2: number;
  readonly randomness: string;
  readonly signature: string;
  readonly proof: DrandDiceProof;
}): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE dice_rolls
        SET die1 = $6, die2 = $7, drand_randomness = $8, drand_signature = $9,
            proof_json = $10, drand_failed = FALSE, revealed_at = NOW()
      WHERE game_id = $1 AND turn_number = $2 AND player = $3
        AND drand_round = $4 AND context_hex = $5
        AND (
          (die1 IS NULL AND die2 IS NULL AND proof_json IS NULL)
          OR (
            die1 = $6 AND die2 = $7 AND drand_randomness = $8
            AND drand_signature = $9 AND proof_json = $10::jsonb
          )
        )`,
    [
      input.gameId,
      input.turnNumber,
      input.player,
      input.round,
      input.contextHex,
      input.die1,
      input.die2,
      input.randomness,
      input.signature,
      JSON.stringify(input.proof),
    ],
  );
  return result.rowCount === 1;
}
