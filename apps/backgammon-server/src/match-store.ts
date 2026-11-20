import { randomUUID } from "node:crypto";
import {
  isCrawfordGame,
  isMatchOver,
  scoreGame as applyGameScore,
  type GameState,
  type MatchState,
  type Player,
  type ResultType,
} from "@xion-beginner/backgammon-core";
import { getPool } from "./db.js";
import { reserveWaitingGame } from "./game-store.js";
import { INTER_GAME_DELAY_MS } from "./config.js";

export interface DurableMatch {
  id: string;
  matchState: MatchState;
  currentGameId: string;
  playerWhiteAddress: string;
  playerBlackAddress: string;
  wagerAmount: number;
  status: "playing" | "finished";
}

export interface DurableMatchScore {
  matchOver: boolean;
  matchWinner: Player | null;
  matchState: MatchState;
  isCrawfordNext: boolean;
  continuationDurable: boolean;
  applied: boolean;
}

export interface DurableMatchContinuation {
  matchId: string;
  completedGameId: string;
  nextGameId: string;
  gameNumber: number;
  playerWhiteAddress: string;
  playerBlackAddress: string;
}
export async function createDurableMatch(match: DurableMatch): Promise<boolean> {
  if (match.wagerAmount !== 0) throw new Error("PAID_MATCH_UNSUPPORTED");
  const pool = getPool();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO backgammon_matches
        (id, match_state, current_game_id, player_white_address, player_black_address,
         wager_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
         SET updated_at = backgammon_matches.updated_at
       WHERE backgammon_matches.match_state IS NOT DISTINCT FROM EXCLUDED.match_state
         AND backgammon_matches.current_game_id = EXCLUDED.current_game_id
         AND backgammon_matches.player_white_address = EXCLUDED.player_white_address
         AND backgammon_matches.player_black_address = EXCLUDED.player_black_address
         AND backgammon_matches.wager_amount = EXCLUDED.wager_amount
         AND backgammon_matches.status = EXCLUDED.status
       RETURNING id`,
      [
        match.id,
        match.matchState,
        match.currentGameId,
        match.playerWhiteAddress,
        match.playerBlackAddress,
        match.wagerAmount,
        match.status,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error("MATCH_ALREADY_EXISTS");
    const gameLinked = await client.query(
      `INSERT INTO backgammon_match_games (game_id, match_id)
       VALUES ($1, $2)
       ON CONFLICT (game_id) DO UPDATE
         SET match_id = EXCLUDED.match_id
       WHERE backgammon_match_games.match_id = EXCLUDED.match_id
       RETURNING game_id`,
      [match.currentGameId, match.id],
    );
    if (gameLinked.rowCount !== 1) throw new Error("GAME_ALREADY_IN_MATCH");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setDurableCurrentGame(matchId: string, gameId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE backgammon_matches
          SET current_game_id = $2,
              continuation_deadline_at = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND status = 'playing'
          AND EXISTS (
            SELECT 1 FROM games
             WHERE id = $2 AND status = 'playing'
          )
          AND (
            continuation_deadline_at IS NULL
            OR continuation_deadline_at > NOW()
          )`,
      [matchId, gameId],
    );
    if (updated.rowCount !== 1) throw new Error("MATCH_NOT_PLAYING");
    await client.query(
      `INSERT INTO backgammon_match_games (game_id, match_id)
       VALUES ($1, $2)
       ON CONFLICT (game_id) DO NOTHING`,
      [gameId, matchId],
    );
    const mapping = await client.query<{ match_id: string }>(
      "SELECT match_id FROM backgammon_match_games WHERE game_id = $1",
      [gameId],
    );
    if (mapping.rows[0]?.match_id !== matchId) throw new Error("GAME_MATCH_CONFLICT");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function scoreDurableMatchGame(
  gameId: string,
  winner: Player,
  resultType: ResultType,
  cubeValue: number,
): Promise<DurableMatchScore | null | undefined> {
  const pool = getPool();
  if (!pool) return undefined;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      match_id: string;
      match_state: MatchState;
      status: "playing" | "finished";
      score_result: DurableMatchScore | null;
      player_white_address: string;
      player_black_address: string;
    }>(
      `SELECT m.id AS match_id, m.match_state, m.status, mg.score_result,
              m.player_white_address, m.player_black_address
         FROM backgammon_match_games mg
         JOIN backgammon_matches m ON m.id = mg.match_id
        WHERE mg.game_id = $1
        FOR UPDATE OF m, mg`,
      [gameId],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    if (row.score_result) {
      await client.query("COMMIT");
      return {
        ...row.score_result,
        continuationDurable: row.score_result.continuationDurable ?? !row.score_result.matchOver,
        applied: false,
      };
    }
    if (row.status !== "playing") throw new Error("MATCH_NOT_PLAYING");

    const matchState = applyGameScore(row.match_state, winner, resultType, cubeValue);
    const completion = isMatchOver(matchState);
    const score: DurableMatchScore = {
      matchOver: completion.over,
      matchWinner: completion.winner,
      matchState,
      isCrawfordNext: isCrawfordGame(matchState),
      continuationDurable: !completion.over,
      applied: true,
    };
    if (completion.over) {
      await client.query(
        `UPDATE backgammon_matches
            SET match_state = $2,
                status = 'finished',
                continuation_deadline_at = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [row.match_id, matchState],
      );
      await client.query(
        "DELETE FROM active_game_principals WHERE game_id = $1",
        [gameId],
      );
    } else {
      const nextGameId = randomUUID();
      const swapColors = matchState.gameNumber % 2 === 0;
      const white = swapColors ? row.player_black_address : row.player_white_address;
      const black = swapColors ? row.player_white_address : row.player_black_address;
      await reserveWaitingGame(client, {
        id: nextGameId,
        playerWhite: white,
        playerBlack: black,
        turnTimeLimit: 60,
        doublingAllowed: !isCrawfordGame(matchState),
        ownerInstanceId: `match:${row.match_id}`,
        replacesGameId: gameId,
      });
      await client.query(
        `UPDATE backgammon_matches
            SET match_state = $2,
                current_game_id = $3,
                continuation_deadline_at = NOW() + INTERVAL '15 minutes',
                terminal_reason = NULL,
                updated_at = NOW()
          WHERE id = $1 AND status = 'playing'`,
        [row.match_id, matchState, nextGameId],
      );
      await client.query(
        `INSERT INTO backgammon_match_games (game_id, match_id)
         VALUES ($1, $2)`,
        [nextGameId, row.match_id],
      );
      await client.query(
        `INSERT INTO backgammon_match_continuations
          (match_id, completed_game_id, next_game_id, game_number,
           player_white_address, player_black_address, available_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 millisecond'))
         ON CONFLICT (match_id, completed_game_id) DO NOTHING`,
        [row.match_id, gameId, nextGameId, matchState.gameNumber, white, black, INTER_GAME_DELAY_MS],
      );
    }
    await client.query(
      "UPDATE backgammon_match_games SET score_result = $2 WHERE game_id = $1",
      [gameId, score],
    );
    await client.query("COMMIT");
    return score;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export interface UnscoredDurableMatchGame {
  readonly gameId: string;
  readonly winner: Player;
  readonly resultType: ResultType;
  readonly cubeValue: number;
}

export async function listUnscoredDurableMatchGames(limit = 32): Promise<UnscoredDurableMatchGame[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query<{ game_id: string; game_state: GameState }>(
    `SELECT match_game.game_id, game.game_state
       FROM backgammon_match_games match_game
       JOIN games game ON game.id = match_game.game_id
      WHERE match_game.score_result IS NULL
        AND game.status = 'finished'
      ORDER BY game.finished_at, match_game.created_at, match_game.game_id
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 128))],
  );
  return result.rows.flatMap((row) => {
    const state = row.game_state;
    if (
      state?.gameOver !== true
      || (state.winner !== "white" && state.winner !== "black")
      || !["normal", "gammon", "backgammon"].includes(state.resultType ?? "")
      || ![1, 2, 4, 8].includes(state.cubeValue)
    ) return [];
    return [{
      gameId: row.game_id,
      winner: state.winner,
      resultType: state.resultType as ResultType,
      cubeValue: state.cubeValue,
    }];
  });
}

export async function assignMatchContinuationOwner(
  completedGameId: string,
  instanceId: string,
): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  const assigned = await pool.query<{ owner_instance_id: string }>(
    `UPDATE backgammon_match_continuations continuation
        SET owner_instance_id = $2,
            owner_expires_at = NOW() + INTERVAL '30 seconds',
            updated_at = NOW()
      WHERE completed_game_id = $1
        AND state = 'pending'
        AND EXISTS (
          SELECT 1
            FROM backgammon_matches match
           WHERE match.id = continuation.match_id
             AND match.status = 'playing'
             AND match.current_game_id = continuation.next_game_id
             AND match.continuation_deadline_at > NOW()
        )
        AND (
          owner_instance_id IS NULL
          OR owner_expires_at <= NOW()
          OR owner_instance_id = $2
        )
    RETURNING owner_instance_id`,
    [completedGameId, instanceId],
  );
  if (assigned.rows[0]) return assigned.rows[0].owner_instance_id;
  const current = await pool.query<{ owner_instance_id: string | null }>(
    `SELECT continuation.owner_instance_id
       FROM backgammon_match_continuations continuation
       JOIN backgammon_matches match ON match.id = continuation.match_id
      WHERE continuation.completed_game_id = $1
        AND continuation.state = 'pending'
        AND match.status = 'playing'
        AND match.current_game_id = continuation.next_game_id
        AND match.continuation_deadline_at > NOW()`,
    [completedGameId],
  );
  return current.rows[0]?.owner_instance_id ?? null;
}

export async function routePendingMatchContinuation(
  principal: string,
  instanceId: string,
  completedGameId: string | null = null,
): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query<{
      match_id: string;
      completed_game_id: string;
      owner_instance_id: string | null;
      owner_expires_at: Date | null;
    }>(
      `SELECT continuation.match_id, continuation.completed_game_id,
              continuation.owner_instance_id, continuation.owner_expires_at
         FROM backgammon_match_continuations continuation
         JOIN backgammon_matches match ON match.id = continuation.match_id
        WHERE continuation.state = 'pending'
          AND (continuation.player_white_address = $1 OR continuation.player_black_address = $1)
          AND ($2::text IS NULL OR continuation.completed_game_id = $2)
          AND match.status = 'playing'
          AND match.current_game_id = continuation.next_game_id
          AND match.continuation_deadline_at > NOW()
        ORDER BY continuation.created_at DESC
        LIMIT 1
        FOR UPDATE OF continuation, match`,
      [principal, completedGameId],
    );
    const row = pending.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const owner = row.owner_instance_id
      && row.owner_expires_at
      && row.owner_expires_at.getTime() > Date.now()
      ? row.owner_instance_id
      : instanceId;
    const routed = await client.query(
      `UPDATE backgammon_match_continuations continuation
          SET owner_instance_id = $3,
              owner_expires_at = NOW() + INTERVAL '30 seconds',
              updated_at = NOW()
        WHERE match_id = $1
          AND completed_game_id = $2
          AND state = 'pending'
          AND EXISTS (
            SELECT 1
              FROM backgammon_matches match
             WHERE match.id = continuation.match_id
               AND match.status = 'playing'
               AND match.current_game_id = continuation.next_game_id
               AND match.continuation_deadline_at > NOW()
          )
      RETURNING owner_instance_id`,
      [row.match_id, row.completed_game_id, owner],
    );
    if (routed.rowCount !== 1) {
      await client.query("COMMIT");
      return null;
    }
    await client.query("COMMIT");
    return owner;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseOwnedMatchContinuations(instanceId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `UPDATE backgammon_match_continuations
        SET owner_instance_id = NULL, owner_expires_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE state = 'pending' AND owner_instance_id = $1`,
    [instanceId],
  );
}

export async function claimPendingMatchContinuations(
  leaseOwner: string,
  limit = 8,
): Promise<DurableMatchContinuation[]> {
  const pool = getPool();
  if (!pool) return [];
  const claimed = await pool.query<{
    match_id: string;
    completed_game_id: string;
    next_game_id: string;
    game_number: number;
    player_white_address: string;
    player_black_address: string;
  }>(
    `WITH candidates AS (
       SELECT continuation.match_id, continuation.completed_game_id
         FROM backgammon_match_continuations continuation
         JOIN backgammon_matches match ON match.id = continuation.match_id
        WHERE continuation.state = 'pending'
          AND continuation.available_at <= NOW()
          AND continuation.owner_instance_id = $1
          AND continuation.owner_expires_at > NOW()
          AND (continuation.lease_expires_at IS NULL OR continuation.lease_expires_at <= NOW())
          AND match.status = 'playing'
          AND match.current_game_id = continuation.next_game_id
          AND match.continuation_deadline_at > NOW()
        ORDER BY continuation.available_at, continuation.match_id, continuation.completed_game_id
        FOR UPDATE OF continuation, match SKIP LOCKED
        LIMIT $2
     )
     UPDATE backgammon_match_continuations continuation
        SET lease_owner = $1,
            lease_expires_at = NOW() + INTERVAL '30 seconds',
            owner_expires_at = NOW() + INTERVAL '30 seconds',
            updated_at = NOW()
       FROM candidates
      WHERE continuation.match_id = candidates.match_id
        AND continuation.completed_game_id = candidates.completed_game_id
     RETURNING continuation.match_id, continuation.completed_game_id,
               continuation.next_game_id, continuation.game_number,
               continuation.player_white_address, continuation.player_black_address`,
    [leaseOwner, Math.max(1, Math.min(limit, 32))],
  );
  return claimed.rows.map((row) => ({
    matchId: row.match_id,
    completedGameId: row.completed_game_id,
    nextGameId: row.next_game_id,
    gameNumber: row.game_number,
    playerWhiteAddress: row.player_white_address,
    playerBlackAddress: row.player_black_address,
  }));
}

export async function releaseMatchContinuation(
  continuation: DurableMatchContinuation,
  leaseOwner: string,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `UPDATE backgammon_match_continuations
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE match_id = $1 AND completed_game_id = $2
        AND state = 'pending' AND lease_owner = $3`,
    [continuation.matchId, continuation.completedGameId, leaseOwner],
  );
}

export async function completeMatchContinuation(
  continuation: DurableMatchContinuation,
  leaseOwner: string,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const completed = await pool.query(
    `UPDATE backgammon_match_continuations
        SET state = 'ready', lease_owner = NULL, lease_expires_at = NULL,
            owner_instance_id = NULL, owner_expires_at = NULL, updated_at = NOW()
      WHERE match_id = $1 AND completed_game_id = $2
        AND state = 'pending' AND lease_owner = $3 AND lease_expires_at > NOW()`,
    [continuation.matchId, continuation.completedGameId, leaseOwner],
  );
  if (completed.rowCount !== 1) throw new Error("MATCH_CONTINUATION_LEASE_LOST");
}


export async function loadDurableMatch(
  matchId: string,
): Promise<(DurableMatch & { gameIds: string[] }) | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query<{
    id: string;
    match_state: MatchState;
    current_game_id: string;
    player_white_address: string;
    player_black_address: string;
    wager_amount: string;
    status: "playing" | "finished";
    game_ids: string[];
  }>(
    `SELECT m.id, m.match_state, m.current_game_id, m.player_white_address,
            m.player_black_address, m.wager_amount::text, m.status,
            ARRAY_AGG(mg.game_id ORDER BY mg.created_at) AS game_ids
       FROM backgammon_matches m
       JOIN backgammon_match_games mg ON mg.match_id = m.id
      WHERE m.id = $1 AND m.status = 'playing'
      GROUP BY m.id`,
    [matchId],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    matchState: row.match_state,
    currentGameId: row.current_game_id,
    playerWhiteAddress: row.player_white_address,
    playerBlackAddress: row.player_black_address,
    wagerAmount: Number(row.wager_amount),
    status: row.status,
    gameIds: row.game_ids,
  } : null;
}

export async function loadDurableMatches(): Promise<Array<DurableMatch & { gameIds: string[] }>> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query<{
    id: string;
    match_state: MatchState;
    current_game_id: string;
    player_white_address: string;
    player_black_address: string;
    wager_amount: string;
    status: "playing" | "finished";
    game_ids: string[];
  }>(
    `SELECT m.id, m.match_state, m.current_game_id, m.player_white_address,
            m.player_black_address, m.wager_amount::text, m.status,
            ARRAY_AGG(mg.game_id ORDER BY mg.created_at) AS game_ids
       FROM backgammon_matches m
       JOIN backgammon_match_games mg ON mg.match_id = m.id
      WHERE m.status = 'playing'
      GROUP BY m.id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    matchState: row.match_state,
    currentGameId: row.current_game_id,
    playerWhiteAddress: row.player_white_address,
    playerBlackAddress: row.player_black_address,
    wagerAmount: Number(row.wager_amount),
    status: row.status,
    gameIds: row.game_ids,
  }));
}
