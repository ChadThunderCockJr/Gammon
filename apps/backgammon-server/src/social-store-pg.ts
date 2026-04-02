/**
 * PostgreSQL-backed social store.
 * Provides durable persistence for profiles, ratings, stats, match results, and friends.
 * When PostgreSQL is available, it's the source of truth. Redis remains for:
 * - Online presence (ephemeral, TTL-based)
 * - Challenges (short-lived, 60s expiry)
 * - Activity feed (append-only cache)
 * - Leaderboard cache (rebuilt from ratings)
 */

import { getPool } from "./db.js";
import { logger } from "./logger.js";
import { RATING_DEFAULT, RATING_K_PROVISIONAL, RATING_K_INTERMEDIATE, RATING_K_ESTABLISHED, RATING_PROVISIONAL_THRESHOLD, RATING_ESTABLISHED_THRESHOLD, RATING_MIN } from "./config.js";

// ── Profiles ──────────────────────────────────────────────

export async function getProfile(address: string): Promise<{ address: string; displayName: string; username: string | null } | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT address, display_name, username FROM player_profiles WHERE address = $1`, [address]);
    if (r.rows.length === 0) return null;
    return { address: r.rows[0].address, displayName: r.rows[0].display_name, username: r.rows[0].username };
  } catch { return null; }
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
  try {
    await pool.query(
      `INSERT INTO player_profiles (address, username) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET username = $2, updated_at = NOW()`,
      [address, username],
    );
    return { ok: true };
  } catch (err: any) {
    if (err.code === "23505") return { ok: false, error: "Username already taken" };
    return { ok: false, error: String(err) };
  }
}

export async function ensureProfile(address: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO player_profiles (address, display_name) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING`,
      [address, address.slice(0, 8) + "..."],
    );
  } catch { /* ignore */ }
}

export async function searchPlayers(query: string): Promise<Array<{ address: string; username: string; displayName: string }>> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT address, COALESCE(username, '') as username, display_name
       FROM player_profiles
       WHERE username ILIKE $1 OR display_name ILIKE $1 OR address ILIKE $1
       LIMIT 10`,
      [`%${query}%`],
    );
    return r.rows.map((row) => ({ address: row.address, username: row.username, displayName: row.display_name }));
  } catch { return []; }
}

// ── Ratings ──────────────────────────────────────────────

export async function getRating(address: string): Promise<{ rating: number; ratingChange: number }> {
  const pool = getPool();
  if (!pool) return { rating: RATING_DEFAULT, ratingChange: 0 };
  try {
    const r = await pool.query(`SELECT rating, rating_change FROM player_ratings WHERE address = $1`, [address]);
    if (r.rows.length === 0) return { rating: RATING_DEFAULT, ratingChange: 0 };
    return { rating: r.rows[0].rating, ratingChange: r.rows[0].rating_change };
  } catch { return { rating: RATING_DEFAULT, ratingChange: 0 }; }
}

function getKFactor(totalGames: number): number {
  if (totalGames < RATING_PROVISIONAL_THRESHOLD) return RATING_K_PROVISIONAL;
  if (totalGames < RATING_ESTABLISHED_THRESHOLD) return RATING_K_INTERMEDIATE;
  return RATING_K_ESTABLISHED;
}

export async function updateRatings(winnerAddr: string, loserAddr: string): Promise<{ winnerRating: number; loserRating: number; winnerChange: number; loserChange: number }> {
  const pool = getPool();
  if (!pool) return { winnerRating: RATING_DEFAULT, loserRating: RATING_DEFAULT, winnerChange: 0, loserChange: 0 };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert both players
    await client.query(`INSERT INTO player_ratings (address) VALUES ($1) ON CONFLICT DO NOTHING`, [winnerAddr]);
    await client.query(`INSERT INTO player_ratings (address) VALUES ($1) ON CONFLICT DO NOTHING`, [loserAddr]);

    const wr = await client.query(`SELECT rating, total_games FROM player_ratings WHERE address = $1 FOR UPDATE`, [winnerAddr]);
    const lr = await client.query(`SELECT rating, total_games FROM player_ratings WHERE address = $1 FOR UPDATE`, [loserAddr]);

    const winnerRating = wr.rows[0].rating;
    const loserRating = lr.rows[0].rating;
    const winnerK = getKFactor(wr.rows[0].total_games);
    const loserK = getKFactor(lr.rows[0].total_games);

    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLoser = 1 - expectedWinner;

    const winnerChange = Math.round(winnerK * (1 - expectedWinner));
    const loserChange = Math.round(loserK * (0 - expectedLoser));

    const newWinnerRating = Math.max(RATING_MIN, winnerRating + winnerChange);
    const newLoserRating = Math.max(RATING_MIN, loserRating + loserChange);

    await client.query(
      `UPDATE player_ratings SET rating = $2, rating_change = $3, total_games = total_games + 1, updated_at = NOW() WHERE address = $1`,
      [winnerAddr, newWinnerRating, winnerChange],
    );
    await client.query(
      `UPDATE player_ratings SET rating = $2, rating_change = $3, total_games = total_games + 1, updated_at = NOW() WHERE address = $1`,
      [loserAddr, newLoserRating, loserChange],
    );

    await client.query("COMMIT");
    return { winnerRating: newWinnerRating, loserRating: newLoserRating, winnerChange, loserChange };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Failed to update ratings", { error: String(err) });
    return { winnerRating: RATING_DEFAULT, loserRating: RATING_DEFAULT, winnerChange: 0, loserChange: 0 };
  } finally {
    client.release();
  }
}

// ── Stats ──────────────────────────────────────────────

export async function updateStats(address: string, result: "W" | "L", resultType: string = "normal"): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO player_stats (address) VALUES ($1) ON CONFLICT DO NOTHING`, [address]);

    if (result === "W") {
      const isGammon = resultType === "gammon" ? 1 : 0;
      const isBackgammon = resultType === "backgammon" ? 1 : 0;
      await pool.query(
        `UPDATE player_stats SET
           wins = wins + 1,
           current_streak = CASE WHEN current_streak_type = 'W' THEN current_streak + 1 ELSE 1 END,
           current_streak_type = 'W',
           best_streak = GREATEST(best_streak, CASE WHEN current_streak_type = 'W' THEN current_streak + 1 ELSE 1 END),
           total_gammons = total_gammons + $2,
           total_backgammons = total_backgammons + $3,
           updated_at = NOW()
         WHERE address = $1`,
        [address, isGammon, isBackgammon],
      );
    } else {
      await pool.query(
        `UPDATE player_stats SET
           losses = losses + 1,
           current_streak = CASE WHEN current_streak_type = 'L' THEN current_streak + 1 ELSE 1 END,
           current_streak_type = 'L',
           updated_at = NOW()
         WHERE address = $1`,
        [address],
      );
    }
  } catch (err) {
    logger.error("Failed to update stats", { address, error: String(err) });
  }
}

export async function getStats(address: string): Promise<{
  wins: number; losses: number; currentStreak: number; currentStreakType: string;
  bestStreak: number; totalGammons: number; totalBackgammons: number;
}> {
  const pool = getPool();
  if (!pool) return { wins: 0, losses: 0, currentStreak: 0, currentStreakType: "", bestStreak: 0, totalGammons: 0, totalBackgammons: 0 };
  try {
    const r = await pool.query(`SELECT * FROM player_stats WHERE address = $1`, [address]);
    if (r.rows.length === 0) return { wins: 0, losses: 0, currentStreak: 0, currentStreakType: "", bestStreak: 0, totalGammons: 0, totalBackgammons: 0 };
    const s = r.rows[0];
    return {
      wins: s.wins, losses: s.losses, currentStreak: s.current_streak,
      currentStreakType: s.current_streak_type, bestStreak: s.best_streak,
      totalGammons: s.total_gammons, totalBackgammons: s.total_backgammons,
    };
  } catch { return { wins: 0, losses: 0, currentStreak: 0, currentStreakType: "", bestStreak: 0, totalGammons: 0, totalBackgammons: 0 }; }
}

// ── Match Results ──────────────────────────────────────────

export async function recordMatchResult(address: string, result: {
  gameId: string; opponent: string; opponentName: string; result: string;
  resultType: string; wagerAmount: number; ratingChange: number;
}): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO match_results (address, game_id, opponent, opponent_name, result, result_type, wager_amount, rating_change)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [address, result.gameId, result.opponent, result.opponentName, result.result, result.resultType, result.wagerAmount, result.ratingChange],
    );
  } catch (err) {
    logger.error("Failed to record match result", { address, error: String(err) });
  }
}

export async function getMatchResults(address: string, limit = 20): Promise<Array<{
  gameId: string; opponent: string; opponentName: string; result: string;
  resultType: string; wagerAmount: number; ratingChange: number; timestamp: number;
}>> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT game_id, opponent, opponent_name, result, result_type, wager_amount, rating_change, created_at
       FROM match_results WHERE address = $1 ORDER BY created_at DESC LIMIT $2`,
      [address, limit],
    );
    return r.rows.map((row) => ({
      gameId: row.game_id, opponent: row.opponent, opponentName: row.opponent_name,
      result: row.result, resultType: row.result_type, wagerAmount: row.wager_amount,
      ratingChange: row.rating_change, timestamp: new Date(row.created_at).getTime(),
    }));
  } catch { return []; }
}

// ── Friends ──────────────────────────────────────────────

export async function addFriend(a: string, b: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    // Insert both directions for easy lookup
    await pool.query(`INSERT INTO friendships (player_a, player_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a, b]);
    await pool.query(`INSERT INTO friendships (player_a, player_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [b, a]);
    // Remove any pending friend request
    await pool.query(`DELETE FROM friend_requests WHERE (from_address = $1 AND to_address = $2) OR (from_address = $2 AND to_address = $1)`, [a, b]);
    return true;
  } catch { return false; }
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

// ── Leaderboard ──────────────────────────────────────────

export async function getLeaderboard(limit = 50, offset = 0): Promise<Array<{
  rank: number; address: string; displayName: string; rating: number;
  wins: number; losses: number; totalGames: number;
}>> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT r.address, r.rating, r.total_games,
              COALESCE(p.display_name, r.address) as display_name,
              COALESCE(s.wins, 0) as wins, COALESCE(s.losses, 0) as losses
       FROM player_ratings r
       LEFT JOIN player_profiles p ON r.address = p.address
       LEFT JOIN player_stats s ON r.address = s.address
       WHERE r.total_games > 0
       ORDER BY r.rating DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return r.rows.map((row, idx) => ({
      rank: offset + idx + 1,
      address: row.address,
      displayName: row.display_name,
      rating: row.rating,
      wins: row.wins,
      losses: row.losses,
      totalGames: row.total_games,
    }));
  } catch { return []; }
}

export async function getOnlineCount(): Promise<number> {
  // Online presence stays in Redis (ephemeral, TTL-based)
  // This function is a stub; callers should use the Redis version
  return 0;
}
