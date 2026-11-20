import pg from "pg";
import { LATEST_DATABASE_VERSION } from "./migrations.js";
import { logger } from "./logger.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface DatabaseStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly migrated: boolean;
  readonly version: number | null;
  readonly errorCode: "not_configured" | "unreachable" | "migration_required" | null;
}

export function getPool(): pg.Pool | null {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "gammon-server",
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : undefined,
  });
  pool.on("error", (error) => {
    logger.error("PostgreSQL pool error", { errorCode: "code" in error ? String(error.code) : "unknown" });
  });
  return pool;
}

/** Connectivity and migration readiness only. Schema changes run via src/migrate.ts. */
export async function checkDatabase(): Promise<DatabaseStatus> {
  const database = getPool();
  if (!database) {
    return { configured: false, connected: false, migrated: false, version: null, errorCode: "not_configured" };
  }

  try {
    await database.query("SELECT 1");
    const result = await database.query<{ version: number }>(
      "SELECT MAX(version)::int AS version FROM schema_migrations",
    );
    const version = result.rows[0]?.version ?? 0;
    return {
      configured: true,
      connected: true,
      migrated: version === LATEST_DATABASE_VERSION,
      version,
      errorCode: version === LATEST_DATABASE_VERSION ? null : "migration_required",
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    logger.warn("PostgreSQL readiness check failed", { errorCode: code });
    return { configured: true, connected: false, migrated: false, version: null, errorCode: "unreachable" };
  }
}

export async function initDatabase(): Promise<boolean> {
  const status = await checkDatabase();
  return status.connected && status.migrated;
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
