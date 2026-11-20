import type { PoolClient } from "pg";
import { getPool } from "./db.js";
import { logger } from "./logger.js";
import { createGameState, type GameState, type Player, type Move } from "@xion-beginner/backgammon-core";
import type { GamePhase, GameReviewReason } from "./types.js";
import type { DrandDiceProof } from "./dice.js";

export interface PersistedGameServerState {
  readonly turnMoveStack?: GameState[];
  readonly pendingConfirmation?: string | null;
  readonly pendingResignation?: {
    player: string;
    resignType: "normal" | "gammon" | "backgammon";
    previousPhase: "await_roll" | "playing_moves" | "await_confirmation";
    previousDeadlineAt: number;
    offeredAt: number;
    deadlineAt: number;
    offerRevision: number;
  } | null;
  readonly pendingDoubleOffer?: {
    doubler: string;
    offeredCube: 2 | 4 | 8;
    offeredAt: number;
    deadlineAt: number;
    offerRevision: number;
  } | null;
  readonly disconnectedPlayer?: string | null;
  readonly disconnectedAt?: number | null;
  readonly pendingMatchLength?: number;
  readonly doublingAllowed?: boolean;
  readonly cashQuoteId?: string;
  readonly reviewReason?: GameReviewReason;
  readonly cashRules?: Record<string, unknown>;
}

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
  revision = 0,
  phase: GamePhase = "await_roll",
  deadlineAt: Date | null = null,
  serverState: PersistedGameServerState = {},
  ownerInstanceId?: string,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const principals = [...new Set([playerWhite, playerBlack].filter((principal): principal is string => principal !== null))].sort();
  const activeStatus = ["waiting", "depositing", "playing"].includes(status);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const principal of principals) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal]);
    }
    const result = await client.query(
      `INSERT INTO games
        (id, player_white, player_black, wager_amount, status, escrow_status,
         game_state, turn_time_limit, revision, phase, deadline_at, server_state, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         player_white = EXCLUDED.player_white,
         player_black = EXCLUDED.player_black,
         wager_amount = EXCLUDED.wager_amount,
         status = EXCLUDED.status,
         escrow_status = EXCLUDED.escrow_status,
         game_state = EXCLUDED.game_state,
         turn_time_limit = EXCLUDED.turn_time_limit,
         revision = EXCLUDED.revision,
         phase = EXCLUDED.phase,
         deadline_at = EXCLUDED.deadline_at,
         server_state = EXCLUDED.server_state,
         updated_at = NOW()
       WHERE (
         games.revision < EXCLUDED.revision
         OR (
           games.revision = EXCLUDED.revision
           AND games.player_white IS NOT DISTINCT FROM EXCLUDED.player_white
           AND games.player_black IS NOT DISTINCT FROM EXCLUDED.player_black
           AND games.wager_amount = EXCLUDED.wager_amount
           AND games.status = EXCLUDED.status
           AND games.escrow_status = EXCLUDED.escrow_status
           AND games.game_state IS NOT DISTINCT FROM EXCLUDED.game_state
           AND games.turn_time_limit = EXCLUDED.turn_time_limit
           AND games.phase = EXCLUDED.phase
           AND games.deadline_at IS NOT DISTINCT FROM EXCLUDED.deadline_at
           AND games.server_state IS NOT DISTINCT FROM EXCLUDED.server_state
         )
       )
       AND (games.status NOT IN ('finished', 'abandoned') OR EXCLUDED.status IN ('finished', 'abandoned'))
       AND NOT (
         EXCLUDED.status = 'playing'
         AND EXISTS (
           SELECT 1
             FROM backgammon_match_games match_game
             JOIN backgammon_matches match ON match.id = match_game.match_id
            WHERE match_game.game_id = games.id
              AND match.current_game_id = games.id
              AND match.status = 'playing'
              AND match.continuation_deadline_at IS NOT NULL
              AND match.continuation_deadline_at <= NOW()
         )
       )
       AND (
         $13::text IS NULL
         OR EXISTS (
           SELECT 1 FROM connection_leases
            WHERE principal = $14
              AND session_hash = $15
              AND purpose = $16
              AND game_id = $1
              AND instance_id = $13
              AND expires_at > NOW()
         )
       )`,
      [
        gameId,
        playerWhite,
        playerBlack,
        wagerAmount,
        status,
        escrowStatus,
        JSON.stringify(gameState),
        turnTimeLimit,
        revision,
        phase,
        deadlineAt,
        JSON.stringify(serverState),
        ownerInstanceId ?? null,
        gameOwnerPrincipal(gameId),
        GAME_OWNER_SESSION,
        GAME_OWNER_PURPOSE,
      ],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    if (status === "playing") {
      await client.query(
        `UPDATE backgammon_matches
            SET continuation_deadline_at = NULL, updated_at = NOW()
          WHERE current_game_id = $1
            AND status = 'playing'
            AND continuation_deadline_at IS NOT NULL
            AND continuation_deadline_at > NOW()`,
        [gameId],
      );
    }
    await client.query(
      `DELETE FROM active_game_principals active
        WHERE active.game_id = $1
          AND (
            (
              $3::boolean
              AND (cardinality($2::text[]) = 0 OR active.principal <> ALL($2::text[]))
            )
            OR (
              NOT $3::boolean
              AND NOT EXISTS (
                SELECT 1
                  FROM games game
                  JOIN backgammon_match_games match_game ON match_game.game_id = game.id
                  JOIN backgammon_matches match ON match.id = match_game.match_id
                 WHERE game.id = $1
                   AND match.status = 'playing'
                   AND match.current_game_id = game.id
                   AND active.principal IN (game.player_white, game.player_black)
              )
            )
          )`,
      [gameId, principals, activeStatus],
    );
    if (activeStatus && principals.length > 0) {
      const claimed = await client.query<{ principal: string }>(
        `INSERT INTO active_game_principals (principal, game_id, updated_at)
         SELECT principal, $2, NOW() FROM unnest($1::text[]) AS principal
         ON CONFLICT (principal) DO UPDATE
           SET game_id = EXCLUDED.game_id, updated_at = NOW()
         WHERE active_game_principals.game_id = EXCLUDED.game_id
         RETURNING principal`,
        [principals, gameId],
      );
      if (claimed.rowCount !== principals.length) {
        await client.query("ROLLBACK");
        return false;
      }
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is being released after an already-failed transaction.
    }
    logger.error("Failed to persist game", { gameId, error: String(err) });
    return false;
  } finally {
    client.release();
  }
}
export interface GameCommand {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly principal: string;
  readonly commandType: string;
  readonly eventType: string;
}

export interface GameCommandCommit {
  readonly revision: number;
  readonly replayed: boolean;
  readonly result: unknown;
}

export interface GameCommandReplay {
  readonly revision: number;
  readonly result: unknown;
}

export async function replayGameCommand(
  gameId: string,
  command: GameCommand,
): Promise<GameCommandReplay | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query<{
    game_id: string;
    principal: string;
    expected_revision: string;
    command_type: string;
    committed_revision: string | null;
    result: unknown;
  }>(
    `SELECT game_id, principal, expected_revision::text, command_type, committed_revision::text, result
       FROM game_commands
      WHERE command_id = $1`,
    [command.commandId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.game_id !== gameId ||
    row.principal !== command.principal ||
    row.command_type !== command.commandType ||
    Number(row.expected_revision) !== command.expectedRevision
  ) throw new Error("COMMAND_ID_REUSE");
  if (!row.committed_revision) throw new Error("COMMAND_IN_PROGRESS");
  return { revision: Number(row.committed_revision), result: row.result };
}

const GAME_OWNER_SESSION = "writer";
const GAME_OWNER_PURPOSE = "cash-game-writer";

function gameOwnerPrincipal(gameId: string): string {
  return `game:${gameId}`;
}

export interface ReservedWaitingGame {
  readonly id: string;
  readonly playerWhite: string;
  readonly playerBlack: string;
  readonly turnTimeLimit: number;
  readonly doublingAllowed: boolean;
  readonly pendingMatchLength?: number;
  readonly ownerInstanceId: string;
  /** Transfer an existing durable participant reservation as part of a match continuation. */
  readonly replacesGameId?: string;
}

/**
 * The sole durable publication primitive for a preassigned free game.  The
 * game aggregate, both participant reservations, and its routable owner lease
 * become visible in the same transaction.
 */
export async function reserveWaitingGame(client: PoolClient, game: ReservedWaitingGame): Promise<void> {
  const principals = [game.playerWhite, game.playerBlack].sort();
  for (const principal of principals) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal]);
  }
  await client.query(
    `INSERT INTO games
      (id, player_white, player_black, wager_amount, status, escrow_status,
       game_state, turn_time_limit, revision, phase, deadline_at, server_state, updated_at)
     VALUES ($1, $2, $3, 0, 'waiting', 'none', $4, $5, 0, 'waiting', NULL, $6, NOW())`,
    [
      game.id, game.playerWhite, game.playerBlack, JSON.stringify(createGameState()), game.turnTimeLimit,
      JSON.stringify({
        turnMoveStack: [], pendingConfirmation: null, pendingResignation: null,
        pendingDoubleOffer: null, disconnectedPlayer: null, disconnectedAt: null,
        doublingAllowed: game.doublingAllowed,
        ...(game.pendingMatchLength && game.pendingMatchLength > 1 ? { pendingMatchLength: game.pendingMatchLength } : {}),
      }),
    ],
  );
  const claimed = await client.query<{ principal: string }>(
    `INSERT INTO active_game_principals (principal, game_id, updated_at)
     SELECT principal, $2, NOW() FROM unnest($1::text[]) AS principal
     ON CONFLICT (principal) DO UPDATE SET game_id = EXCLUDED.game_id, updated_at = NOW()
     WHERE $3::text IS NOT NULL AND active_game_principals.game_id = $3
     RETURNING principal`,
    [principals, game.id, game.replacesGameId ?? null],
  );
  if (claimed.rowCount !== principals.length) throw new Error("PLAYER_ALREADY_RESERVED");
  await client.query(
    `INSERT INTO connection_leases (principal, session_hash, purpose, game_id, instance_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 seconds')`,
    [gameOwnerPrincipal(game.id), GAME_OWNER_SESSION, GAME_OWNER_PURPOSE, game.id, game.ownerInstanceId],
  );
}

export async function gameOwnerInstanceId(gameId: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const result = await pool.query<{ instance_id: string }>(
    `SELECT instance_id
       FROM connection_leases
      WHERE principal = $1
        AND session_hash = $2
        AND purpose = $3
        AND game_id = $4
        AND expires_at > NOW()
      LIMIT 1`,
    [gameOwnerPrincipal(gameId), GAME_OWNER_SESSION, GAME_OWNER_PURPOSE, gameId],
  );
  return result.rows[0]?.instance_id ?? null;
}

export async function renewGameOwnership(
  gameId: string,
  instanceId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    `INSERT INTO connection_leases (principal, session_hash, purpose, game_id, instance_id, expires_at)
     SELECT $1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second')
      WHERE EXISTS (
        SELECT 1 FROM games
         WHERE id = $4
           AND (
             status IN ('waiting', 'depositing', 'playing')
             OR (status = 'abandoned' AND phase = 'review' AND escrow_status = 'active')
           )
      )
     ON CONFLICT (principal, session_hash, purpose) DO UPDATE
       SET game_id = EXCLUDED.game_id,
           instance_id = EXCLUDED.instance_id,
           expires_at = EXCLUDED.expires_at
     WHERE connection_leases.game_id = EXCLUDED.game_id
       AND (
         connection_leases.expires_at <= NOW()
         OR connection_leases.instance_id = EXCLUDED.instance_id
         OR EXISTS (SELECT 1 FROM games WHERE id = EXCLUDED.game_id AND status = 'waiting')
       )
     RETURNING instance_id`,
    [gameOwnerPrincipal(gameId), GAME_OWNER_SESSION, GAME_OWNER_PURPOSE, gameId, instanceId, leaseSeconds],
  );
  return result.rowCount === 1 && result.rows[0]?.instance_id === instanceId;
}

export async function commitGameCommand(input: {
  readonly gameId: string;
  readonly command: GameCommand;
  readonly status: string;
  readonly escrowStatus: string;
  readonly gameState: GameState;
  readonly result: unknown;
  readonly eventPayload: Record<string, unknown>;
  readonly phase: GamePhase;
  readonly deadlineAt: Date | null;
  readonly serverState: PersistedGameServerState;
  readonly cashReview?: {
    readonly reason: GameReviewReason;
    readonly deadlineAt: Date;
  };
  readonly ownerInstanceId?: string;
}): Promise<GameCommandCommit> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO game_commands (command_id, game_id, principal, expected_revision, command_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (command_id) DO NOTHING`,
      [input.command.commandId, input.gameId, input.command.principal, input.command.expectedRevision, input.command.commandType],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{
        game_id: string;
        principal: string;
        expected_revision: string;
        committed_revision: string | null;
        command_type: string;
        result: unknown;
      }>(
        `SELECT game_id, principal, expected_revision::text, command_type, committed_revision::text, result
           FROM game_commands
          WHERE command_id = $1
          FOR UPDATE`,
        [input.command.commandId],
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.game_id !== input.gameId ||
        row.principal !== input.command.principal ||
        row.command_type !== input.command.commandType ||
        Number(row.expected_revision) !== input.command.expectedRevision
      ) throw new Error("COMMAND_ID_REUSE");
      if (!row.committed_revision) throw new Error("COMMAND_IN_PROGRESS");
      await client.query("COMMIT");
      return { revision: Number(row.committed_revision), replayed: true, result: row.result };
    }
    if (input.command.commandType === "cash_game_resumed") {
      const heldGame = await client.query<{ player_white: string; player_black: string }>(
        `SELECT player_white, player_black FROM games
          WHERE id = $1 AND status = 'abandoned' AND phase = 'review' AND escrow_status = 'active'
            AND player_white IS NOT NULL AND player_black IS NOT NULL`,
        [input.gameId],
      );
      const held = heldGame.rows[0];
      if (!held) throw new Error("GAME_REVISION_CONFLICT");
      const principals = [held.player_white, held.player_black].sort();
      for (const principal of principals) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal]);
      }
      const reserved = await client.query(
        `INSERT INTO active_game_principals (principal, game_id, updated_at)
         SELECT principal, $2, NOW() FROM unnest($1::text[]) AS principal
         ON CONFLICT (principal) DO UPDATE
           SET updated_at = NOW()
         WHERE active_game_principals.game_id = EXCLUDED.game_id
         RETURNING principal`,
        [principals, input.gameId],
      );
      if (reserved.rowCount !== principals.length) throw new Error("PLAYER_ALREADY_RESERVED");
    }

    if (input.ownerInstanceId) {
      const ownership = await client.query<{ instance_id: string }>(
        `SELECT instance_id
           FROM connection_leases
          WHERE principal = $1
            AND session_hash = $2
            AND purpose = $3
            AND game_id = $4
            AND expires_at > NOW()
          FOR UPDATE`,
        [gameOwnerPrincipal(input.gameId), GAME_OWNER_SESSION, GAME_OWNER_PURPOSE, input.gameId],
      );
      if (ownership.rows[0]?.instance_id !== input.ownerInstanceId) {
        throw new Error("GAME_OWNERSHIP_LOST");
      }
    }

    const updated = await client.query<{ revision: string }>(
      `UPDATE games
          SET game_state = $3, status = $4, escrow_status = $5,
              phase = $6, deadline_at = $7, server_state = $8,
              revision = revision + 1,
              finished_at = CASE
                WHEN $4 IN ('finished', 'abandoned') THEN NOW()
                WHEN games.status = 'abandoned' AND games.phase = 'review' AND $4 = 'playing' THEN NULL
                ELSE finished_at
              END,
              updated_at = NOW()
        WHERE id = $1 AND revision = $2
          AND (
            status NOT IN ('finished', 'abandoned')
            OR (
              status = 'abandoned'
              AND phase = 'review'
              AND $4 = 'playing'
              AND $5 = 'active'
              AND EXISTS (
                SELECT 1 FROM cash_game_quotes
                 WHERE game_id = games.id AND state = 'active'
              )
            )
          )
        RETURNING revision::text`,
      [
        input.gameId,
        input.command.expectedRevision,
        input.gameState,
        input.status,
        input.escrowStatus,
        input.phase,
        input.deadlineAt,
        input.serverState,
      ],
    );
    const revision = Number(updated.rows[0]?.revision);
    if (!Number.isSafeInteger(revision)) throw new Error("GAME_REVISION_CONFLICT");
    if (input.status === "finished" || input.status === "abandoned") {
      await client.query(
        `DELETE FROM active_game_principals active
          WHERE active.game_id = $1
            AND NOT EXISTS (
              SELECT 1
                FROM backgammon_match_games match_game
                JOIN backgammon_matches match ON match.id = match_game.match_id
               WHERE match_game.game_id = $1
                 AND match.status = 'playing'
                 AND match.current_game_id = $1
            )`,
        [input.gameId],
      );
    }
    if (input.cashReview) {
      const reviewed = await client.query(
        `UPDATE cash_game_quotes
            SET state = 'review', review_reason = $2, review_deadline = $3,
                recovery_round = recovery_round + 1, resolution_state = 'none',
                resolution_reason = $2, version = version + 1
          WHERE game_id = $1 AND state = 'active'
          RETURNING id`,
        [input.gameId, input.cashReview.reason, input.cashReview.deadlineAt],
      );
      if (reviewed.rowCount !== 1) {
        const existing = await client.query<{ state: string; review_reason: string | null }>(
          "SELECT state, review_reason FROM cash_game_quotes WHERE game_id = $1",
          [input.gameId],
        );
        if (
          existing.rows[0]?.state !== "review" ||
          existing.rows[0]?.review_reason !== input.cashReview.reason
        ) throw new Error("CASH_QUOTE_STATE_CONFLICT");
      }
    }
    await client.query(
      `INSERT INTO game_events (game_id, revision, command_id, event_type, actor, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.gameId, revision, input.command.commandId, input.command.eventType, input.command.principal, input.eventPayload],
    );
    await client.query(
      `UPDATE game_commands
          SET committed_revision = $2, result = $3
        WHERE command_id = $1`,
      [input.command.commandId, revision, input.result],
    );
    await client.query("COMMIT");
    return { revision, replayed: false, result: input.result };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
    const result = await pool.query(
      `INSERT INTO dice_rolls
        (game_id, turn_number, player, die1, die2, drand_round, drand_randomness,
         drand_signature, drand_failed, revealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (game_id, turn_number) DO UPDATE SET
         player = EXCLUDED.player,
         die1 = EXCLUDED.die1,
         die2 = EXCLUDED.die2,
         drand_failed = EXCLUDED.drand_failed,
         proof_json = NULL,
         revealed_at = NOW()
       WHERE dice_rolls.die1 IS NULL AND dice_rolls.die2 IS NULL`,
      [
        gameId, turnNumber, player, die1, die2,
        drandProof?.round ?? null,
        drandProof?.randomness ?? null,
        drandProof?.signature ?? null,
        drandFailed ?? false,
      ],
    );
    return result.rowCount === 1;
  } catch (err) {
    logger.error("Failed to persist dice roll", { gameId, error: String(err) });
    return false;
  }
}

export interface StoredGame {
  readonly id: string;
  readonly revision: number;
  readonly playerWhite: string | null;
  readonly playerBlack: string | null;
  readonly wagerAmount: number;
  readonly status: string;
  readonly escrowStatus: string;
  readonly gameState: GameState;
  readonly turnTimeLimit: number;
  readonly phase: GamePhase;
  readonly deadlineAt: Date | null;
  readonly createdAt: Date;
  readonly serverState: PersistedGameServerState;
}

function storedGameFromRow(row: Record<string, unknown>): StoredGame {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    playerWhite: row.player_white as string | null,
    playerBlack: row.player_black as string | null,
    wagerAmount: Number(row.wager_amount),
    status: String(row.status),
    escrowStatus: String(row.escrow_status),
    gameState: row.game_state as GameState,
    turnTimeLimit: Number(row.turn_time_limit),
    phase: row.phase as GamePhase,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at as string | Date) : null,
    createdAt: new Date(row.created_at as string | Date),
    serverState: (row.server_state ?? {}) as PersistedGameServerState,
  };
}

export async function loadGame(gameId: string): Promise<StoredGame | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT id, player_white, player_black, wager_amount, status, escrow_status,
            game_state, turn_time_limit, revision, phase, deadline_at, server_state, created_at
       FROM games WHERE id = $1`,
    [gameId],
  );
  return result.rows[0] ? storedGameFromRow(result.rows[0]) : null;
}

export async function loadGameForParticipant(gameId: string, principal: string): Promise<StoredGame | null> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT id, player_white, player_black, wager_amount, status, escrow_status,
            game_state, turn_time_limit, revision, phase, deadline_at, server_state, created_at
       FROM games
      WHERE id = $1
        AND $2 IN (player_white, player_black)
        AND (
          status IN ('waiting', 'depositing', 'playing')
          OR (status = 'abandoned' AND phase = 'review' AND escrow_status = 'active')
        )
      LIMIT 1`,
    [gameId, principal],
  );
  return result.rows[0] ? storedGameFromRow(result.rows[0]) : null;
}

export async function loadCurrentGameForParticipant(principal: string): Promise<StoredGame | null> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT g.id, g.player_white, g.player_black, g.wager_amount, g.status, g.escrow_status,
            g.game_state, g.turn_time_limit, g.revision, g.phase, g.deadline_at, g.server_state, g.created_at
       FROM active_game_principals active
       JOIN games g ON g.id = active.game_id
      WHERE active.principal = $1
        AND g.status IN ('waiting', 'depositing', 'playing')
      LIMIT 1`,
    [principal],
  );
  return result.rows[0] ? storedGameFromRow(result.rows[0]) : null;
}

/** Mark a game as terminal. Match reservations are retained until scoring
 * atomically transfers them to the next game or releases them on completion. */
export async function finishGame(gameId: string, status: string, escrowStatus: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owners = await client.query<{ principal: string }>(
      "SELECT principal FROM active_game_principals WHERE game_id = $1 FOR UPDATE",
      [gameId],
    );
    for (const { principal } of owners.rows.sort((a, b) => a.principal.localeCompare(b.principal))) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal]);
    }
    const updated = await client.query(
      `UPDATE games SET status = $2, escrow_status = $3, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [gameId, status, escrowStatus],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `DELETE FROM active_game_principals active
        WHERE active.game_id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM backgammon_match_games match_game
              JOIN backgammon_matches match ON match.id = match_game.match_id
             WHERE match_game.game_id = $1
               AND match.status = 'playing'
               AND match.current_game_id = $1
          )`,
      [gameId],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* rollback best effort */ }
    logger.error("Failed to finish game", { gameId, error: String(err) });
    return false;
  } finally {
    client.release();
  }
}

/**
 * Atomically abandons continuations whose durable start deadline elapsed
 * before their preassigned game started. A no-show produces no game result.
 */
export async function expireDueMatchContinuations(limit = 32): Promise<string[]> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  // Old replicas can publish a continuation without the new deadline during a
  // rolling deployment. Repair it before claiming expiry work, without holding
  // the match lock while acquiring participant/game locks below.
  await pool.query(
    `UPDATE backgammon_matches match_record
        SET continuation_deadline_at = NOW() + INTERVAL '15 minutes', updated_at = NOW()
       FROM backgammon_match_continuations continuation
      WHERE continuation.match_id = match_record.id
        AND match_record.status = 'playing'
        AND match_record.current_game_id = continuation.next_game_id
        AND match_record.continuation_deadline_at IS NULL
        AND continuation.state IN ('pending', 'ready')
        AND EXISTS (
          SELECT 1 FROM games game
           WHERE game.id = continuation.next_game_id AND game.status = 'waiting'
        )`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidates = await client.query<{
      match_id: string;
      completed_game_id: string;
      next_game_id: string;
      player_white: string;
      player_black: string;
    }>(
      `SELECT match_record.id AS match_id,
              continuation.completed_game_id,
              continuation.next_game_id,
              game.player_white,
              game.player_black
         FROM backgammon_matches match_record
         JOIN backgammon_match_continuations continuation
           ON continuation.match_id = match_record.id
         JOIN games game ON game.id = continuation.next_game_id
        WHERE match_record.status = 'playing'
          AND match_record.current_game_id = continuation.next_game_id
          AND match_record.continuation_deadline_at <= NOW()
          AND continuation.state IN ('pending', 'ready')
          AND game.status = 'waiting'
        ORDER BY match_record.continuation_deadline_at, match_record.id
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 128))],
    );
    const abandoned: string[] = [];
    for (const candidate of candidates.rows) {
      for (const principal of [candidate.player_white, candidate.player_black].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal]);
      }
      const waitingGame = await client.query<{ id: string }>(
        "SELECT id FROM games WHERE id = $1 AND status = 'waiting' FOR UPDATE",
        [candidate.next_game_id],
      );
      if (waitingGame.rowCount !== 1) continue;
      const dueContinuation = await client.query<{ next_game_id: string }>(
        `SELECT continuation.next_game_id
           FROM backgammon_match_continuations continuation
           JOIN backgammon_matches match_record ON match_record.id = continuation.match_id
          WHERE continuation.match_id = $1
            AND continuation.completed_game_id = $2
            AND continuation.next_game_id = $3
            AND continuation.state IN ('pending', 'ready')
            AND match_record.status = 'playing'
            AND match_record.current_game_id = continuation.next_game_id
            AND match_record.continuation_deadline_at <= NOW()
          FOR UPDATE OF continuation, match_record`,
        [candidate.match_id, candidate.completed_game_id, candidate.next_game_id],
      );
      if (dueContinuation.rowCount !== 1) continue;
      const abandonedGame = await client.query<{ id: string }>(
        `UPDATE games
            SET status = 'abandoned', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status = 'waiting'
        RETURNING id`,
        [candidate.next_game_id],
      );
      if (abandonedGame.rowCount !== 1) continue;
      const terminalMatch = await client.query(
        `UPDATE backgammon_matches
            SET status = 'finished',
                terminal_reason = 'continuation_no_show',
                continuation_deadline_at = NULL,
                updated_at = NOW()
          WHERE id = $1
            AND status = 'playing'
            AND current_game_id = $2
            AND continuation_deadline_at <= NOW()
        RETURNING id`,
        [candidate.match_id, candidate.next_game_id],
      );
      if (terminalMatch.rowCount !== 1) throw new Error("MATCH_CONTINUATION_EXPIRY_CONFLICT");
      const resolved = await client.query(
        `DELETE FROM backgammon_match_continuations
          WHERE match_id = $1
            AND completed_game_id = $2
            AND next_game_id = $3
            AND state IN ('pending', 'ready')
        RETURNING next_game_id`,
        [candidate.match_id, candidate.completed_game_id, candidate.next_game_id],
      );
      if (resolved.rowCount !== 1) throw new Error("MATCH_CONTINUATION_EXPIRY_CONFLICT");
      await client.query("DELETE FROM active_game_principals WHERE game_id = $1", [candidate.next_game_id]);
      await client.query(
        `DELETE FROM connection_leases
          WHERE principal = $1
            AND session_hash = $2
            AND purpose = $3
            AND game_id = $4`,
        [gameOwnerPrincipal(candidate.next_game_id), GAME_OWNER_SESSION, GAME_OWNER_PURPOSE, candidate.next_game_id],
      );
      abandoned.push(candidate.next_game_id);
    }
    await client.query("COMMIT");
    return abandoned;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* rollback best effort */ }
    logger.error("Failed to expire due match continuations", { error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

/** Reclaim unstarted durable games, including pre-populated challenges.
 * Active match continuations remain reserved until their match reaches a
 * terminal or explicit abandonment transition. */
export async function expireOrphanWaitingGames(): Promise<string[]> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const expiredMatchGames = await expireDueMatchContinuations();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string }>(
      `UPDATE games
          SET status = 'abandoned', finished_at = NOW(), updated_at = NOW()
        WHERE id IN (
          SELECT game.id FROM games game
           WHERE game.status = 'waiting'
             AND game.player_white IS NOT NULL
             AND game.created_at <= NOW() - INTERVAL '15 minutes'
             AND NOT EXISTS (
               SELECT 1 FROM backgammon_match_games match_game
               JOIN backgammon_matches match ON match.id = match_game.match_id
               WHERE match_game.game_id = game.id AND match.status = 'playing'
             )
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
    );
    if ((expired.rowCount ?? 0) > 0) {
      const ids = expired.rows.map(({ id }) => id);
      await client.query("DELETE FROM active_game_principals WHERE game_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM matchmaking_queue WHERE game_id = ANY($1::text[]) AND state = 'matched'", [ids]);
    }
    await client.query("COMMIT");
    return [...expiredMatchGames, ...expired.rows.map(({ id }) => id)];
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* rollback best effort */ }
    logger.error("Failed to expire orphan waiting games", { error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

/** Load all active (unfinished) games for server restart recovery */
export async function loadActiveGames(): Promise<Array<{
  id: string;
  revision: number;
  playerWhite: string | null;
  playerBlack: string | null;
  wagerAmount: number;
  status: string;
  escrowStatus: string;
  gameState: GameState;
  turnTimeLimit: number;
  phase: GamePhase;
  deadlineAt: Date | null;
  createdAt: Date;
  serverState: PersistedGameServerState;
}>> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT id, player_white, player_black, wager_amount, status, escrow_status,
            game_state, turn_time_limit, revision, phase, deadline_at, server_state, created_at
       FROM games WHERE status IN ('waiting', 'depositing', 'playing') ORDER BY created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    revision: Number(row.revision),
    playerWhite: row.player_white,
    playerBlack: row.player_black,
    wagerAmount: row.wager_amount,
    status: row.status,
    escrowStatus: row.escrow_status,
    gameState: row.game_state as GameState,
    turnTimeLimit: row.turn_time_limit,
    phase: row.phase,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at) : null,
    createdAt: new Date(row.created_at),
    serverState: (row.server_state ?? {}) as PersistedGameServerState,
  }));
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
  proof: DrandDiceProof | null;
}>> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT turn_number, player, die1, die2, drand_round, drand_randomness,
              drand_signature, drand_failed, proof_json
       FROM dice_rolls
       WHERE game_id = $1 AND die1 IS NOT NULL AND die2 IS NOT NULL
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
      proof: row.proof_json as DrandDiceProof | null,
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

export interface GameAuditSummary {
  readonly gameId: string;
  readonly white: string;
  readonly black: string;
  readonly whiteName: string | null;
  readonly blackName: string | null;
  readonly winner: "white" | "black" | null;
  readonly resultType: "normal" | "gammon" | "backgammon" | null;
  readonly cubeValue: number;
  readonly turnCount: number;
  readonly cashStakeMicroUsd: string | null;
  readonly cashState: string | null;
  readonly createdAt: string;
}

export async function getGameAuditSummary(principal: string, gameId: string): Promise<GameAuditSummary | null> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const result = await pool.query<{
    id: string;
    player_white: string;
    player_black: string;
    white_name: string | null;
    black_name: string | null;
    game_state: GameState | null;
    cash_stake_micro_usd: string | null;
    cash_state: string | null;
    created_at: Date;
  }>(
    `SELECT game.id, game.player_white, game.player_black,
            COALESCE(NULLIF(white_profile.display_name, ''), white_profile.username) AS white_name,
            COALESCE(NULLIF(black_profile.display_name, ''), black_profile.username) AS black_name,
            game.game_state,
            quote.stake_micro_usd::text AS cash_stake_micro_usd,
            quote.state AS cash_state,
            game.created_at
       FROM games game
       LEFT JOIN player_profiles white_profile ON white_profile.address = game.player_white
       LEFT JOIN player_profiles black_profile ON black_profile.address = game.player_black
       LEFT JOIN cash_game_quotes quote ON quote.game_id = game.id
      WHERE game.id = $1
        AND $2 IN (game.player_white, game.player_black)
      LIMIT 1`,
    [gameId, principal],
  );
  const row = result.rows[0];
  if (!row?.player_white || !row.player_black) return null;
  const state = row.game_state;
  return {
    gameId: row.id,
    white: row.player_white,
    black: row.player_black,
    whiteName: row.white_name,
    blackName: row.black_name,
    winner: state?.winner ?? null,
    resultType: state?.resultType ?? null,
    cubeValue: state?.cubeValue ?? 1,
    turnCount: state?.turnNumber ?? 0,
    cashStakeMicroUsd: row.cash_stake_micro_usd,
    cashState: row.cash_state,
    createdAt: row.created_at.toISOString(),
  };
}
