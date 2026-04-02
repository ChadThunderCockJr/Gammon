import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.warn("DATABASE_URL not set — PostgreSQL disabled, falling back to Redis-only persistence");
    return null;
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err) => {
    logger.error("PostgreSQL pool error", { error: String(err) });
  });

  return pool;
}

/** Run the schema migration on startup */
export async function initDatabase(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;

  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        player_white TEXT,
        player_black TEXT,
        wager_amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'waiting',
        escrow_status TEXT NOT NULL DEFAULT 'none',
        game_state JSONB,
        turn_time_limit INTEGER NOT NULL DEFAULT 60,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS moves (
        id SERIAL PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        turn_number INTEGER NOT NULL,
        player TEXT NOT NULL,
        move_from INTEGER NOT NULL,
        move_to INTEGER NOT NULL,
        game_state_after JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dice_rolls (
        id SERIAL PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id),
        turn_number INTEGER NOT NULL,
        player TEXT NOT NULL,
        die1 INTEGER NOT NULL,
        die2 INTEGER NOT NULL,
        drand_round INTEGER,
        drand_randomness TEXT,
        drand_signature TEXT,
        drand_failed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS balances (
        address TEXT PRIMARY KEY,
        available BIGINT NOT NULL DEFAULT 0,
        locked BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS balance_ledger (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        amount BIGINT NOT NULL,
        type TEXT NOT NULL,
        game_id TEXT,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS game_wagers (
        game_id TEXT PRIMARY KEY,
        player_a TEXT NOT NULL,
        player_b TEXT NOT NULL,
        wager_amount BIGINT NOT NULL,
        cube_value INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_moves_game_id ON moves(game_id);
      CREATE INDEX IF NOT EXISTS idx_dice_rolls_game_id ON dice_rolls(game_id);
      CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
      CREATE INDEX IF NOT EXISTS idx_games_player_white ON games(player_white);
      CREATE INDEX IF NOT EXISTS idx_games_player_black ON games(player_black);
      CREATE INDEX IF NOT EXISTS idx_balance_ledger_address ON balance_ledger(address);
      CREATE INDEX IF NOT EXISTS idx_balance_ledger_game_id ON balance_ledger(game_id);
      CREATE INDEX IF NOT EXISTS idx_game_wagers_status ON game_wagers(status);
    `);

    logger.info("PostgreSQL schema initialized");
    return true;
  } catch (err) {
    logger.error("Failed to initialize PostgreSQL schema", { error: String(err) });
    return false;
  }
}

/** Graceful shutdown */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
