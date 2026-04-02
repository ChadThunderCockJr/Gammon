import type { ResultType } from "@xion-beginner/backgammon-core";
import type { BalanceService } from "./balance-service.js";
import { getPool } from "./db.js";
import { logger } from "./logger.js";

/**
 * Rake in basis points (1% = 100 bps). Configurable via env.
 */
const RAKE_BPS = parseInt(process.env.RAKE_BPS || "250", 10); // 2.5% default

function getResultMultiplier(resultType: ResultType): number {
  if (resultType === "backgammon") return 3;
  if (resultType === "gammon") return 2;
  return 1;
}

/**
 * BalanceService backed by PostgreSQL double-entry ledger.
 *
 * All fund operations use ACID transactions. Balances cannot go negative.
 * Every operation creates a ledger entry for auditability.
 *
 * Balance model:
 *   available = funds the player can use (deposit, withdraw, wager)
 *   locked    = funds committed to active games (released on settle/cancel)
 */
export class CustodialBalanceService implements BalanceService {

  async checkBalance(address: string, amount: number): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const result = await pool.query(
      `SELECT available FROM balances WHERE address = $1`,
      [address],
    );
    if (result.rows.length === 0) return false;
    return BigInt(result.rows[0].available) >= BigInt(amount);
  }

  async lockFunds(gameId: string, playerA: string, playerB: string, wagerAmount: number): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock both player rows for update (prevents concurrent wager races)
      const balA = await client.query(
        `SELECT available FROM balances WHERE address = $1 FOR UPDATE`,
        [playerA],
      );
      const balB = await client.query(
        `SELECT available FROM balances WHERE address = $1 FOR UPDATE`,
        [playerB],
      );

      if (balA.rows.length === 0 || balB.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const wager = BigInt(wagerAmount);
      if (BigInt(balA.rows[0].available) < wager || BigInt(balB.rows[0].available) < wager) {
        await client.query("ROLLBACK");
        return false;
      }

      // Debit available, credit locked for both players
      await client.query(
        `UPDATE balances SET available = available - $2, locked = locked + $2, updated_at = NOW() WHERE address = $1`,
        [playerA, wagerAmount],
      );
      await client.query(
        `UPDATE balances SET available = available - $2, locked = locked + $2, updated_at = NOW() WHERE address = $1`,
        [playerB, wagerAmount],
      );

      // Create wager record
      await client.query(
        `INSERT INTO game_wagers (game_id, player_a, player_b, wager_amount) VALUES ($1, $2, $3, $4)`,
        [gameId, playerA, playerB, wagerAmount],
      );

      // Ledger entries
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'wager_lock', $3, 'Wager locked for game')`,
        [playerA, -wagerAmount, gameId],
      );
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'wager_lock', $3, 'Wager locked for game')`,
        [playerB, -wagerAmount, gameId],
      );

      await client.query("COMMIT");
      logger.info("Funds locked for game", { gameId, playerA, playerB, wagerAmount });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to lock funds", { gameId, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }

  async settleFunds(gameId: string, winner: string, resultType: ResultType): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Get wager info
      const wagerResult = await client.query(
        `SELECT player_a, player_b, wager_amount, cube_value FROM game_wagers WHERE game_id = $1 AND status = 'active' FOR UPDATE`,
        [gameId],
      );
      if (wagerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const { player_a, player_b, wager_amount, cube_value } = wagerResult.rows[0];
      const loser = winner === player_a ? player_b : player_a;
      const multiplier = getResultMultiplier(resultType);
      const totalPot = BigInt(wager_amount) * BigInt(cube_value) * 2n; // both players' stakes
      const rake = (totalPot * BigInt(RAKE_BPS)) / 10000n;
      const payout = totalPot - rake;

      // Release locked funds from both players
      const lockedPerPlayer = BigInt(wager_amount) * BigInt(cube_value);
      await client.query(
        `UPDATE balances SET locked = locked - $2, updated_at = NOW() WHERE address = $1`,
        [player_a, lockedPerPlayer.toString()],
      );
      await client.query(
        `UPDATE balances SET locked = locked - $2, updated_at = NOW() WHERE address = $1`,
        [player_b, lockedPerPlayer.toString()],
      );

      // Credit winner
      await client.query(
        `UPDATE balances SET available = available + $2, updated_at = NOW() WHERE address = $1`,
        [winner, payout.toString()],
      );

      // Mark wager settled
      await client.query(
        `UPDATE game_wagers SET status = 'settled', settled_at = NOW() WHERE game_id = $1`,
        [gameId],
      );

      // Ledger entries
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'wager_settle', $3, $4)`,
        [winner, payout.toString(), gameId, `Won game (${resultType}, cube ${cube_value})`],
      );
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'wager_settle', $3, $4)`,
        [loser, 0, gameId, `Lost game (${resultType}, cube ${cube_value})`],
      );
      if (rake > 0n) {
        await client.query(
          `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ('platform_rake', $1, 'rake', $2, 'Platform rake')`,
          [rake.toString(), gameId],
        );
      }

      await client.query("COMMIT");
      logger.info("Funds settled", { gameId, winner, payout: payout.toString(), rake: rake.toString() });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to settle funds", { gameId, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }

  async cancelFunds(gameId: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const wagerResult = await client.query(
        `SELECT player_a, player_b, wager_amount, cube_value FROM game_wagers WHERE game_id = $1 AND status IN ('pending', 'active', 'awaiting_double') FOR UPDATE`,
        [gameId],
      );
      if (wagerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const { player_a, player_b, wager_amount, cube_value } = wagerResult.rows[0];
      const lockedPerPlayer = BigInt(wager_amount) * BigInt(cube_value);

      // Return locked funds to both players
      await client.query(
        `UPDATE balances SET available = available + $2, locked = locked - $2, updated_at = NOW() WHERE address = $1`,
        [player_a, lockedPerPlayer.toString()],
      );
      await client.query(
        `UPDATE balances SET available = available + $2, locked = locked - $2, updated_at = NOW() WHERE address = $1`,
        [player_b, lockedPerPlayer.toString()],
      );

      await client.query(
        `UPDATE game_wagers SET status = 'cancelled', settled_at = NOW() WHERE game_id = $1`,
        [gameId],
      );

      // Ledger entries
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'wager_cancel', $3, 'Game cancelled, funds returned')`,
        [player_a, lockedPerPlayer.toString(), gameId],
      );
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'wager_cancel', $3, 'Game cancelled, funds returned')`,
        [player_b, lockedPerPlayer.toString(), gameId],
      );

      await client.query("COMMIT");
      logger.info("Funds cancelled", { gameId });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to cancel funds", { gameId, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }

  async offerDouble(gameId: string, doubler: string, newCubeValue: number): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const wagerResult = await client.query(
        `SELECT player_a, player_b, wager_amount, cube_value FROM game_wagers WHERE game_id = $1 AND status = 'active' FOR UPDATE`,
        [gameId],
      );
      if (wagerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const { player_a, player_b, wager_amount, cube_value } = wagerResult.rows[0];
      const additionalLockPerPlayer = BigInt(wager_amount) * BigInt(newCubeValue - cube_value);

      // Lock additional funds from both players
      const balA = await client.query(
        `SELECT available FROM balances WHERE address = $1 FOR UPDATE`,
        [player_a],
      );
      const balB = await client.query(
        `SELECT available FROM balances WHERE address = $1 FOR UPDATE`,
        [player_b],
      );

      if (balA.rows.length === 0 || balB.rows.length === 0 ||
          BigInt(balA.rows[0].available) < additionalLockPerPlayer ||
          BigInt(balB.rows[0].available) < additionalLockPerPlayer) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
        `UPDATE balances SET available = available - $2, locked = locked + $2, updated_at = NOW() WHERE address = $1`,
        [player_a, additionalLockPerPlayer.toString()],
      );
      await client.query(
        `UPDATE balances SET available = available - $2, locked = locked + $2, updated_at = NOW() WHERE address = $1`,
        [player_b, additionalLockPerPlayer.toString()],
      );

      await client.query(
        `UPDATE game_wagers SET cube_value = $2, status = 'active' WHERE game_id = $1`,
        [gameId, newCubeValue],
      );

      // Ledger entries
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'double_lock', $3, $4)`,
        [player_a, (-additionalLockPerPlayer).toString(), gameId, `Double to cube ${newCubeValue}`],
      );
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'double_lock', $3, $4)`,
        [player_b, (-additionalLockPerPlayer).toString(), gameId, `Double to cube ${newCubeValue}`],
      );

      await client.query("COMMIT");
      logger.info("Double offered, funds locked", { gameId, doubler, newCubeValue });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to offer double", { gameId, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }

  async verifyDoubleDeposit(_gameId: string): Promise<{
    doublerDeposited: boolean;
    responderDeposited: boolean;
    bothDeposited: boolean;
  } | null> {
    // In custodial mode, double deposits are instant (locked in offerDouble).
    // No async deposit verification needed.
    return { doublerDeposited: true, responderDeposited: true, bothDeposited: true };
  }

  async rejectDouble(gameId: string, rejecter: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const wagerResult = await client.query(
        `SELECT player_a, player_b, wager_amount, cube_value FROM game_wagers WHERE game_id = $1 AND status = 'active' FOR UPDATE`,
        [gameId],
      );
      if (wagerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }

      const { player_a, player_b, wager_amount, cube_value } = wagerResult.rows[0];
      const winner = rejecter === player_a ? player_b : player_a;
      const totalPot = BigInt(wager_amount) * BigInt(cube_value) * 2n;
      const rake = (totalPot * BigInt(RAKE_BPS)) / 10000n;
      const payout = totalPot - rake;
      const lockedPerPlayer = BigInt(wager_amount) * BigInt(cube_value);

      // Release locked funds
      await client.query(
        `UPDATE balances SET locked = locked - $2, updated_at = NOW() WHERE address = $1`,
        [player_a, lockedPerPlayer.toString()],
      );
      await client.query(
        `UPDATE balances SET locked = locked - $2, updated_at = NOW() WHERE address = $1`,
        [player_b, lockedPerPlayer.toString()],
      );

      // Pay winner
      await client.query(
        `UPDATE balances SET available = available + $2, updated_at = NOW() WHERE address = $1`,
        [winner, payout.toString()],
      );

      await client.query(
        `UPDATE game_wagers SET status = 'forfeited', settled_at = NOW() WHERE game_id = $1`,
        [gameId],
      );

      // Ledger
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'double_reject', $3, 'Won by double rejection')`,
        [winner, payout.toString(), gameId],
      );
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, game_id, description) VALUES ($1, $2, 'double_reject', $3, 'Lost by double rejection')`,
        [rejecter, 0, gameId],
      );

      await client.query("COMMIT");
      logger.info("Double rejected, funds settled", { gameId, rejecter, winner });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to reject double", { gameId, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }

  async getBalance(address: string): Promise<string> {
    const pool = getPool();
    if (!pool) return "0";

    try {
      const result = await pool.query(
        `SELECT available FROM balances WHERE address = $1`,
        [address],
      );
      return result.rows.length > 0 ? String(result.rows[0].available) : "0";
    } catch (err) {
      logger.error("Failed to get balance", { address, error: String(err) });
      return "0";
    }
  }

  /** Credit a player's balance (for deposits) */
  async creditBalance(address: string, amount: bigint, description: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Upsert balance
      await client.query(
        `INSERT INTO balances (address, available) VALUES ($1, $2)
         ON CONFLICT (address) DO UPDATE SET available = balances.available + $2, updated_at = NOW()`,
        [address, amount.toString()],
      );

      // Ledger entry
      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, description) VALUES ($1, $2, 'deposit', $3)`,
        [address, amount.toString(), description],
      );

      await client.query("COMMIT");
      logger.info("Balance credited", { address, amount: amount.toString() });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to credit balance", { address, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }

  /** Debit a player's balance (for withdrawals) */
  async debitBalance(address: string, amount: bigint, description: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT available FROM balances WHERE address = $1 FOR UPDATE`,
        [address],
      );
      if (result.rows.length === 0 || BigInt(result.rows[0].available) < amount) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
        `UPDATE balances SET available = available - $2, updated_at = NOW() WHERE address = $1`,
        [address, amount.toString()],
      );

      await client.query(
        `INSERT INTO balance_ledger (address, amount, type, description) VALUES ($1, $2, 'withdrawal', $3)`,
        [address, (-amount).toString(), description],
      );

      await client.query("COMMIT");
      logger.info("Balance debited", { address, amount: amount.toString() });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Failed to debit balance", { address, error: String(err) });
      return false;
    } finally {
      client.release();
    }
  }
}
