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

      CREATE TABLE IF NOT EXISTS player_profiles (
        address TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        username TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS player_ratings (
        address TEXT PRIMARY KEY,
        rating INTEGER NOT NULL DEFAULT 1500,
        rating_change INTEGER NOT NULL DEFAULT 0,
        total_games INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS player_stats (
        address TEXT PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        current_streak INTEGER NOT NULL DEFAULT 0,
        current_streak_type TEXT NOT NULL DEFAULT '',
        best_streak INTEGER NOT NULL DEFAULT 0,
        total_gammons INTEGER NOT NULL DEFAULT 0,
        total_backgammons INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS match_results (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        game_id TEXT NOT NULL,
        opponent TEXT NOT NULL,
        opponent_name TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL,
        result_type TEXT NOT NULL DEFAULT 'normal',
        wager_amount INTEGER NOT NULL DEFAULT 0,
        rating_change INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS friendships (
        player_a TEXT NOT NULL,
        player_b TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (player_a, player_b)
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (from_address, to_address)
      );

      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entry_fee INTEGER NOT NULL DEFAULT 0,
        max_players INTEGER NOT NULL DEFAULT 8,
        status TEXT NOT NULL DEFAULT 'registration',
        bracket JSONB,
        current_round INTEGER NOT NULL DEFAULT 0,
        total_rounds INTEGER NOT NULL DEFAULT 0,
        winner TEXT,
        prize_pool INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        start_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS tournament_players (
        tournament_id TEXT NOT NULL REFERENCES tournaments(id),
        address TEXT NOT NULL,
        seed INTEGER,
        eliminated_round INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tournament_id, address)
      );

      CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
      CREATE INDEX IF NOT EXISTS idx_tournament_players_address ON tournament_players(address);
      CREATE INDEX IF NOT EXISTS idx_match_results_address ON match_results(address);
      CREATE INDEX IF NOT EXISTS idx_match_results_created ON match_results(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(player_b);
      CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_address);
      CREATE INDEX IF NOT EXISTS idx_player_profiles_username ON player_profiles(username);
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
