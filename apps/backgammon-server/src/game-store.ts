import { getPool } from "./db.js";
import { logger } from "./logger.js";
import type { GameState, Player, Move } from "@xion-beginner/backgammon-core";

/**
 * Persistent game storage backed by PostgreSQL.
 * Every game state change is persisted so no data is lost on server restart.
 */

/** Save or update a game record */
export async function persistGame(
  gameId: string,
  playerWhite: string | null,
  playerBlack: string | null,
  wagerAmount: number,
  status: string,
  escrowStatus: string,
  gameState: GameState,
  turnTimeLimit: number,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query(
      `INSERT INTO games (id, player_white, player_black, wager_amount, status, escrow_status, game_state, turn_time_limit, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         player_white = $2, player_black = $3, status = $5,
         escrow_status = $6, game_state = $7, updated_at = NOW()`,
      [gameId, playerWhite, playerBlack, wagerAmount, status, escrowStatus, JSON.stringify(gameState), turnTimeLimit],
    );
    return true;
  } catch (err) {
    logger.error("Failed to persist game", { gameId, error: String(err) });
    return false;
  }
}

/** Record a move for the audit trail */
export async function persistMove(
  gameId: string,
  turnNumber: number,
  player: string,
  from: number,
  to: number,
  gameStateAfter: GameState,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query(
      `INSERT INTO moves (game_id, turn_number, player, move_from, move_to, game_state_after)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [gameId, turnNumber, player, from, to, JSON.stringify(gameStateAfter)],
    );
    return true;
  } catch (err) {
    logger.error("Failed to persist move", { gameId, error: String(err) });
    return false;
  }
}

/** Record a dice roll with drand proof */
export async function persistDiceRoll(
  gameId: string,
  turnNumber: number,
  player: string,
  die1: number,
  die2: number,
  drandProof?: { round: number; randomness: string; signature: string },
  drandFailed?: boolean,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query(
      `INSERT INTO dice_rolls (game_id, turn_number, player, die1, die2, drand_round, drand_randomness, drand_signature, drand_failed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        gameId, turnNumber, player, die1, die2,
        drandProof?.round ?? null,
        drandProof?.randomness ?? null,
        drandProof?.signature ?? null,
        drandFailed ?? false,
      ],
    );
    return true;
  } catch (err) {
    logger.error("Failed to persist dice roll", { gameId, error: String(err) });
    return false;
  }
}

/** Mark a game as finished */
export async function finishGame(gameId: string, status: string, escrowStatus: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query(
      `UPDATE games SET status = $2, escrow_status = $3, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [gameId, status, escrowStatus],
    );
    return true;
  } catch (err) {
    logger.error("Failed to finish game", { gameId, error: String(err) });
    return false;
  }
}

/** Load all active (unfinished) games for server restart recovery */
export async function loadActiveGames(): Promise<Array<{
  id: string;
  playerWhite: string | null;
  playerBlack: string | null;
  wagerAmount: number;
  status: string;
  escrowStatus: string;
  gameState: GameState;
  turnTimeLimit: number;
}>> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT id, player_white, player_black, wager_amount, status, escrow_status, game_state, turn_time_limit
       FROM games
       WHERE status IN ('waiting', 'depositing', 'playing')
       ORDER BY created_at DESC`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      playerWhite: row.player_white,
      playerBlack: row.player_black,
      wagerAmount: row.wager_amount,
      status: row.status,
      escrowStatus: row.escrow_status,
      gameState: row.game_state as GameState,
      turnTimeLimit: row.turn_time_limit,
    }));
  } catch (err) {
    logger.error("Failed to load active games", { error: String(err) });
    return [];
  }
}

/** Get all dice rolls for a game (for the audit page) */
export async function getGameDiceRolls(gameId: string): Promise<Array<{
  turnNumber: number;
  player: string;
  die1: number;
  die2: number;
  drandRound: number | null;
  drandRandomness: string | null;
  drandSignature: string | null;
  drandFailed: boolean;
}>> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT turn_number, player, die1, die2, drand_round, drand_randomness, drand_signature, drand_failed
       FROM dice_rolls
       WHERE game_id = $1
       ORDER BY turn_number ASC`,
      [gameId],
    );

    return result.rows.map((row) => ({
      turnNumber: row.turn_number,
      player: row.player,
      die1: row.die1,
      die2: row.die2,
      drandRound: row.drand_round,
      drandRandomness: row.drand_randomness,
      drandSignature: row.drand_signature,
      drandFailed: row.drand_failed,
    }));
  } catch (err) {
    logger.error("Failed to get dice rolls", { gameId, error: String(err) });
    return [];
  }
}

/** Get all moves for a game (for replay) */
export async function getGameMoves(gameId: string): Promise<Array<{
  turnNumber: number;
  player: string;
  from: number;
  to: number;
  gameStateAfter: GameState;
}>> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT turn_number, player, move_from, move_to, game_state_after
       FROM moves
       WHERE game_id = $1
       ORDER BY id ASC`,
      [gameId],
    );

    return result.rows.map((row) => ({
      turnNumber: row.turn_number,
      player: row.player,
      from: row.move_from,
      to: row.move_to,
      gameStateAfter: row.game_state_after as GameState,
    }));
  } catch (err) {
    logger.error("Failed to get game moves", { gameId, error: String(err) });
    return [];
  }
}
