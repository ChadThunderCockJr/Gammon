import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSensitiveJson, type EncryptedPayload } from "../finance-crypto.js";
import { backfillLegacyReportNarratives } from "../legacy-report-narrative-backfill.js";

const dataKey = Buffer.alloc(32, 7).toString("base64");
const savedEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  FINANCE_DATA_KEY_ID: process.env.FINANCE_DATA_KEY_ID,
  FINANCE_DATA_KEYS: process.env.FINANCE_DATA_KEYS,
  FINANCE_DATA_KEY: process.env.FINANCE_DATA_KEY,
};

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function configuredKey(): void {
  process.env.NODE_ENV = "test";
  process.env.FINANCE_DATA_KEY_ID = "migration-key-v1";
  process.env.FINANCE_DATA_KEYS = JSON.stringify({ "migration-key-v1": dataKey });
  delete process.env.FINANCE_DATA_KEY;
}

function legacyClient(rows: Array<{
  id: string;
  description: string;
  descriptionEncrypted: EncryptedPayload | null;
}>): PoolClient {
  return {
    query: async (text: string, values?: readonly unknown[]) => {
      if (text.startsWith("LOCK TABLE")) return { rows: [], rowCount: null };
      if (text.includes("information_schema.columns")) return { rows: [{ exists: true }], rowCount: 1 };
      if (text.includes("SELECT id, description")) return { rows, rowCount: rows.length };
      if (text.includes("SET description_encrypted")) {
        const report = rows.find((row) => row.id === values?.[0]);
        if (!report) throw new Error("missing report");
        report.descriptionEncrypted = values?.[1] as EncryptedPayload;
        return { rows: [{ descriptionEncrypted: report.descriptionEncrypted }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  } as unknown as PoolClient;
}

afterEach(restoreEnvironment);

describe("legacy report narrative backfill", () => {
  it("encrypts and decrypt-verifies nonempty and empty legacy narratives using report-id AAD", async () => {
    configuredKey();
    const reports = [
      { id: "report-nonempty", description: "exact moderator-visible text", descriptionEncrypted: null },
      { id: "report-empty", description: "", descriptionEncrypted: null },
    ];

    await expect(backfillLegacyReportNarratives(legacyClient(reports))).resolves.toBe("backfilled");

    for (const report of reports) {
      expect(report.descriptionEncrypted).not.toBeNull();
      expect(decryptSensitiveJson<{ description: string }>(report.descriptionEncrypted!, report.id)).toEqual({
        description: report.description,
      });
    }
  });

  it("aborts before writing a legacy narrative when its configured data key is unavailable", async () => {
    process.env.NODE_ENV = "production";
    process.env.FINANCE_DATA_KEY_ID = "missing-migration-key";
    delete process.env.FINANCE_DATA_KEYS;
    delete process.env.FINANCE_DATA_KEY;
    const reports = [{ id: "report-key-missing", description: "must not be dropped", descriptionEncrypted: null }];

    await expect(backfillLegacyReportNarratives(legacyClient(reports))).rejects.toThrow(
      "Finance data key is unavailable for key id missing-migration-key",
    );
    expect(reports[0].descriptionEncrypted).toBeNull();
  });

  it("aborts when an existing ciphertext cannot be verified against the plaintext source", async () => {
    configuredKey();
    const reports = [{
      id: "report-corrupt",
      description: "original text",
      descriptionEncrypted: {
        version: 1,
        algorithm: "aes-256-gcm",
        keyId: "migration-key-v1",
        iv: Buffer.alloc(12).toString("base64"),
        ciphertext: "not-ciphertext",
        tag: Buffer.alloc(16).toString("base64"),
      } as EncryptedPayload,
    }];

    await expect(backfillLegacyReportNarratives(legacyClient(reports))).rejects.toThrow();
  });

  it("records backup restoration as the only reconciliation outcome after destructive v20", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.startsWith("LOCK TABLE")) return { rows: [], rowCount: null };
        if (text.includes("information_schema.columns")) return { rows: [{ exists: false }], rowCount: 1 };
        if (text.includes("user_report_narrative_reconciliations")) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected query: ${text}`);
      },
    } as unknown as PoolClient;

    await expect(backfillLegacyReportNarratives(client)).resolves.toBe("backup_restore_required");
    expect(queries.some((query) => query.includes("backup_restore_required"))).toBe(true);
  });
});
