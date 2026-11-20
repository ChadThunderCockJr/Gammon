import "dotenv/config";
import { closeDatabase, getPool } from "./db.js";
import { runMigrations } from "./migrations.js";

const MIGRATION_LOCK_NAMESPACE = 0x47414d4d;
const MIGRATION_LOCK_ID = 0x4d494752;

const pool = getPool();
if (!pool) throw new Error("DATABASE_URL is required to run migrations");

try {
  const migrationLock = await pool.connect();
  let lockAcquired = false;

  try {
    process.stdout.write("Waiting for database migration lock\n");
    await migrationLock.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    lockAcquired = true;

    await runMigrations(pool);
    process.stdout.write("Database migrations applied\n");
  } finally {
    try {
      if (lockAcquired) {
        await migrationLock.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_ID,
        ]);
      }
    } finally {
      migrationLock.release();
    }
  }
} finally {
  await closeDatabase();
}
