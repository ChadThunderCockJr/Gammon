import type pg from "pg";
import { getPool } from "./db.js";
import { fundsGate, type FundsAction } from "./funds-config.js";

export interface PolicyDecisionContext {
  readonly action: FundsAction;
  readonly decisionId: string;
  readonly decision: "allow" | "deny" | "review";
  readonly policyVersion: string;
  readonly jurisdiction: string | null;
  readonly evidenceExpiresAt: string | null;
  readonly reasonCodes: readonly string[];
}

export interface ActionDecision {
  readonly allowed: boolean;
  readonly reasonCodes: readonly string[];
  readonly decisionId: string | null;
  readonly policyDecision: PolicyDecisionContext | null;
}

export interface PlayRestrictions {
  readonly selfExcludedUntil: string | null;
  readonly coolingOffUntil: string | null;
  readonly depositLimitMicroUsd: string | null;
  readonly wagerLimitMicroUsd: string | null;
  readonly dailyWagerLimitMicroUsd: string | null;
  readonly dailyLossLimitMicroUsd: string | null;
  readonly pendingIncrease: Record<string, unknown> | null;
  readonly activity24h: {
    readonly depositsMicroUsd: string;
    readonly wagerCommitmentsMicroUsd: string;
    readonly realizedLossesMicroUsd: string;
  };
}

interface RestrictionRow {
  readonly self_excluded_until: Date | null;
  readonly cooling_off_until: Date | null;
  readonly deposit_limit_micro_usd: string | null;
  readonly wager_limit_micro_usd: string | null;
  readonly daily_wager_limit_micro_usd: string | null;
  readonly daily_loss_limit_micro_usd: string | null;
  readonly pending_increase?: Record<string, unknown> | null;
}

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export class FundsActionDeniedError extends Error {
  readonly reasonCodes = Object.freeze(["action_not_allowed"]);

  constructor(readonly internalReasonCodes: readonly string[]) {
    super("FUNDS_ACTION_NOT_ALLOWED");
    this.name = "FundsActionDeniedError";
  }
}

interface EligibilityDecisionRow {
  readonly id: string;
  readonly decision: "allow" | "deny" | "review";
  readonly policy_version: string;
  readonly jurisdiction: string | null;
  readonly evidence_expires_at: Date | null;
  readonly reason_codes: string[];
}

const REQUIRED_ENTRY_EVIDENCE: Readonly<Record<string, string>> = {
  eligibility_evidence_signed: "eligibility_evidence_unsigned",
  geolocation_evidence_signed: "geolocation_evidence_unsigned",
};

const RECOVERY_HOLD_CODES: Readonly<Record<string, true>> = {
  sanctions: true,
  sanctions_hold: true,
  fraud: true,
  fraud_hold: true,
  legal_hold: true,
};

const ENTRY_ACTIONS: Readonly<Record<"provider_account_create" | "link_bank" | "deposit" | "wager", true>> = {
  provider_account_create: true,
  link_bank: true,
  deposit: true,
  wager: true,
};

function immutableActionDecision(
  action: FundsAction,
  reasons: readonly string[],
  decision?: EligibilityDecisionRow,
): ActionDecision {
  const reasonCodes = Object.freeze([...new Set(reasons)]);
  const policyDecision = decision
    ? Object.freeze({
      action,
      decisionId: decision.id,
      decision: decision.decision,
      policyVersion: decision.policy_version,
      jurisdiction: decision.jurisdiction,
      evidenceExpiresAt: decision.evidence_expires_at?.toISOString() ?? null,
      reasonCodes: Object.freeze([...decision.reason_codes]),
    })
    : null;
  return Object.freeze({
    allowed: reasonCodes.length === 0,
    reasonCodes,
    decisionId: decision?.id ?? null,
    policyDecision,
  });
}

function gateBlockedDecision(decision: ActionDecision, gateBlockers: readonly string[]): ActionDecision {
  if (gateBlockers.length === 0) return decision;
  return Object.freeze({
    ...decision,
    allowed: false,
    reasonCodes: Object.freeze([...new Set([...gateBlockers, ...decision.reasonCodes])]),
  });
}


async function storedDecision(
  database: Queryable,
  principal: string,
  action: FundsAction,
  amountMicroUsd: bigint | undefined,
  current: RestrictionRow | undefined,
  lockEligibility: boolean,
  excludedQuoteId?: string,
): Promise<ActionDecision> {
  const exposureIncreasing = Object.hasOwn(ENTRY_ACTIONS, action);
  const reasons: string[] = [];
  if (exposureIncreasing && current?.self_excluded_until && current.self_excluded_until.getTime() > Date.now()) {
    reasons.push("self_excluded");
  }
  if (exposureIncreasing && current?.cooling_off_until && current.cooling_off_until.getTime() > Date.now()) {
    reasons.push("cooling_off");
  }

  if (amountMicroUsd !== undefined && action === "deposit" && current?.deposit_limit_micro_usd) {
    const usage = await database.query<{ used: string }>(
      `SELECT COALESCE(SUM(amount_micro_usd), 0)::text AS used
         FROM money_operations
        WHERE principal = $1 AND kind = 'deposit'
          AND state IN ('queued', 'processing', 'pending', 'complete')
          AND created_at >= NOW() - INTERVAL '24 hours'`,
      [principal],
    );
    if (BigInt(usage.rows[0]?.used ?? "0") + amountMicroUsd > BigInt(current.deposit_limit_micro_usd)) {
      reasons.push("deposit_limit_reached");
    }
  }
  if (amountMicroUsd !== undefined && action === "wager") {
    if (current?.wager_limit_micro_usd && amountMicroUsd > BigInt(current.wager_limit_micro_usd)) {
      reasons.push("wager_limit_reached");
    }
    if (current?.daily_wager_limit_micro_usd) {
      const usage = await database.query<{ used: string }>(
        `SELECT COALESCE(SUM(quote.reserve_per_player_micro_usd), 0)::text AS used
           FROM cash_game_acceptances acceptance
           JOIN cash_game_quotes quote ON quote.id = acceptance.quote_id
          WHERE acceptance.principal = $1
            AND acceptance.accepted_at >= NOW() - INTERVAL '24 hours'
            AND acceptance.quote_id <> COALESCE($2, '')`,
        [principal, excludedQuoteId ?? null],
      );
      if (BigInt(usage.rows[0]?.used ?? "0") + amountMicroUsd > BigInt(current.daily_wager_limit_micro_usd)) {
        reasons.push("daily_wager_limit_reached");
      }
    }
    if (current?.daily_loss_limit_micro_usd) {
      const losses = await database.query<{ used: string }>(
        `SELECT COALESCE(SUM(operation.amount_micro_usd), 0)::text AS used
           FROM money_operations operation
           JOIN cash_game_quotes quote ON quote.id = operation.quote_snapshot->>'quoteId'
          WHERE operation.kind = 'wager_settlement'
            AND operation.state = 'complete'
            AND operation.created_at >= NOW() - INTERVAL '24 hours'
            AND operation.principal <> $1
            AND $1 IN (quote.player_a, quote.player_b)`,
        [principal],
      );
      if (BigInt(losses.rows[0]?.used ?? "0") + amountMicroUsd > BigInt(current.daily_loss_limit_micro_usd)) {
        reasons.push("daily_loss_limit_reached");
      }
    }
  }

  if (fundsGate.config.mode !== "verusd_production") {
    return immutableActionDecision(action, reasons);
  }

  if (!exposureIncreasing && action !== "cash_out" && action !== "settle" && action !== "refund") {
    return immutableActionDecision(action, reasons);
  }

  const result = await database.query<EligibilityDecisionRow>(
    `SELECT id, decision, policy_version, jurisdiction, evidence_expires_at, reason_codes
       FROM eligibility_decisions
      WHERE principal = $1 AND action = $2
      ORDER BY created_at DESC LIMIT 1${lockEligibility ? " FOR SHARE" : ""}`,
    [principal, action],
  );
  const decision = result.rows[0];

  if (exposureIncreasing) {
    const policyVersion = process.env.ELIGIBILITY_POLICY_VERSION ?? "";
    const now = Date.now();
    if (!decision) reasons.push("eligibility_missing");
    else {
      if (decision.decision !== "allow") reasons.push(...decision.reason_codes, `eligibility_${decision.decision}`);
      if (decision.policy_version !== policyVersion) reasons.push("eligibility_policy_stale");
      if (!decision.evidence_expires_at || decision.evidence_expires_at.getTime() <= now) {
        reasons.push("eligibility_expired");
      }
      for (const [evidenceCode, missingReason] of Object.entries(REQUIRED_ENTRY_EVIDENCE)) {
        if (!decision.reason_codes.includes(evidenceCode)) reasons.push(missingReason);
      }
      const providerScope = fundsGate.config.accountId ? `provider_account:${fundsGate.config.accountId}` : null;
      if (!providerScope || !decision.reason_codes.includes(providerScope)) {
        reasons.push("eligibility_evidence_not_provider_scoped");
      }
    }
  } else if (decision && decision.decision !== "allow" && decision.reason_codes.some((code) => RECOVERY_HOLD_CODES[code] === true)) {
    reasons.push(...decision.reason_codes, `eligibility_${decision.decision}`);
  }
  return immutableActionDecision(action, reasons, decision);
}

async function applyMaturedLimit(database: Queryable, principal: string): Promise<void> {
  await database.query(
    `UPDATE play_restrictions SET
       deposit_limit_micro_usd = CASE WHEN pending_increase->>'type' = 'deposit_limit' THEN (pending_increase->>'amountMicroUsd')::bigint ELSE deposit_limit_micro_usd END,
       wager_limit_micro_usd = CASE WHEN pending_increase->>'type' = 'wager_limit' THEN (pending_increase->>'amountMicroUsd')::bigint ELSE wager_limit_micro_usd END,
       daily_wager_limit_micro_usd = CASE WHEN pending_increase->>'type' = 'daily_wager_limit' THEN (pending_increase->>'amountMicroUsd')::bigint ELSE daily_wager_limit_micro_usd END,
       daily_loss_limit_micro_usd = CASE WHEN pending_increase->>'type' = 'daily_loss_limit' THEN (pending_increase->>'amountMicroUsd')::bigint ELSE daily_loss_limit_micro_usd END,
       pending_increase = NULL, updated_at = NOW()
     WHERE principal = $1
       AND pending_increase IS NOT NULL
       AND (pending_increase->>'effectiveAt')::timestamptz <= NOW()`,
    [principal],
  );
}

export async function evaluateFundsAction(
  principal: string,
  action: FundsAction,
  amountMicroUsd?: bigint,
): Promise<ActionDecision> {
  const gateBlockers = fundsGate.blockersFor(action);
  if (gateBlockers.length > 0) return immutableActionDecision(action, gateBlockers);
  const pool = getPool();
  if (!pool) return immutableActionDecision(action, ["policy_store_unavailable"]);
  let current: RestrictionRow | undefined;
  if (Object.hasOwn(ENTRY_ACTIONS, action)) {
    await applyMaturedLimit(pool, principal);
    const restrictions = await pool.query<RestrictionRow>(
      `SELECT self_excluded_until, cooling_off_until, deposit_limit_micro_usd, wager_limit_micro_usd,
              daily_wager_limit_micro_usd, daily_loss_limit_micro_usd, pending_increase
         FROM play_restrictions WHERE principal = $1`,
      [principal],
    );
    current = restrictions.rows[0];
  }
  return storedDecision(pool, principal, action, amountMicroUsd, current, false);
}

/**
 * Serializes a money-moving entry decision on the principal's policy row.
 * The caller must commit the authorized money intent in the same transaction.
 */
export async function lockFundsAction(
  client: pg.PoolClient,
  principal: string,
  action: "deposit" | "wager",
  amountMicroUsd: bigint,
  options: { readonly excludedQuoteId?: string } = {},
): Promise<ActionDecision> {
  const gateBlockers = fundsGate.blockersFor(action);
  await client.query(
    "INSERT INTO play_restrictions (principal) VALUES ($1) ON CONFLICT (principal) DO NOTHING",
    [principal],
  );
  await applyMaturedLimit(client, principal);
  const restrictions = await client.query<RestrictionRow>(
    `SELECT self_excluded_until, cooling_off_until, deposit_limit_micro_usd, wager_limit_micro_usd,
            daily_wager_limit_micro_usd, daily_loss_limit_micro_usd, pending_increase
       FROM play_restrictions WHERE principal = $1 FOR UPDATE`,
    [principal],
  );
  return gateBlockedDecision(
    await storedDecision(client, principal, action, amountMicroUsd, restrictions.rows[0], true, options.excludedQuoteId),
    gateBlockers,
  );
}

/**
 * Serializes provider-account and bank-link entry eligibility with the money intent
 * transaction, so a stale preflight cannot create external provider exposure.
 */
export async function lockProviderEntryAction(
  client: pg.PoolClient,
  principal: string,
  action: "provider_account_create" | "link_bank",
): Promise<ActionDecision> {
  const gateBlockers = fundsGate.blockersFor(action);
  if (gateBlockers.length > 0) return immutableActionDecision(action, gateBlockers);
  await client.query(
    "INSERT INTO play_restrictions (principal) VALUES ($1) ON CONFLICT (principal) DO NOTHING",
    [principal],
  );
  const restrictions = await client.query<RestrictionRow>(
    `SELECT self_excluded_until, cooling_off_until, deposit_limit_micro_usd, wager_limit_micro_usd,
            daily_wager_limit_micro_usd, daily_loss_limit_micro_usd, pending_increase
       FROM play_restrictions WHERE principal = $1 FOR UPDATE`,
    [principal],
  );
  return storedDecision(client, principal, action, undefined, restrictions.rows[0], true);
}
/**
 * Serializes recovery eligibility. Recovery policies normally permit progress,
 * except immutable legal/fraud holds that must stop custody movement.
 */
export async function lockRecoveryAction(
  client: pg.PoolClient,
  principal: string,
  action: "cash_out" | "settle" | "refund",
): Promise<ActionDecision> {
  const gateBlockers = fundsGate.blockersFor(action);
  await client.query(
    "INSERT INTO play_restrictions (principal) VALUES ($1) ON CONFLICT (principal) DO NOTHING",
    [principal],
  );
  const restrictions = await client.query<RestrictionRow>(
    `SELECT self_excluded_until, cooling_off_until, deposit_limit_micro_usd, wager_limit_micro_usd,
            daily_wager_limit_micro_usd, daily_loss_limit_micro_usd, pending_increase
       FROM play_restrictions WHERE principal = $1 FOR UPDATE`,
    [principal],
  );
  return gateBlockedDecision(
    await storedDecision(client, principal, action, undefined, restrictions.rows[0], true),
    gateBlockers,
  );
}

export interface PrincipalPolicyDecision {
  readonly principal: string;
  readonly decision: ActionDecision;
}

/**
 * Locks each distinct policy row in stable order.  Callers which create a
 * shared exposure must use this instead of independently locking participants,
 * otherwise opposing transactions can deadlock or observe incompatible limits.
 */
export async function lockWagerParticipants(
  client: pg.PoolClient,
  principals: readonly string[],
  amountMicroUsd: bigint,
  excludedQuoteId: string,
): Promise<readonly PrincipalPolicyDecision[]> {
  const decisions: PrincipalPolicyDecision[] = [];
  for (const principal of [...new Set(principals)].sort()) {
    decisions.push(Object.freeze({
      principal,
      decision: await lockFundsAction(client, principal, "wager", amountMicroUsd, { excludedQuoteId }),
    }));
  }
  return Object.freeze(decisions);
}

/**
 * Locks every participant's recovery decision under the same stable ordering.
 * This makes a legal hold authoritative at the attempted custody transition.
 */
export async function lockRecoveryParticipants(
  client: pg.PoolClient,
  principals: readonly string[],
  action: "settle" | "refund",
): Promise<readonly PrincipalPolicyDecision[]> {
  const decisions: PrincipalPolicyDecision[] = [];
  for (const principal of [...new Set(principals)].sort()) {
    decisions.push(Object.freeze({
      principal,
      decision: await lockRecoveryAction(client, principal, action),
    }));
  }
  return Object.freeze(decisions);
}



export async function getPlayRestrictions(principal: string): Promise<PlayRestrictions> {
  const pool = getPool();
  if (!pool) throw new Error("Policy store unavailable");
  await applyMaturedLimit(pool, principal);
  const [result, deposits, wagerCommitments, realizedLosses] = await Promise.all([
    pool.query<RestrictionRow>("SELECT * FROM play_restrictions WHERE principal = $1", [principal]),
    pool.query<{ used: string }>(
      `SELECT COALESCE(SUM(amount_micro_usd), 0)::text AS used
         FROM money_operations
        WHERE principal = $1 AND kind = 'deposit'
          AND state IN ('queued', 'processing', 'pending', 'complete')
          AND created_at >= NOW() - INTERVAL '24 hours'`,
      [principal],
    ),
    pool.query<{ used: string }>(
      `SELECT COALESCE(SUM(quote.reserve_per_player_micro_usd), 0)::text AS used
         FROM cash_game_acceptances acceptance
         JOIN cash_game_quotes quote ON quote.id = acceptance.quote_id
        WHERE acceptance.principal = $1
          AND acceptance.accepted_at >= NOW() - INTERVAL '24 hours'`,
      [principal],
    ),
    pool.query<{ used: string }>(
      `SELECT COALESCE(SUM(operation.amount_micro_usd), 0)::text AS used
         FROM money_operations operation
         JOIN cash_game_quotes quote ON quote.id = operation.quote_snapshot->>'quoteId'
        WHERE operation.kind = 'wager_settlement'
          AND operation.state = 'complete'
          AND operation.created_at >= NOW() - INTERVAL '24 hours'
          AND operation.principal <> $1
          AND $1 IN (quote.player_a, quote.player_b)`,
      [principal],
    ),
  ]);
  const row = result.rows[0];
  const value = (field: keyof RestrictionRow): string | null => {
    const raw = row?.[field];
    return raw === null || raw === undefined || raw instanceof Date || typeof raw === "object" ? null : String(raw);
  };
  return {
    selfExcludedUntil: row?.self_excluded_until ? new Date(row.self_excluded_until).toISOString() : null,
    coolingOffUntil: row?.cooling_off_until ? new Date(row.cooling_off_until).toISOString() : null,
    depositLimitMicroUsd: value("deposit_limit_micro_usd"),
    wagerLimitMicroUsd: value("wager_limit_micro_usd"),
    dailyWagerLimitMicroUsd: value("daily_wager_limit_micro_usd"),
    dailyLossLimitMicroUsd: value("daily_loss_limit_micro_usd"),
    pendingIncrease: row?.pending_increase ?? null,
    activity24h: {
      depositsMicroUsd: deposits.rows[0]?.used ?? "0",
      wagerCommitmentsMicroUsd: wagerCommitments.rows[0]?.used ?? "0",
      realizedLossesMicroUsd: realizedLosses.rows[0]?.used ?? "0",
    },
  };
}

export async function applyImmediateRestriction(input: {
  principal: string;
  selfExcludedUntil?: Date;
  coolingOffUntil?: Date;
  depositLimitMicroUsd?: string;
  wagerLimitMicroUsd?: string;
  dailyWagerLimitMicroUsd?: string;
  dailyLossLimitMicroUsd?: string;
}): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error("Policy store unavailable");
  await pool.query(
    `INSERT INTO play_restrictions
      (principal, self_excluded_until, cooling_off_until, deposit_limit_micro_usd,
       wager_limit_micro_usd, daily_wager_limit_micro_usd, daily_loss_limit_micro_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (principal) DO UPDATE SET
       self_excluded_until = GREATEST(play_restrictions.self_excluded_until, EXCLUDED.self_excluded_until),
       cooling_off_until = GREATEST(play_restrictions.cooling_off_until, EXCLUDED.cooling_off_until),
       deposit_limit_micro_usd = CASE
         WHEN EXCLUDED.deposit_limit_micro_usd IS NULL THEN play_restrictions.deposit_limit_micro_usd
         WHEN play_restrictions.deposit_limit_micro_usd IS NULL THEN EXCLUDED.deposit_limit_micro_usd
         ELSE LEAST(play_restrictions.deposit_limit_micro_usd, EXCLUDED.deposit_limit_micro_usd)
       END,
       wager_limit_micro_usd = CASE
         WHEN EXCLUDED.wager_limit_micro_usd IS NULL THEN play_restrictions.wager_limit_micro_usd
         WHEN play_restrictions.wager_limit_micro_usd IS NULL THEN EXCLUDED.wager_limit_micro_usd
         ELSE LEAST(play_restrictions.wager_limit_micro_usd, EXCLUDED.wager_limit_micro_usd)
       END,
       daily_wager_limit_micro_usd = CASE
         WHEN EXCLUDED.daily_wager_limit_micro_usd IS NULL THEN play_restrictions.daily_wager_limit_micro_usd
         WHEN play_restrictions.daily_wager_limit_micro_usd IS NULL THEN EXCLUDED.daily_wager_limit_micro_usd
         ELSE LEAST(play_restrictions.daily_wager_limit_micro_usd, EXCLUDED.daily_wager_limit_micro_usd)
       END,
       daily_loss_limit_micro_usd = CASE
         WHEN EXCLUDED.daily_loss_limit_micro_usd IS NULL THEN play_restrictions.daily_loss_limit_micro_usd
         WHEN play_restrictions.daily_loss_limit_micro_usd IS NULL THEN EXCLUDED.daily_loss_limit_micro_usd
         ELSE LEAST(play_restrictions.daily_loss_limit_micro_usd, EXCLUDED.daily_loss_limit_micro_usd)
       END,
       updated_at = NOW()`,
    [
      input.principal,
      input.selfExcludedUntil ?? null,
      input.coolingOffUntil ?? null,
      input.depositLimitMicroUsd ?? null,
      input.wagerLimitMicroUsd ?? null,
      input.dailyWagerLimitMicroUsd ?? null,
      input.dailyLossLimitMicroUsd ?? null,
    ],
  );
}

export type RestrictionLimitType =
  | "deposit_limit"
  | "wager_limit"
  | "daily_wager_limit"
  | "daily_loss_limit";

const LIMIT_COLUMNS: Readonly<Record<RestrictionLimitType, keyof RestrictionRow>> = {
  deposit_limit: "deposit_limit_micro_usd",
  wager_limit: "wager_limit_micro_usd",
  daily_wager_limit: "daily_wager_limit_micro_usd",
  daily_loss_limit: "daily_loss_limit_micro_usd",
};

export async function requestRestrictionLimitChange(input: {
  readonly principal: string;
  readonly type: RestrictionLimitType;
  readonly amountMicroUsd: string;
}): Promise<{ readonly appliedImmediately: boolean; readonly effectiveAt: string | null }> {
  const amount = BigInt(input.amountMicroUsd);
  if (amount < 0n) throw new RangeError("Restriction limit must be nonnegative");
  const pool = getPool();
  if (!pool) throw new Error("Policy store unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO play_restrictions (principal) VALUES ($1) ON CONFLICT (principal) DO NOTHING",
      [input.principal],
    );
    const result = await client.query<RestrictionRow>(
      "SELECT * FROM play_restrictions WHERE principal = $1 FOR UPDATE",
      [input.principal],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Policy row unavailable");
    const column = LIMIT_COLUMNS[input.type];
    const currentRaw = row[column];
    const current = typeof currentRaw === "string" ? BigInt(currentRaw) : null;
    if (current === null || amount <= current) {
      await client.query(
        `UPDATE play_restrictions
            SET ${column} = $2,
                pending_increase = CASE
                  WHEN pending_increase->>'type' = $3 THEN NULL
                  ELSE pending_increase
                END,
                updated_at = NOW()
          WHERE principal = $1`,
        [input.principal, amount.toString(), input.type],
      );
      await client.query("COMMIT");
      return { appliedImmediately: true, effectiveAt: null };
    }
    const pendingType = typeof row.pending_increase?.type === "string" ? row.pending_increase.type : null;
    if (pendingType && pendingType !== input.type) {
      throw new TypeError("Another limit increase is already pending");
    }
    const effectiveAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await client.query(
      `UPDATE play_restrictions
          SET pending_increase = $2, updated_at = NOW()
        WHERE principal = $1`,
      [input.principal, { type: input.type, amountMicroUsd: amount.toString(), effectiveAt }],
    );
    await client.query("COMMIT");
    return { appliedImmediately: false, effectiveAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
