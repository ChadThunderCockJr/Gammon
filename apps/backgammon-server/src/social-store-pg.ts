/**
 * PostgreSQL-backed social store.
 * Provides durable persistence for profiles, ratings, stats, match results, and friends.
 * Redis remains for:
 * - Activity feed (append-only cache)
 * - Leaderboard cache (rebuilt from ratings)
 */

import { randomUUID } from "node:crypto";
import { getPool } from "./db.js";
import { RATING_DEFAULT, RATING_K_PROVISIONAL, RATING_K_INTERMEDIATE, RATING_K_ESTABLISHED, RATING_PROVISIONAL_THRESHOLD, RATING_ESTABLISHED_THRESHOLD, RATING_MIN } from "./config.js";
import { decryptSensitiveJson, type EncryptedPayload } from "./finance-crypto.js";
import type { ChallengeTerms } from "./types.js";
import { reserveWaitingGame } from "./game-store.js";

// ── Profiles ──────────────────────────────────────────────

export async function getProfile(address: string): Promise<{ address: string; displayName: string; username: string | null; createdAt: number } | null> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query(
    "SELECT address, display_name, username, created_at FROM player_profiles WHERE address = $1",
    [address],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    address: row.address,
    displayName: row.display_name,
    username: row.username,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export async function setProfile(address: string, displayName: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO player_profiles (address, display_name) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET display_name = $2, updated_at = NOW()`,
      [address, displayName],
    );
    return true;
  } catch { return false; }
}

export async function setUsername(address: string, username: string): Promise<{ ok: boolean; error?: string }> {
  const pool = getPool();
  if (!pool) return { ok: false, error: "Database unavailable" };
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return { ok: false, error: "Username must be 3-20 characters (letters, numbers, underscores)" };
  }
  try {
    await pool.query(
      `INSERT INTO player_profiles (address, username, display_name)
       VALUES ($1, $2, $2)
       ON CONFLICT (address) DO UPDATE SET
         username = EXCLUDED.username,
         display_name = CASE
           WHEN player_profiles.display_name = '' THEN EXCLUDED.username
           ELSE player_profiles.display_name
         END,
         updated_at = NOW()`,
      [address, username],
    );
    return { ok: true };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    if (code === "23505") return { ok: false, error: "Username already taken" };
    return { ok: false, error: "Failed to set username" };
  }
}

export async function lookupByUsername(username: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query<{ address: string }>(
    "SELECT address FROM player_profiles WHERE LOWER(username) = LOWER($1)",
    [username],
  );
  return result.rows[0]?.address ?? null;
}

export async function ensureProfile(address: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO player_profiles (address, display_name)
       VALUES ($1, '')
       ON CONFLICT (address) DO NOTHING`,
      [address],
    );
  } catch {
    // Profile creation is retried on the next authenticated request.
  }
}

export async function searchPlayers(query: string, viewer?: string): Promise<Array<{ address: string; username: string; displayName: string }>> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT address, COALESCE(username, '') AS username, display_name
         FROM player_profiles profile
        WHERE (username ILIKE $1 OR display_name ILIKE $1 OR address ILIKE $1)
          AND ($2::text IS NULL OR address <> $2)
          AND (
            $2::text IS NULL OR NOT EXISTS (
              SELECT 1
                FROM user_blocks block
               WHERE (block.blocker = $2 AND block.blocked = profile.address)
                  OR (block.blocker = profile.address AND block.blocked = $2)
            )
          )
        LIMIT 10`,
      [`%${query}%`, viewer ?? null],
    );
    return r.rows.map((row) => ({ address: row.address, username: row.username, displayName: row.display_name }));
  } catch { return []; }
}

// ── Ratings ──────────────────────────────────────────────

export async function getRating(address: string): Promise<{ rating: number; ratingChange: number }> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query(
    "SELECT rating, rating_change FROM player_ratings WHERE address = $1",
    [address],
  );
  if (result.rows.length === 0) return { rating: RATING_DEFAULT, ratingChange: 0 };
  return { rating: result.rows[0].rating, ratingChange: result.rows[0].rating_change };
}

function getKFactor(totalGames: number): number {
  if (totalGames < RATING_PROVISIONAL_THRESHOLD) return RATING_K_PROVISIONAL;
  if (totalGames < RATING_ESTABLISHED_THRESHOLD) return RATING_K_INTERMEDIATE;
  return RATING_K_ESTABLISHED;
}
export interface CompletedGameSocialEffect {
  readonly gameId: string;
  readonly whiteAddress: string;
  readonly blackAddress: string;
  readonly whiteName: string;
  readonly blackName: string;
  readonly winner: "white" | "black";
  readonly resultType: string;
  readonly wagerAmount: bigint;
}

export interface CompletedGameSocialResult {
  readonly applied: boolean;
  readonly whiteRating: number;
  readonly blackRating: number;
  readonly whiteRatingChange: number;
  readonly blackRatingChange: number;
}

export async function applyCompletedGameEffect(
  effect: CompletedGameSocialEffect,
): Promise<CompletedGameSocialResult> {
  if (effect.whiteAddress === effect.blackAddress) throw new Error("SELF_PLAY_RESULT_REJECTED");
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `INSERT INTO social_game_effects (game_id, winner, result_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (game_id) DO NOTHING
       RETURNING game_id`,
      [effect.gameId, effect.winner, effect.resultType],
    );
    if (claimed.rowCount === 0) {
      await client.query("COMMIT");
      return {
        applied: false,
        whiteRating: RATING_DEFAULT,
        blackRating: RATING_DEFAULT,
        whiteRatingChange: 0,
        blackRatingChange: 0,
      };
    }

    const addresses = [effect.whiteAddress, effect.blackAddress].sort();
    for (const address of addresses) {
      await client.query(
        "INSERT INTO player_ratings (address) VALUES ($1) ON CONFLICT DO NOTHING",
        [address],
      );
      await client.query(
        "INSERT INTO player_stats (address) VALUES ($1) ON CONFLICT DO NOTHING",
        [address],
      );
    }
    const locked = await client.query<{ address: string; rating: number; total_games: number }>(
      `SELECT address, rating, total_games
         FROM player_ratings
        WHERE address = ANY($1::text[])
        ORDER BY address
        FOR UPDATE`,
      [addresses],
    );
    const byAddress = new Map(locked.rows.map((row) => [row.address, row]));
    const white = byAddress.get(effect.whiteAddress);
    const black = byAddress.get(effect.blackAddress);
    if (!white || !black) throw new Error("RATING_ROWS_UNAVAILABLE");

    const expectedWhite = 1 / (1 + Math.pow(10, (black.rating - white.rating) / 400));
    const expectedBlack = 1 - expectedWhite;
    const multiplier = effect.resultType === "backgammon" ? 2 : effect.resultType === "gammon" ? 1.5 : 1;
    const whiteScore = effect.winner === "white" ? 1 : 0;
    const blackScore = 1 - whiteScore;
    const whiteChange = Math.round(getKFactor(white.total_games) * multiplier * (whiteScore - expectedWhite));
    const blackChange = Math.round(getKFactor(black.total_games) * multiplier * (blackScore - expectedBlack));
    const whiteRating = Math.max(RATING_MIN, white.rating + whiteChange);
    const blackRating = Math.max(RATING_MIN, black.rating + blackChange);

    await client.query(
      `UPDATE player_ratings
          SET rating = $2, rating_change = $3, total_games = total_games + 1, updated_at = NOW()
        WHERE address = $1`,
      [effect.whiteAddress, whiteRating, whiteChange],
    );
    await client.query(
      `UPDATE player_ratings
          SET rating = $2, rating_change = $3, total_games = total_games + 1, updated_at = NOW()
        WHERE address = $1`,
      [effect.blackAddress, blackRating, blackChange],
    );

    const winnerAddress = effect.winner === "white" ? effect.whiteAddress : effect.blackAddress;
    const loserAddress = effect.winner === "white" ? effect.blackAddress : effect.whiteAddress;
    const isGammon = effect.resultType === "gammon" ? 1 : 0;
    const isBackgammon = effect.resultType === "backgammon" ? 1 : 0;
    await client.query(
      `UPDATE player_stats SET
         wins = wins + 1,
         current_streak = CASE WHEN current_streak_type = 'W' THEN current_streak + 1 ELSE 1 END,
         current_streak_type = 'W',
         best_streak = GREATEST(best_streak, CASE WHEN current_streak_type = 'W' THEN current_streak + 1 ELSE 1 END),
         total_gammons = total_gammons + $2,
         total_backgammons = total_backgammons + $3,
         updated_at = NOW()
       WHERE address = $1`,
      [winnerAddress, isGammon, isBackgammon],
    );
    await client.query(
      `UPDATE player_stats SET
         losses = losses + 1,
         current_streak = CASE WHEN current_streak_type = 'L' THEN current_streak + 1 ELSE 1 END,
         current_streak_type = 'L',
         updated_at = NOW()
       WHERE address = $1`,
      [loserAddress],
    );

    await client.query(
      `INSERT INTO match_results
        (address, game_id, opponent, opponent_name, result, result_type, wager_amount, rating_change)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8),
        ($3, $2, $1, $9, $10, $6, $7, $11)`,
      [
        effect.whiteAddress,
        effect.gameId,
        effect.blackAddress,
        effect.blackName,
        effect.winner === "white" ? "W" : "L",
        effect.resultType,
        effect.wagerAmount.toString(),
        whiteChange,
        effect.whiteName,
        effect.winner === "black" ? "W" : "L",
        blackChange,
      ],
    );
    await client.query("COMMIT");
    return {
      applied: true,
      whiteRating,
      blackRating,
      whiteRatingChange: whiteChange,
      blackRatingChange: blackChange,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface SocialEffectReconciliationResult {
  readonly scanned: number;
  readonly applied: number;
  readonly failed: number;
}

/**
 * Replays completed games whose idempotent social effect did not commit.
 * The finished game aggregate is the durable intent; social_game_effects is
 * the durable completion marker.
 */
export async function reconcileCompletedGameEffects(
  limit = 100,
): Promise<SocialEffectReconciliationResult> {
  const pool = getPool();
  if (!pool) return { scanned: 0, applied: 0, failed: 0 };
  const completed = await pool.query<{
    game_id: string;
    white_address: string;
    black_address: string;
    white_name: string;
    black_name: string;
    winner: "white" | "black";
    result_type: string;
    wager_amount: string;
  }>(
    `SELECT
       g.id AS game_id,
       g.player_white AS white_address,
       g.player_black AS black_address,
       COALESCE(NULLIF(white_profile.display_name, ''), white_profile.username, g.player_white) AS white_name,
       COALESCE(NULLIF(black_profile.display_name, ''), black_profile.username, g.player_black) AS black_name,
       g.game_state->>'winner' AS winner,
       COALESCE(g.game_state->>'resultType', 'normal') AS result_type,
       g.wager_amount::text AS wager_amount
     FROM games g
     LEFT JOIN player_profiles white_profile ON white_profile.address = g.player_white
     LEFT JOIN player_profiles black_profile ON black_profile.address = g.player_black
     WHERE g.status = 'finished'
       AND g.player_white IS NOT NULL
       AND g.player_black IS NOT NULL
       AND g.game_state->>'gameOver' = 'true'
       AND g.game_state->>'winner' IN ('white', 'black')
       AND NOT EXISTS (
         SELECT 1 FROM social_game_effects effect WHERE effect.game_id = g.id
       )
     ORDER BY g.finished_at NULLS LAST, g.updated_at
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 1_000))],
  );

  let applied = 0;
  let failed = 0;
  for (const row of completed.rows) {
    try {
      const result = await applyCompletedGameEffect({
        gameId: row.game_id,
        whiteAddress: row.white_address,
        blackAddress: row.black_address,
        whiteName: row.white_name,
        blackName: row.black_name,
        winner: row.winner,
        resultType: row.result_type,
        wagerAmount: BigInt(row.wager_amount),
      });
      if (result.applied) applied++;
    } catch {
      failed++;
    }
  }
  return { scanned: completed.rowCount ?? completed.rows.length, applied, failed };
}


export async function getStats(address: string): Promise<{
  wins: number; losses: number; totalGames: number; currentStreak: number; currentStreakType: string;
  bestStreak: number; totalGammons: number; totalBackgammons: number;
}> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query("SELECT * FROM player_stats WHERE address = $1", [address]);
  if (result.rows.length === 0) {
    return { wins: 0, losses: 0, totalGames: 0, currentStreak: 0, currentStreakType: "", bestStreak: 0, totalGammons: 0, totalBackgammons: 0 };
  }
  const stats = result.rows[0];
  return {
    wins: stats.wins,
    losses: stats.losses,
    totalGames: stats.wins + stats.losses,
    currentStreak: stats.current_streak,
    currentStreakType: stats.current_streak_type,
    bestStreak: stats.best_streak,
    totalGammons: stats.total_gammons,
    totalBackgammons: stats.total_backgammons,
  };
}

// ── Match Results ──────────────────────────────────────────


export async function getMatchResults(address: string, limit = 20): Promise<Array<{
  gameId: string; opponent: string; opponentName: string; result: string;
  resultType: string; wagerAmount: string; ratingChange: number; timestamp: number;
  cashQuoteId: string | null; cashState: string | null; stakeMicroUsd: string | null;
  reserveMicroUsd: string | null; assetDenom: string | null; settlementTxHash: string | null;
  terminalId: string | null; terminalReceipt: Record<string, unknown> | null;
}>> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT match.game_id, match.opponent, match.opponent_name, match.result,
            match.result_type, match.wager_amount, match.rating_change, match.created_at,
            quote.id AS cash_quote_id, quote.state AS cash_state,
            quote.stake_micro_usd, quote.reserve_per_player_micro_usd,
            quote.asset_denom, quote.settlement_tx_hash, quote.terminal_id,
            quote.terminal_snapshot
       FROM match_results match
       LEFT JOIN cash_game_quotes quote ON quote.game_id = match.game_id
      WHERE match.address = $1
      ORDER BY match.created_at DESC
      LIMIT $2`,
    [address, limit],
  );
  return result.rows.map((row) => ({
    gameId: row.game_id,
    opponent: row.opponent,
    opponentName: row.opponent_name,
    result: row.result,
    resultType: row.result_type,
    wagerAmount: String(row.wager_amount),
    ratingChange: row.rating_change,
    timestamp: new Date(row.created_at).getTime(),
    cashQuoteId: row.cash_quote_id ?? null,
    cashState: row.cash_state ?? null,
    stakeMicroUsd: row.stake_micro_usd === null || row.stake_micro_usd === undefined ? null : String(row.stake_micro_usd),
    reserveMicroUsd: row.reserve_per_player_micro_usd === null || row.reserve_per_player_micro_usd === undefined ? null : String(row.reserve_per_player_micro_usd),
    assetDenom: row.asset_denom ?? null,
    settlementTxHash: row.settlement_tx_hash ?? null,
    terminalId: row.terminal_id ?? null,
    terminalReceipt: row.terminal_snapshot && typeof row.terminal_snapshot === "object" ? row.terminal_snapshot as Record<string, unknown> : null,
  }));
}

// ── WebSocket presence leases ─────────────────────────────

const PRESENCE_LEASE_PURPOSE = "websocket-presence";

export async function claimPresenceLease(input: {
  readonly principal: string;
  readonly connectionId: string;
  readonly instanceId: string;
  readonly ttlSeconds: number;
}): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.principal]);
    const active = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM connection_leases
          WHERE principal = $1
            AND purpose = $2
            AND expires_at > NOW()
       ) AS online`,
      [input.principal, PRESENCE_LEASE_PURPOSE],
    );
    await client.query(
      `INSERT INTO connection_leases (principal, session_hash, purpose, game_id, instance_id, expires_at)
       VALUES ($1, $2, $3, NULL, $4, NOW() + ($5 * INTERVAL '1 second'))
       ON CONFLICT (principal, session_hash, purpose) DO UPDATE
         SET game_id = NULL,
             instance_id = EXCLUDED.instance_id,
             expires_at = EXCLUDED.expires_at`,
      [input.principal, input.connectionId, PRESENCE_LEASE_PURPOSE, input.instanceId, input.ttlSeconds],
    );
    await client.query("COMMIT");
    return active.rows[0]?.online !== true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function renewPresenceLease(input: {
  readonly principal: string;
  readonly connectionId: string;
  readonly instanceId: string;
  readonly ttlSeconds: number;
}): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const renewed = await pool.query(
    `UPDATE connection_leases
        SET expires_at = NOW() + ($5 * INTERVAL '1 second')
      WHERE principal = $1
        AND session_hash = $2
        AND purpose = $3
        AND instance_id = $4
      RETURNING principal`,
    [input.principal, input.connectionId, PRESENCE_LEASE_PURPOSE, input.instanceId, input.ttlSeconds],
  );
  return renewed.rowCount === 1;
}

export async function releasePresenceLease(input: {
  readonly principal: string;
  readonly connectionId: string;
  readonly instanceId: string;
}): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.principal]);
    await client.query(
      `DELETE FROM connection_leases
        WHERE principal = $1
          AND session_hash = $2
          AND purpose = $3
          AND instance_id = $4`,
      [input.principal, input.connectionId, PRESENCE_LEASE_PURPOSE, input.instanceId],
    );
    const active = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM connection_leases
          WHERE principal = $1
            AND purpose = $2
            AND expires_at > NOW()
       ) AS online`,
      [input.principal, PRESENCE_LEASE_PURPOSE],
    );
    await client.query("COMMIT");
    return active.rows[0]?.online !== true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function isPresenceOnline(principal: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM connection_leases
        WHERE principal = $1
          AND purpose = $2
          AND expires_at > NOW()
     ) AS online`,
    [principal, PRESENCE_LEASE_PURPOSE],
  );
  return result.rows[0]?.online === true;
}

export async function getOnlinePresencePrincipals(): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query<{ principal: string }>(
    `SELECT DISTINCT principal FROM connection_leases
      WHERE purpose = $1 AND expires_at > NOW()`,
    [PRESENCE_LEASE_PURPOSE],
  );
  return result.rows.map((row) => row.principal);
}

export async function getOnlinePresenceCount(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT principal)::text AS count
       FROM connection_leases
      WHERE purpose = $1 AND expires_at > NOW()`,
    [PRESENCE_LEASE_PURPOSE],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function cleanupExpiredPresenceLeases(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    "DELETE FROM connection_leases WHERE purpose = $1 AND expires_at <= NOW()",
    [PRESENCE_LEASE_PURPOSE],
  );
}

// ── Friend challenges ─────────────────────────────────────

export interface DurableFriendChallenge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly config: ChallengeTerms;
  readonly gameId: string | null;
}

function challengeFromRow(row: Record<string, unknown>): DurableFriendChallenge {
  return {
    id: String(row.id),
    from: String(row.from_address),
    to: String(row.to_address),
    createdAt: new Date(row.created_at as string | Date).getTime(),
    expiresAt: new Date(row.expires_at as string | Date).getTime(),
    config: row.config as ChallengeTerms,
    gameId: row.game_id === null ? null : String(row.game_id),
  };
}

export async function createFriendChallenge(challenge: DurableFriendChallenge): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const address of [challenge.from, challenge.to].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [address]);
    }
    await client.query(
      `UPDATE friend_challenges SET state = 'expired'
        WHERE state = 'pending' AND expires_at <= NOW()
          AND (
            from_address = ANY($1::text[])
            OR to_address = ANY($1::text[])
          )`,
      [[challenge.from, challenge.to]],
    );
    const counts = await client.query<{ outgoing: string; incoming: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE from_address = $1)::text AS outgoing,
         COUNT(*) FILTER (WHERE to_address = $2)::text AS incoming
       FROM friend_challenges
       WHERE state = 'pending' AND expires_at > NOW()
         AND (from_address = $1 OR to_address = $2)`,
      [challenge.from, challenge.to],
    );
    const count = counts.rows[0];
    if (Number(count?.outgoing ?? 0) >= 3 || Number(count?.incoming ?? 0) >= 10) {
      await client.query("ROLLBACK");
      return false;
    }
    const created = await client.query(
      `INSERT INTO friend_challenges (id, from_address, to_address, config, state, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [challenge.id, challenge.from, challenge.to, challenge.config, new Date(challenge.expiresAt)],
    );
    await client.query("COMMIT");
    return created.rowCount === 1;
  } catch {
    await client.query("ROLLBACK");
    return false;
  } finally {
    client.release();
  }
}

export async function getPendingFriendChallenges(address: string): Promise<DurableFriendChallenge[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, from_address, to_address, config, created_at, expires_at, game_id
       FROM friend_challenges
      WHERE to_address = $1 AND state = 'pending' AND expires_at > NOW()
      ORDER BY created_at`,
    [address],
  );
  return result.rows.map(challengeFromRow);
}

export async function getAcceptedFriendChallenges(address: string): Promise<DurableFriendChallenge[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT challenge.id, challenge.from_address, challenge.to_address, challenge.config,
            challenge.created_at, challenge.expires_at, challenge.game_id
       FROM friend_challenges challenge
       JOIN games game ON game.id = challenge.game_id
      WHERE challenge.state = 'accepted'
        AND (challenge.from_address = $1 OR challenge.to_address = $1)
        AND game.status IN ('waiting', 'playing')
      ORDER BY challenge.accepted_at, challenge.id`,
    [address],
  );
  return result.rows.map(challengeFromRow);
}

export async function getFriendChallenge(id: string): Promise<DurableFriendChallenge | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT id, from_address, to_address, config, created_at, expires_at, game_id
       FROM friend_challenges WHERE id = $1 AND state = 'pending' AND expires_at > NOW()`,
    [id],
  );
  return result.rows[0] ? challengeFromRow(result.rows[0]) : null;
}

export async function acceptFriendChallenge(input: {
  readonly id: string;
  readonly recipient: string;
  readonly ownerInstanceId: string;
}): Promise<DurableFriendChallenge | null> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, from_address, to_address, config, state, created_at, expires_at, game_id
         FROM friend_challenges WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const row = selected.rows[0];
    if (!row || row.to_address !== input.recipient) {
      await client.query("COMMIT");
      return null;
    }
    if (row.state === "accepted") {
      const liveGame = row.game_id === null ? null : await client.query(
        "SELECT 1 FROM games WHERE id = $1 AND status IN ('waiting', 'playing')",
        [row.game_id],
      );
      await client.query("COMMIT");
      return liveGame?.rowCount ? challengeFromRow(row) : null;
    }
    if (row.state !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) {
      if (row.state === "pending") {
        await client.query("UPDATE friend_challenges SET state = 'expired' WHERE id = $1", [input.id]);
      }
      await client.query("COMMIT");
      return null;
    }
    const blocked = await client.query(
      `SELECT 1 FROM user_blocks
        WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1) LIMIT 1`,
      [row.from_address, row.to_address],
    );
    if (blocked.rowCount) throw new Error("CHALLENGE_UNAVAILABLE");
    const gameId = randomUUID();
    const config = row.config as ChallengeTerms;
    await reserveWaitingGame(client, {
      id: gameId,
      playerWhite: row.from_address,
      playerBlack: row.to_address,
      turnTimeLimit: config.time_control,
      doublingAllowed: config.doubling_cube,
      pendingMatchLength: config.match_length,
      ownerInstanceId: input.ownerInstanceId,
    });
    const accepted = await client.query(
      `UPDATE friend_challenges
          SET state = 'accepted', game_id = $2, accepted_at = NOW()
        WHERE id = $1
        RETURNING id, from_address, to_address, config, created_at, expires_at, game_id`,
      [input.id, gameId],
    );
    await client.query("COMMIT");
    return accepted.rows[0] ? challengeFromRow(accepted.rows[0]) : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function declineFriendChallenge(id: string, recipient: string): Promise<DurableFriendChallenge | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE friend_challenges SET state = 'declined'
      WHERE id = $1 AND to_address = $2 AND state = 'pending'
      RETURNING id, from_address, to_address, config, created_at, expires_at, game_id`,
    [id, recipient],
  );
  return result.rows[0] ? challengeFromRow(result.rows[0]) : null;
}

// ── Friends ──────────────────────────────────────────────

export async function addFriend(a: string, b: string): Promise<boolean> {
  const pool = getPool();
  if (!pool || a === b) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO friendships (player_a, player_b)
       VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [a, b],
    );
    await client.query(
      `DELETE FROM friend_requests
       WHERE (from_address = $1 AND to_address = $2)
          OR (from_address = $2 AND to_address = $1)`,
      [a, b],
    );
    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK");
    return false;
  } finally {
    client.release();
  }
}

export async function removeFriend(a: string, b: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(`DELETE FROM friendships WHERE (player_a = $1 AND player_b = $2) OR (player_a = $2 AND player_b = $1)`, [a, b]);
    return true;
  } catch { return false; }
}

export async function getFriends(address: string): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(`SELECT player_b FROM friendships WHERE player_a = $1`, [address]);
    return r.rows.map((row) => row.player_b);
  } catch { return []; }
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    const r = await pool.query(`SELECT 1 FROM friendships WHERE player_a = $1 AND player_b = $2`, [a, b]);
    return r.rows.length > 0;
  } catch { return false; }
}

export async function sendFriendRequest(from: string, to: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(`INSERT INTO friend_requests (from_address, to_address) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [from, to]);
    return true;
  } catch { return false; }
}

export async function getIncomingRequests(address: string): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(`SELECT from_address FROM friend_requests WHERE to_address = $1`, [address]);
    return r.rows.map((row) => row.from_address);
  } catch { return []; }
}

export async function getOutgoingRequests(address: string): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(`SELECT to_address FROM friend_requests WHERE from_address = $1`, [address]);
    return r.rows.map((row) => row.to_address);
  } catch { return []; }
}

export async function removeFriendRequest(from: string, to: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(`DELETE FROM friend_requests WHERE from_address = $1 AND to_address = $2`, [from, to]);
    return true;
  } catch { return false; }
}

export async function hasPendingRequest(from: string, to: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    "SELECT 1 FROM friend_requests WHERE from_address = $1 AND to_address = $2",
    [from, to],
  );
  return result.rowCount === 1;
}

export async function acceptFriendRequest(from: string, to: string): Promise<boolean> {
  const pool = getPool();
  if (!pool || from === to) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removed = await client.query(
      `DELETE FROM friend_requests
       WHERE from_address = $1 AND to_address = $2
       RETURNING from_address`,
      [from, to],
    );
    if (removed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO friendships (player_a, player_b)
       VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [from, to],
    );
    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK");
    return false;
  } finally {
    client.release();
  }
}

// ── Trust and safety ─────────────────────────────────────

export async function isBlockedEitherDirection(a: string, b: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT 1
       FROM user_blocks
      WHERE (blocker = $1 AND blocked = $2)
         OR (blocker = $2 AND blocked = $1)
      LIMIT 1`,
    [a, b],
  );
  return result.rowCount === 1;
}

export async function getBlockedUsers(blocker: string): Promise<string[]> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query<{ blocked: string }>(
    "SELECT blocked FROM user_blocks WHERE blocker = $1 ORDER BY created_at DESC",
    [blocker],
  );
  return result.rows.map((row) => row.blocked);
}

export async function blockUser(blocker: string, blocked: string): Promise<boolean> {
  const pool = getPool();
  if (!pool || blocker === blocked) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO user_blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [blocker, blocked],
    );
    await client.query(
      `DELETE FROM friendships
        WHERE (player_a = $1 AND player_b = $2)
           OR (player_a = $2 AND player_b = $1)`,
      [blocker, blocked],
    );
    await client.query(
      `DELETE FROM friend_requests
        WHERE (from_address = $1 AND to_address = $2)
           OR (from_address = $2 AND to_address = $1)`,
      [blocker, blocked],
    );
    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK");
    return false;
  } finally {
    client.release();
  }
}

export async function unblockUser(blocker: string, blocked: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    "DELETE FROM user_blocks WHERE blocker = $1 AND blocked = $2",
    [blocker, blocked],
  );
  return result.rowCount === 1;
}

export type ModerationNarrativeStatus = "available" | "backup_restore_required";

export interface ModerationReport {
  readonly id: string;
  readonly reporter: string;
  readonly target: string;
  readonly category: "cheating" | "harassment" | "inappropriate_name" | "other";
  readonly description: string | null;
  /**
   * Indicates an immutable migration reconciliation outcome, never narrative
   * content. This field is only returned by moderator-authorized operations.
   */
  readonly narrativeStatus: ModerationNarrativeStatus;
  readonly state: "open" | "investigating" | "resolved" | "closed";
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type ReportState = ModerationReport["state"];
export type ModerationResolutionCode = "action_taken" | "no_action" | "duplicate" | "insufficient_evidence";

interface ReportRow {
  readonly id: string;
  readonly reporter: string;
  readonly target: string;
  readonly category: ModerationReport["category"];
  readonly descriptionEncrypted: EncryptedPayload | null;
  readonly narrativeReconciliationOutcome: "backup_restore_required" | null;
  readonly state: ReportState;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly resolutionCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const reportSelect = `
  SELECT user_reports.id, user_reports.reporter, user_reports.target, user_reports.category,
         user_reports.description_encrypted AS "descriptionEncrypted",
         reconciliation.outcome AS "narrativeReconciliationOutcome",
         user_reports.state,
         user_reports.claimed_by AS "claimedBy", user_reports.claimed_at AS "claimedAt",
         user_reports.resolved_by AS "resolvedBy", user_reports.resolved_at AS "resolvedAt",
         user_reports.resolution_code AS "resolutionCode",
         user_reports.created_at AS "createdAt", user_reports.updated_at AS "updatedAt"
    FROM user_reports
    LEFT JOIN user_report_narrative_reconciliations reconciliation
      ON reconciliation.report_id = user_reports.id`;

function reportFromRow(row: ReportRow): ModerationReport {
  let description: string | null = null;
  if (row.descriptionEncrypted) {
    const payload = decryptSensitiveJson<{ description: unknown }>(row.descriptionEncrypted, row.id);
    if (typeof payload.description !== "string" || payload.description.length > 500) {
      throw new Error("REPORT_DESCRIPTION_CORRUPTED");
    }
    description = payload.description;
  }
  return {
    id: row.id,
    reporter: row.reporter,
    target: row.target,
    category: row.category,
    description,
    narrativeStatus: row.narrativeReconciliationOutcome ?? "available",
    state: row.state,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionCode: row.resolutionCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createUserReport(input: {
  id: string;
  reporter: string;
  requestId: string;
  target: string;
  category: "cheating" | "harassment" | "inappropriate_name" | "other";
  payloadHash: string;
  descriptionEncrypted: EncryptedPayload;
}): Promise<{ id: string } | null> {
  const pool = getPool();
  if (!pool || input.reporter === input.target) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.reporter]);
    const idempotent = await client.query<{ id: string; payload_hash: string }>(
      "SELECT id, payload_hash FROM user_reports WHERE reporter = $1 AND request_id = $2 FOR UPDATE",
      [input.reporter, input.requestId],
    );
    if (idempotent.rows[0]) {
      if (idempotent.rows[0].payload_hash !== input.payloadHash) throw new Error("REPORT_IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      return { id: idempotent.rows[0].id };
    }
    const target = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM player_profiles profile
          WHERE profile.address = $2
            AND (
              $3 = 'inappropriate_name'
              OR EXISTS (
                SELECT 1
                  FROM games game
                 WHERE (game.player_white = $1 AND game.player_black = $2)
                    OR (game.player_white = $2 AND game.player_black = $1)
              )
            )
       ) AS allowed`,
      [input.reporter, input.target, input.category],
    );
    if (!target.rows[0]?.allowed) throw new Error("REPORT_TARGET_INELIGIBLE");
    const duplicate = await client.query<{ id: string }>(
      `SELECT id
         FROM user_reports
        WHERE reporter = $1
          AND target = $2
          AND category = $3
          AND state IN ('open', 'investigating')
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [input.reporter, input.target, input.category],
    );
    if (duplicate.rows[0]) {
      await client.query("COMMIT");
      return { id: duplicate.rows[0].id };
    }
    const quota = await client.query(
      `INSERT INTO user_report_submission_windows (reporter, window_started_at, submitted_count, updated_at)
       VALUES ($1, NOW(), 1, NOW())
       ON CONFLICT (reporter) DO UPDATE
         SET window_started_at = CASE
               WHEN user_report_submission_windows.window_started_at <= NOW() - INTERVAL '1 hour' THEN NOW()
               ELSE user_report_submission_windows.window_started_at
             END,
             submitted_count = CASE
               WHEN user_report_submission_windows.window_started_at <= NOW() - INTERVAL '1 hour' THEN 1
               ELSE user_report_submission_windows.submitted_count + 1
             END,
             updated_at = NOW()
       WHERE user_report_submission_windows.window_started_at <= NOW() - INTERVAL '1 hour'
          OR user_report_submission_windows.submitted_count < 5
       RETURNING submitted_count`,
      [input.reporter],
    );
    if (quota.rowCount !== 1) throw new Error("REPORT_RATE_LIMITED");
    const report = await client.query<{ id: string }>(
      `INSERT INTO user_reports
         (id, reporter, request_id, target, category, payload_hash, description_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.id,
        input.reporter,
        input.requestId,
        input.target,
        input.category,
        input.payloadHash,
        input.descriptionEncrypted,
      ],
    );
    await client.query("COMMIT");
    return report.rows[0] ?? null;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is being released after an already-failed transaction.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listModerationReports(input: {
  state?: ReportState;
  limit: number;
}): Promise<ModerationReport[]> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query<ReportRow>(
    `${reportSelect}
      WHERE ($1::text IS NULL OR state = $1)
      ORDER BY CASE state
        WHEN 'open' THEN 0
        WHEN 'investigating' THEN 1
        WHEN 'resolved' THEN 2
        ELSE 3
      END, created_at ASC, id ASC
      LIMIT $2`,
    [input.state ?? null, input.limit],
  );
  return result.rows.map(reportFromRow);
}

export async function claimModerationReport(
  reportId: string,
  moderator: string,
): Promise<ModerationReport> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<ReportRow>(`${reportSelect} WHERE id = $1 FOR UPDATE`, [reportId]);
    const report = current.rows[0];
    if (!report) throw new Error("REPORT_NOT_FOUND");
    if (report.state === "investigating" && report.claimedBy === moderator) {
      await client.query("COMMIT");
      return reportFromRow(report);
    }
    if (report.state !== "open") throw new Error("REPORT_NOT_CLAIMABLE");
    await client.query(
      `UPDATE user_reports
          SET state = 'investigating', claimed_by = $2, claimed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [reportId, moderator],
    );
    await client.query(
      `INSERT INTO user_report_audit
        (report_id, event_type, actor, prior_state, next_state)
       VALUES ($1, 'claimed', $2, 'open', 'investigating')`,
      [reportId, moderator],
    );
    const claimed = await client.query<ReportRow>(`${reportSelect} WHERE id = $1`, [reportId]);
    await client.query("COMMIT");
    const claimedReport = claimed.rows[0];
    if (!claimedReport) throw new Error("REPORT_NOT_FOUND");
    return reportFromRow(claimedReport);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveModerationReport(
  reportId: string,
  moderator: string,
  resolutionCode: ModerationResolutionCode,
): Promise<ModerationReport> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<ReportRow>(`${reportSelect} WHERE id = $1 FOR UPDATE`, [reportId]);
    const report = current.rows[0];
    if (!report) throw new Error("REPORT_NOT_FOUND");
    if (
      report.state === "resolved"
      && report.resolvedBy === moderator
      && report.resolutionCode === resolutionCode
    ) {
      await client.query("COMMIT");
      return reportFromRow(report);
    }
    if (report.state !== "investigating" || report.claimedBy !== moderator) {
      throw new Error("REPORT_NOT_RESOLVABLE");
    }
    await client.query(
      `UPDATE user_reports
          SET state = 'resolved', resolved_by = $2, resolved_at = NOW(),
              resolution_code = $3, updated_at = NOW()
        WHERE id = $1`,
      [reportId, moderator, resolutionCode],
    );
    await client.query(
      `INSERT INTO user_report_audit
        (report_id, event_type, actor, prior_state, next_state, resolution_code)
       VALUES ($1, 'resolved', $2, 'investigating', 'resolved', $3)`,
      [reportId, moderator, resolutionCode],
    );
    const resolved = await client.query<ReportRow>(`${reportSelect} WHERE id = $1`, [reportId]);
    await client.query("COMMIT");
    const resolvedReport = resolved.rows[0];
    if (!resolvedReport) throw new Error("REPORT_NOT_FOUND");
    return reportFromRow(resolvedReport);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ── Leaderboard ──────────────────────────────────────────

export async function getLeaderboard(limit = 50, offset = 0): Promise<Array<{
  rank: number; address: string; displayName: string; rating: number;
  wins: number; losses: number; totalGames: number;
}>> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT r.address, r.rating, r.total_games,
            COALESCE(NULLIF(p.display_name, ''), p.username, r.address) AS display_name,
            COALESCE(s.wins, 0) AS wins, COALESCE(s.losses, 0) AS losses
       FROM player_ratings r
       LEFT JOIN player_profiles p ON r.address = p.address
       LEFT JOIN player_stats s ON r.address = s.address
       WHERE r.total_games > 0
       ORDER BY r.rating DESC, r.address ASC
       LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map((row, index) => ({
    rank: offset + index + 1,
    address: row.address,
    displayName: row.display_name,
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
    totalGames: row.total_games,
  }));
}
export async function getLeaderboardSize(): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM player_ratings WHERE total_games > 0",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getPlayerRank(address: string): Promise<number | null> {
  const pool = getPool();
  if (!pool) throw new Error("SOCIAL_STORE_UNAVAILABLE");
  const result = await pool.query<{ rank: string }>(
    `SELECT (
       SELECT COUNT(*) + 1
         FROM player_ratings higher
        WHERE higher.total_games > 0
          AND (higher.rating > target.rating OR (higher.rating = target.rating AND higher.address < target.address))
     )::text AS rank
       FROM player_ratings target
      WHERE target.address = $1 AND target.total_games > 0`,
    [address],
  );
  return result.rows[0] ? Number(result.rows[0].rank) : null;
}

