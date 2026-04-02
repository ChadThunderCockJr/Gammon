import { logger } from "./logger.js";
import { getPool } from "./db.js";
import type { BalanceService } from "./balance-service.js";

/**
 * Tournament system for bracket-style backgammon tournaments.
 *
 * Flow:
 * 1. Admin creates tournament (entry fee, max players, start time)
 * 2. Players register (entry fee locked from custodial balance)
 * 3. At start time, bracket is generated (single elimination)
 * 4. Matches are played in rounds
 * 5. Winner of each match advances
 * 6. Final winner gets prize pool minus rake
 *
 * Bracket structure: single elimination, power-of-2 bracket size.
 * Byes assigned randomly if player count isn't a power of 2.
 */

export interface Tournament {
  id: string;
  name: string;
  entryFee: number;
  maxPlayers: number;
  status: "registration" | "in_progress" | "finished" | "cancelled";
  players: string[];
  bracket: BracketMatch[];
  currentRound: number;
  totalRounds: number;
  winner: string | null;
  prizePool: number;
  createdAt: number;
  startAt: number;
}

export interface BracketMatch {
  round: number;
  matchIndex: number;
  playerA: string | null; // null = bye
  playerB: string | null;
  gameId: string | null;
  winner: string | null;
  status: "pending" | "in_progress" | "finished";
}

export class TournamentManager {
  private balanceService: BalanceService | null;

  constructor(balanceService?: BalanceService) {
    this.balanceService = balanceService ?? null;
  }

  /** Create a new tournament */
  async createTournament(name: string, entryFee: number, maxPlayers: number, startAt: number): Promise<string | null> {
    const pool = getPool();
    if (!pool) return null;

    const id = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO tournaments (id, name, entry_fee, max_players, status, start_at)
         VALUES ($1, $2, $3, $4, 'registration', to_timestamp($5 / 1000.0))`,
        [id, name, entryFee, maxPlayers, startAt],
      );
      logger.info("Tournament created", { id, name, entryFee, maxPlayers });
      return id;
    } catch (err) {
      logger.error("Failed to create tournament", { error: String(err) });
      return null;
    }
  }

  /** Register a player for a tournament */
  async registerPlayer(tournamentId: string, playerAddress: string): Promise<{ ok: boolean; error?: string }> {
    const pool = getPool();
    if (!pool) return { ok: false, error: "Database unavailable" };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const t = await client.query(
        `SELECT entry_fee, max_players, status FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId],
      );
      if (t.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, error: "Tournament not found" }; }
      if (t.rows[0].status !== "registration") { await client.query("ROLLBACK"); return { ok: false, error: "Registration closed" }; }

      const count = await client.query(
        `SELECT COUNT(*) FROM tournament_players WHERE tournament_id = $1`,
        [tournamentId],
      );
      if (parseInt(count.rows[0].count) >= t.rows[0].max_players) {
        await client.query("ROLLBACK");
        return { ok: false, error: "Tournament full" };
      }

      // Check if already registered
      const existing = await client.query(
        `SELECT 1 FROM tournament_players WHERE tournament_id = $1 AND address = $2`,
        [tournamentId, playerAddress],
      );
      if (existing.rows.length > 0) { await client.query("ROLLBACK"); return { ok: false, error: "Already registered" }; }

      // Lock entry fee from balance
      if (this.balanceService && t.rows[0].entry_fee > 0) {
        const hasBalance = await this.balanceService.checkBalance(playerAddress, t.rows[0].entry_fee);
        if (!hasBalance) { await client.query("ROLLBACK"); return { ok: false, error: "Insufficient balance" }; }
      }

      await client.query(
        `INSERT INTO tournament_players (tournament_id, address) VALUES ($1, $2)`,
        [tournamentId, playerAddress],
      );

      await client.query("COMMIT");
      logger.info("Player registered for tournament", { tournamentId, playerAddress });
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK");
      return { ok: false, error: String(err) };
    } finally {
      client.release();
    }
  }

  /** Generate bracket for a tournament (single elimination) */
  generateBracket(players: string[]): { bracket: BracketMatch[]; totalRounds: number } {
    // Pad to next power of 2
    let size = 1;
    while (size < players.length) size *= 2;
    const totalRounds = Math.log2(size);

    // Shuffle players
    const shuffled = [...players].sort(() => Math.random() - 0.5);

    // Fill with byes
    while (shuffled.length < size) shuffled.push("BYE");

    const bracket: BracketMatch[] = [];

    // First round
    for (let i = 0; i < size / 2; i++) {
      const a = shuffled[i * 2];
      const b = shuffled[i * 2 + 1];
      bracket.push({
        round: 1,
        matchIndex: i,
        playerA: a === "BYE" ? null : a,
        playerB: b === "BYE" ? null : b,
        gameId: null,
        winner: null,
        status: "pending",
      });
    }

    // Auto-advance byes in first round
    for (const match of bracket) {
      if (match.playerA === null && match.playerB !== null) {
        match.winner = match.playerB;
        match.status = "finished";
      } else if (match.playerB === null && match.playerA !== null) {
        match.winner = match.playerA;
        match.status = "finished";
      }
    }

    // Generate subsequent rounds (empty, filled as matches complete)
    let matchesInRound = size / 4;
    for (let round = 2; round <= totalRounds; round++) {
      for (let i = 0; i < matchesInRound; i++) {
        bracket.push({
          round,
          matchIndex: i,
          playerA: null,
          playerB: null,
          gameId: null,
          winner: null,
          status: "pending",
        });
      }
      matchesInRound /= 2;
    }

    return { bracket, totalRounds };
  }

  /** Report a match result and advance the winner */
  advanceWinner(bracket: BracketMatch[], round: number, matchIndex: number, winner: string): BracketMatch[] {
    const updated = [...bracket];

    // Find and update the match
    const match = updated.find((m) => m.round === round && m.matchIndex === matchIndex);
    if (!match) return updated;
    match.winner = winner;
    match.status = "finished";

    // Find the next round match
    const nextRound = round + 1;
    const nextMatchIndex = Math.floor(matchIndex / 2);
    const nextMatch = updated.find((m) => m.round === nextRound && m.matchIndex === nextMatchIndex);
    if (!nextMatch) return updated; // was the final

    // Place winner in the correct slot
    if (matchIndex % 2 === 0) {
      nextMatch.playerA = winner;
    } else {
      nextMatch.playerB = winner;
    }

    return updated;
  }

  /** Get upcoming tournaments */
  async getUpcoming(): Promise<Array<{ id: string; name: string; entryFee: number; maxPlayers: number; playerCount: number; startAt: number }>> {
    const pool = getPool();
    if (!pool) return [];
    try {
      const r = await pool.query(
        `SELECT t.id, t.name, t.entry_fee, t.max_players, t.start_at,
                COUNT(tp.address) as player_count
         FROM tournaments t
         LEFT JOIN tournament_players tp ON t.id = tp.tournament_id
         WHERE t.status = 'registration'
         GROUP BY t.id
         ORDER BY t.start_at ASC`,
      );
      return r.rows.map((row) => ({
        id: row.id, name: row.name, entryFee: row.entry_fee,
        maxPlayers: row.max_players, playerCount: parseInt(row.player_count),
        startAt: new Date(row.start_at).getTime(),
      }));
    } catch { return []; }
  }
}
