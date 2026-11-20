import type { PoolClient } from "pg";
import {
  decryptSensitiveJson,
  encryptSensitiveJson,
  type EncryptedPayload,
} from "./finance-crypto.js";

export type LegacyReportNarrativeBackfillOutcome = "backfilled" | "backup_restore_required";

interface LegacyReportNarrativeRow {
  readonly id: string;
  readonly description: string;
  readonly descriptionEncrypted: EncryptedPayload | null;
}

function verifiedDescription(payload: EncryptedPayload, reportId: string): string {
  const decrypted = decryptSensitiveJson<{ description: unknown }>(payload, reportId);
  if (typeof decrypted.description !== "string") {
    throw new Error("REPORT_NARRATIVE_BACKFILL_VERIFICATION_FAILED");
  }
  return decrypted.description;
}

async function legacyDescriptionColumnExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'user_reports'
          AND column_name = 'description'
     ) AS exists`,
  );
  return result.rows[0]?.exists === true;
}

/**
 * Runs within the migration transaction after description_encrypted and the
 * reconciliation table have been prepared. A missing legacy column means a
 * pre-fix v20 already destroyed the plaintext and can only be reconciled from
 * backup; this function never fabricates a narrative.
 */
export async function backfillLegacyReportNarratives(
  client: PoolClient,
): Promise<LegacyReportNarrativeBackfillOutcome> {
  await client.query("LOCK TABLE user_reports IN ACCESS EXCLUSIVE MODE");

  if (!await legacyDescriptionColumnExists(client)) {
    await client.query(
      `INSERT INTO user_report_narrative_reconciliations (report_id, outcome)
       SELECT id, 'backup_restore_required'
         FROM user_reports
        WHERE description_encrypted IS NULL
       ON CONFLICT (report_id) DO NOTHING`,
    );
    return "backup_restore_required";
  }

  const reports = await client.query<LegacyReportNarrativeRow>(
    `SELECT id, description, description_encrypted AS "descriptionEncrypted"
       FROM user_reports
      ORDER BY id
      FOR UPDATE`,
  );

  for (const report of reports.rows) {
    let payload = report.descriptionEncrypted;
    if (!payload) {
      const encrypted = encryptSensitiveJson({ description: report.description }, report.id);
      const updated = await client.query<{ descriptionEncrypted: EncryptedPayload }>(
        `UPDATE user_reports
            SET description_encrypted = $2
          WHERE id = $1
            AND description_encrypted IS NULL
        RETURNING description_encrypted AS "descriptionEncrypted"`,
        [report.id, encrypted],
      );
      payload = updated.rows[0]?.descriptionEncrypted;
      if (!payload) throw new Error("REPORT_NARRATIVE_BACKFILL_WRITE_FAILED");
    }

    if (verifiedDescription(payload, report.id) !== report.description) {
      throw new Error("REPORT_NARRATIVE_BACKFILL_VERIFICATION_FAILED");
    }
  }

  return "backfilled";
}
