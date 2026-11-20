import { createHash, randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getPool } from "./db.js";

export const SUPPORT_CATEGORIES = [
  "payment",
  "missing_deposit",
  "returned_payment",
  "failed_cash_out",
  "incorrect_settlement",
  "account_access",
  "location_error",
  "responsible_play",
] as const;

export type SupportCategory = typeof SUPPORT_CATEGORIES[number];

export interface SupportCaseView {
  readonly id: string;
  readonly category: SupportCategory;
  readonly state: "open" | "investigating" | "resolved" | "closed";
  readonly reference: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function accessTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSupportCase(input: {
  principal: string | null;
  category: SupportCategory;
  description: string;
  contactEmail: string | null;
  reference: string | null;
}): Promise<{ supportCase: SupportCaseView; accessToken: string }> {
  const pool = getPool();
  if (!pool) throw new Error("SUPPORT_STORE_UNAVAILABLE");
  const id = `case_${uuid()}`;
  const accessToken = randomBytes(32).toString("base64url");
  const result = await pool.query(
    `INSERT INTO support_cases
      (id, principal, category, state, description, contact_email, reference, access_token_hash)
     VALUES ($1, $2, $3, 'open', $4, $5, $6, $7)
     RETURNING id, category, state, reference, created_at, updated_at`,
    [id, input.principal, input.category, input.description, input.contactEmail, input.reference, accessTokenHash(accessToken)],
  );
  const row = result.rows[0];
  return {
    supportCase: {
      id: row.id,
      category: row.category,
      state: row.state,
      reference: row.reference,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    },
    accessToken,
  };
}

export async function getSupportCase(
  id: string,
  principal: string | null,
  accessToken: string | null,
): Promise<SupportCaseView | null> {
  const pool = getPool();
  if (!pool) throw new Error("SUPPORT_STORE_UNAVAILABLE");
  const tokenHash = accessToken ? accessTokenHash(accessToken) : null;
  const result = await pool.query(
    `SELECT id, category, state, reference, created_at, updated_at
       FROM support_cases
      WHERE id = $1
        AND (($2::text IS NOT NULL AND principal = $2) OR ($3::text IS NOT NULL AND access_token_hash = $3))`,
    [id, principal, tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    state: row.state,
    reference: row.reference,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listSupportCases(principal: string): Promise<SupportCaseView[]> {
  const pool = getPool();
  if (!pool) throw new Error("SUPPORT_STORE_UNAVAILABLE");
  const result = await pool.query(
    `SELECT id, category, state, reference, created_at, updated_at
       FROM support_cases
      WHERE principal = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [principal],
  );
  return result.rows.map((row) => ({
    id: row.id,
    category: row.category,
    state: row.state,
    reference: row.reference,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}
