import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { Player } from "@xion-beginner/backgammon-core";
import type { MatchmakingEntry, PlayerConnection } from "./types.js";
import type { GameManager } from "./game-manager.js";
import { MATCHMAKING_RATING_RANGE } from "./config.js";
import { getPool } from "./db.js";
import { reserveWaitingGame } from "./game-store.js";

export interface MatchmakingResult {
  readonly matched: boolean;
  readonly gameId?: string;
  readonly color?: Player;
  readonly opponentAddress?: string;
  readonly matchLength?: number;
  readonly position?: number;
}

export interface MatchmakingNotification {
  readonly address: string;
  readonly gameId: string;
  readonly color: Player;
  readonly matchLength: number;
  readonly ws: MatchmakingEntry["ws"];
}

export class Matchmaker {
  private readonly localEntries = new Map<string, MatchmakingEntry>();

  constructor(
    private readonly gameManager: GameManager,
    private readonly instanceId: string,
  ) {}

  /**
   * A committed match without publication is not a queue entry: it owns two
   * principals.  Reclaim the complete unit atomically so a later pairing never
   * observes requeued users still reserved by an orphan game.
   */
  private async abandonStaleReservations(client: PoolClient): Promise<void> {
    const stale = await client.query<{ game_id: string }>(
      `SELECT game_id
         FROM matchmaking_queue
        WHERE state = 'matched' AND ready_at IS NULL AND claim_expires_at <= NOW()
        FOR UPDATE`,
    );
    const gameIds = stale.rows.map((row) => row.game_id);
    const principals = await client.query<{ principal: string }>(
      "SELECT principal FROM active_game_principals WHERE game_id = ANY($1::text[]) ORDER BY principal FOR UPDATE",
      [gameIds],
    );
    for (const { principal } of principals.rows) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [principal]);
    }
    if (gameIds.length === 0) return;
    await client.query(
      `UPDATE games SET status = 'abandoned', finished_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::text[]) AND status = 'waiting'`,
      [gameIds],
    );
    await client.query("DELETE FROM active_game_principals WHERE game_id = ANY($1::text[])", [gameIds]);
    await client.query(
      `UPDATE matchmaking_queue
          SET state = 'queued', game_id = NULL, owner_instance_id = NULL, color = NULL,
              claim_expires_at = NULL, ready_at = NULL, notified_at = NULL, joined_game_at = NULL,
              expires_at = NOW() + INTERVAL '2 minutes', joined_at = NOW()
        WHERE game_id = ANY($1::text[]) AND state = 'matched'`,
      [gameIds],
    );
  }

  async sweepStaleReservations(): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await this.abandonStaleReservations(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async createOwnedGame(
    entry: MatchmakingEntry,
    gameId: string,
    color: Player,
    matchLength: number,
  ): Promise<void> {
    const game = await this.gameManager.hydrateGameForParticipant(gameId, entry.address);
    if (!game) throw new Error("MATCHMAKING_RESERVATION_NOT_FOUND");
    if (matchLength > 1) game.pendingMatchLength = matchLength;
    const player: PlayerConnection = {
      ws: entry.ws,
      address: entry.address,
      rating: entry.rating,
      connectedAt: entry.joinedAt,
    };
    const joined = await this.gameManager.joinGame(game.id, player);
    if (!joined || joined.color !== color) throw new Error("MATCHMAKING_GAME_CREATION_FAILED");
    const pool = getPool();
    if (pool) {
      await pool.query(
        `UPDATE matchmaking_queue
            SET ready_at = COALESCE(ready_at, NOW()),
                joined_game_at = CASE
                  WHEN address = $3 THEN COALESCE(joined_game_at, NOW())
                  ELSE joined_game_at
                END,
                claim_expires_at = NULL
          WHERE game_id = $1 AND owner_instance_id = $2 AND state = 'matched'`,
        [gameId, this.instanceId, entry.address],
      );
    }
  }

  async addToQueue(entry: MatchmakingEntry): Promise<MatchmakingResult> {
    this.localEntries.set(entry.address, entry);
    const pool = getPool();
    if (!pool) throw new Error("DATABASE_UNAVAILABLE");
    const client = await pool.connect();
    let result: MatchmakingResult;
    let createOwned = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${entry.wagerAmount}:${entry.matchLength}`,
      ]);
      await this.abandonStaleReservations(client);
      await client.query(
        `DELETE FROM matchmaking_queue queue
          WHERE state = 'queued' AND expires_at <= NOW()
             OR (state = 'matched' AND EXISTS (
               SELECT 1 FROM games game
                WHERE game.id = queue.game_id AND game.status NOT IN ('waiting', 'playing')
             ))`,
      );
      await client.query(
        "INSERT INTO player_ratings (address) VALUES ($1) ON CONFLICT DO NOTHING",
        [entry.address],
      );
      const ratingRow = await client.query<{ rating: number }>(
        "SELECT rating FROM player_ratings WHERE address = $1 FOR UPDATE",
        [entry.address],
      );
      const durableRating = ratingRow.rows[0]?.rating;
      if (!Number.isSafeInteger(durableRating)) throw new Error("RATING_UNAVAILABLE");
      const activeMatch = await client.query(
        `SELECT 1
           FROM active_game_principals active
           JOIN backgammon_match_games match_game ON match_game.game_id = active.game_id
           JOIN backgammon_matches match ON match.id = match_game.match_id
          WHERE active.principal = $1 AND match.status = 'playing'
          LIMIT 1`,
        [entry.address],
      );
      if (activeMatch.rowCount) throw new Error("MATCH_ACTIVE");
      const existing = await client.query<{
        state: "queued" | "matched";
        game_id: string | null;
        owner_instance_id: string | null;
        color: Player | null;
        match_length: number;
        ready_at: Date | null;
        game_status: string | null;
      }>(
        `SELECT queue.state, queue.game_id, queue.owner_instance_id, queue.color,
                queue.match_length, queue.ready_at, game.status AS game_status
           FROM matchmaking_queue queue
           LEFT JOIN games game ON game.id = queue.game_id
          WHERE queue.address = $1
          FOR UPDATE OF queue`,
        [entry.address],
      );
      const current = existing.rows[0];
      if (current?.state === "matched" && current.game_id && current.color) {
        if (current.ready_at && !["waiting", "playing"].includes(current.game_status ?? "")) {
          await client.query(
            "DELETE FROM matchmaking_queue WHERE game_id = $1 AND state = 'matched'",
            [current.game_id],
          );
        } else {
          await client.query("COMMIT");
          return {
            matched: current.ready_at !== null,
            gameId: current.ready_at ? current.game_id : undefined,
            color: current.ready_at ? current.color : undefined,
            matchLength: current.match_length,
            position: current.ready_at ? undefined : 1,
          };
        }
      }
      await client.query(
        `INSERT INTO matchmaking_queue
          (address, instance_id, rating, wager_amount, match_length, state, joined_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), NOW() + INTERVAL '2 minutes')
         ON CONFLICT (address) DO UPDATE
           SET instance_id = EXCLUDED.instance_id, rating = EXCLUDED.rating,
               wager_amount = EXCLUDED.wager_amount, match_length = EXCLUDED.match_length,
               joined_at = NOW(), expires_at = NOW() + INTERVAL '2 minutes', notified_at = NULL
         WHERE matchmaking_queue.state = 'queued'`,
        [entry.address, this.instanceId, durableRating, entry.wagerAmount, entry.matchLength],
      );
      const candidate = await client.query<{
        address: string;
        rating: number;
        match_length: number;
      }>(
        `SELECT candidate.address, rating.rating, candidate.match_length
           FROM matchmaking_queue candidate
           JOIN player_ratings rating ON rating.address = candidate.address
          WHERE candidate.state = 'queued'
            AND candidate.address <> $1
            AND candidate.expires_at > NOW()
            AND candidate.wager_amount = $2
            AND candidate.match_length = $3
            AND ABS(rating.rating - $4) <= $5
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks block
               WHERE (block.blocker = $1 AND block.blocked = candidate.address)
                  OR (block.blocker = candidate.address AND block.blocked = $1)
            )
          ORDER BY candidate.joined_at, candidate.address
          FOR UPDATE OF candidate, rating SKIP LOCKED
          LIMIT 1`,
        [entry.address, entry.wagerAmount, entry.matchLength, durableRating, MATCHMAKING_RATING_RANGE],
      );
      const opponent = candidate.rows[0];
      if (!opponent) {
        const position = await client.query<{ position: string }>(
          `SELECT COUNT(*)::text AS position FROM matchmaking_queue
            WHERE state = 'queued' AND joined_at <= (
              SELECT joined_at FROM matchmaking_queue WHERE address = $1
            )`,
          [entry.address],
        );
        await client.query("COMMIT");
        return { matched: false, position: Number(position.rows[0]?.position ?? "1") };
      }
      const gameId = randomUUID();
      await reserveWaitingGame(client, {
        id: gameId,
        playerWhite: entry.address,
        playerBlack: opponent.address,
        turnTimeLimit: 60,
        doublingAllowed: true,
        pendingMatchLength: entry.matchLength,
        ownerInstanceId: this.instanceId,
      });
      const updated = await client.query(
        `UPDATE matchmaking_queue
            SET state = 'matched', game_id = $3, owner_instance_id = $4,
                color = CASE WHEN address = $1 THEN 'white' ELSE 'black' END,
                claim_expires_at = NOW() + INTERVAL '30 seconds',
                ready_at = NULL, notified_at = NULL, joined_game_at = NULL,
                expires_at = NOW() + INTERVAL '100 years'
          WHERE address IN ($1, $2) AND state = 'queued'`,
        [entry.address, opponent.address, gameId, this.instanceId],
      );
      if (updated.rowCount !== 2) throw new Error("MATCHMAKING_CLAIM_LOST");
      await client.query("COMMIT");
      result = {
        matched: true,
        gameId,
        color: "white",
        opponentAddress: opponent.address,
        matchLength: entry.matchLength,
      };
      createOwned = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (createOwned && result.gameId && result.color) {
      await this.createOwnedGame(entry, result.gameId, result.color, result.matchLength ?? entry.matchLength);
    }
    return result;
  }

  async takeMatchedNotifications(): Promise<readonly MatchmakingNotification[]> {
    const pool = getPool();
    if (!pool) return [];
    const localAddresses = [...this.localEntries.keys()];
    if (localAddresses.length === 0) return [];
    const matched = await pool.query<{
      address: string;
      game_id: string;
      color: Player;
      match_length: number;
    }>(
      `SELECT address, game_id, color, match_length
         FROM matchmaking_queue
        WHERE address = ANY($1::text[])
          AND instance_id = $2
          AND state = 'matched'
          AND ready_at IS NOT NULL
          AND joined_game_at IS NULL
          AND (notified_at IS NULL OR notified_at <= NOW() - INTERVAL '5 seconds')`,
      [localAddresses, this.instanceId],
    );
    return matched.rows.flatMap((row) => {
      const entry = this.localEntries.get(row.address);
      return entry ? [{
        address: row.address,
        gameId: row.game_id,
        color: row.color,
        matchLength: row.match_length,
        ws: entry.ws,
      }] : [];
    });
  }

  async markNotified(address: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      "UPDATE matchmaking_queue SET notified_at = NOW() WHERE address = $1 AND state = 'matched' AND joined_game_at IS NULL",
      [address],
    );
  }

  async acknowledgeGameJoin(address: string, gameId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      "UPDATE matchmaking_queue SET joined_game_at = NOW() WHERE address = $1 AND game_id = $2 AND state = 'matched'",
      [address, gameId],
    );
  }


  async removeFromQueue(address: string): Promise<boolean> {
    this.localEntries.delete(address);
    const pool = getPool();
    if (!pool) return false;
    const removed = await pool.query(
      "DELETE FROM matchmaking_queue WHERE address = $1 AND state = 'queued'",
      [address],
    );
    return removed.rowCount === 1;
  }
}
