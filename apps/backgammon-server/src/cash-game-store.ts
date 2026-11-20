import { randomUUID } from "node:crypto";
import {
  CASH_GAME_RULES_V1,
  maximumReserve,
  serializeCashGameRules,
  settleCashGame,
  type CubeValue,
  type ResultMultiplier,
} from "@xion-beginner/backgammon-core";
import { getPool } from "./db.js";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  verifyReserveTransaction,
  type EscrowChainSnapshot,
  type EscrowReserveVerification,
} from "./cash-game-chain.js";
import { payloadHash } from "./finance-crypto.js";
import { authoritativeBalance } from "./finance-router.js";
import { fundsGate } from "./funds-config.js";
import type { GameReviewReason } from "./types.js";
import { FundsActionDeniedError, lockFundsAction, lockRecoveryParticipants, lockWagerParticipants } from "./action-policy.js";
import { markEffectDispatchUnderLease } from "./finance-store.js";


export type CashQuoteState =
  | "offered"
  | "accepted"
  | "reserving"
  | "active"
  | "settlement_pending"
  | "settled"
  | "refunded"
  | "review"
  | "expired";
const SettlementReceiptSchema = z.object({
  cubeValue: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  cubeWasTurned: z.boolean(),
  gameId: z.string().uuid(),
  quoteId: z.string().uuid(),
  resultMultiplier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  settlementId: z.string().uuid(),
  winner: z.string(),
  settlement: z.object({
    liabilityMicroUsd: z.string(),
    loserRefundMicroUsd: z.string(),
    rakeMicroUsd: z.string(),
    totalDepositedMicroUsd: z.string(),
    winnerPayoutMicroUsd: z.string(),
  }),
});
const RefundReceiptSchema = z.object({
  kind: z.literal("refund"),
  gameId: z.string().uuid(),
  quoteId: z.string().uuid(),
  refundId: z.string().min(1).max(200),
  reason: z.string(),
  refundedAt: z.string().datetime(),
});
const TerminalReceiptSchema = z.union([SettlementReceiptSchema, RefundReceiptSchema]);
const FinishedGameStateSchema = z.object({
  gameOver: z.literal(true),
  winner: z.enum(["white", "black"]),
  resultType: z.enum(["normal", "gammon", "backgammon"]),
  cubeValue: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
});
const LegacyEscrowSnapshotSchema = z.object({
  chainId: z.string().min(1),
  genesisHash: z.string().regex(/^[0-9a-f]{64}$/i),
  escrowContract: z.string().min(1),
  escrowCodeChecksum: z.string().regex(/^[0-9a-f]{64}$/i),
  denom: z.string().min(1),
  finalityBlocks: z.number().int().positive().max(1_000),
  settlementAuthority: z.string().min(1),
}).strict();


export type CashQuoteResolutionState =
  | "none"
  | "resume"
  | "adjudicated_settlement"
  | "refund"
  | "operator_resolution_required";

export interface CashQuote {
  readonly id: string;
  readonly gameId: string;
  readonly quoteHash: string;
  readonly playerA: string;
  readonly playerB: string;
  readonly stakeMicroUsd: string;
  readonly reservePerPlayerMicroUsd: string;
  readonly rakeBps: number;
  readonly cubeCap: 8;
  readonly rules: Record<string, unknown>;
  readonly state: CashQuoteState;
  readonly expiresAt: string;
  readonly fundingDeadline: string | null;
  readonly fundedStartDeadline: string | null;
  readonly reviewDeadline: string | null;
  readonly resolutionState: CashQuoteResolutionState;
  readonly resolutionReason: string | null;
  readonly fundsMode: "free" | "verusd_testnet" | "verusd_production" | "legacy_unverified";
  readonly testFunds: boolean;
  readonly asset: { readonly denom: string; readonly decimals: number; readonly symbol: string; readonly displayDenomination: string };
  readonly balanceSnapshot: Record<string, unknown>;
  readonly termsSnapshot: Record<string, unknown>;
  readonly legalSnapshot: Record<string, unknown>;
  readonly escrowSnapshot: Record<string, unknown>;
  readonly acceptances: readonly {
    readonly principal: string;
    readonly quoteHash: string;
    readonly acceptedAt: string;
    readonly evidence: Record<string, unknown>;
  }[];
  readonly createdAt: string;
  readonly cashSessionStartedAt: string | null;
  readonly fundedStartAcknowledged: boolean;
  readonly realityCheckDueAt: string | null;
  readonly realityCheckAcknowledgedAt: string | null;
  readonly version: number;
  readonly receipt: z.infer<typeof TerminalReceiptSchema> | null;
  readonly settlementTxHash: string | null;
  readonly reviewReason: GameReviewReason | null;
}

function database() {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_UNAVAILABLE");
  return pool;
}

function deadlineSeconds(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= minimum && seconds <= maximum ? seconds : fallback;
}

function maximumConcurrentCommitments(): number {
  return deadlineSeconds("CASH_GAME_MAX_CONCURRENT_COMMITMENTS", 3, 1, 20);
}

function fundedStartDeadline(): Date {
  return new Date(Date.now() + deadlineSeconds("CASH_GAME_FUNDED_START_TIMEOUT_SECONDS", 15 * 60, 60, 24 * 60 * 60) * 1_000);
}

function reviewDeadline(): Date {
  return new Date(Date.now() + deadlineSeconds("CASH_GAME_REVIEW_TIMEOUT_SECONDS", 7 * 24 * 60 * 60, 60 * 60, 30 * 24 * 60 * 60) * 1_000);
}

async function pendingCommitmentAmount(database: Pick<Pool | PoolClient, "query">, principal: string): Promise<bigint> {
  const result = await database.query(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::text AS amount
       FROM cash_game_commitments
      WHERE principal = $1 AND state = 'pending'`,
    [principal],
  );
  return BigInt(result.rows[0]?.amount ?? "0");
}

export async function pendingCashCommitmentAmount(principal: string): Promise<bigint> {
  return pendingCommitmentAmount(database(), principal);
}

async function assertCommitmentCapacity(client: PoolClient, principal: string, reserve: bigint): Promise<Record<string, unknown>> {
  const commitments = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM cash_game_commitments
      WHERE principal = $1 AND state IN ('pending', 'funded')`,
    [principal],
  );
  if (Number(commitments.rows[0]?.count ?? "0") >= maximumConcurrentCommitments()) {
    throw new Error("CONCURRENT_COMMITMENT_LIMIT_REACHED");
  }
  const balance = await authoritativeBalance(principal);
  if (
    balance.status !== "fresh" ||
    typeof balance.availableMicroUsd !== "string" ||
    typeof balance.pendingCommitmentMicroUsd !== "string"
  ) throw new Error("BALANCE_UNAVAILABLE");
  const transactionPending = await pendingCommitmentAmount(client, principal);
  const transactionAvailable =
    BigInt(balance.availableMicroUsd) + BigInt(balance.pendingCommitmentMicroUsd) - transactionPending;
  if (transactionAvailable < reserve) throw new Error("INSUFFICIENT_BALANCE");
  return {
    availableMicroUsd: balance.availableMicroUsd,
    pendingCommitmentMicroUsd: balance.pendingCommitmentMicroUsd,
    observedAt: typeof balance.observedAt === "string" ? balance.observedAt : null,
    transactionPendingMicroUsd: transactionPending.toString(),
  };
}
function quoteFromRow(row: Record<string, unknown>): CashQuote {
  const cashSessionStartedAt = row.cash_session_started_at
    ? new Date(row.cash_session_started_at as string | Date)
    : null;
  const intervalSeconds = deadlineSeconds("CASH_GAME_REALITY_CHECK_INTERVAL_SECONDS", 60 * 60, 60, 24 * 60 * 60);
  const elapsedIntervals = cashSessionStartedAt
    ? Math.max(1, Math.floor((Date.now() - cashSessionStartedAt.getTime()) / (intervalSeconds * 1_000)))
    : 0;
  const acknowledgedRealityInterval = Number(row.acknowledged_reality_interval ?? 0);
  return {
    id: String(row.id),
    gameId: String(row.game_id),
    quoteHash: String(row.quote_hash),
    playerA: String(row.player_a),
    playerB: String(row.player_b),
    stakeMicroUsd: String(row.stake_micro_usd),
    reservePerPlayerMicroUsd: String(row.reserve_per_player_micro_usd),
    rakeBps: Number(row.rake_bps),
    cubeCap: 8,
    rules: row.rules_snapshot as Record<string, unknown>,
    state: row.state as CashQuoteState,
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    fundingDeadline: row.funding_deadline ? new Date(row.funding_deadline as string | Date).toISOString() : null,
    fundedStartDeadline: row.funded_start_deadline ? new Date(row.funded_start_deadline as string | Date).toISOString() : null,
    reviewDeadline: row.review_deadline ? new Date(row.review_deadline as string | Date).toISOString() : null,
    resolutionState: typeof row.resolution_state === "string" ? row.resolution_state as CashQuoteResolutionState : "none",
    resolutionReason: typeof row.resolution_reason === "string" ? row.resolution_reason : null,
    cashSessionStartedAt: cashSessionStartedAt?.toISOString() ?? null,
    realityCheckDueAt: cashSessionStartedAt && elapsedIntervals > acknowledgedRealityInterval
      ? new Date(cashSessionStartedAt.getTime() + elapsedIntervals * intervalSeconds * 1_000).toISOString()
      : null,
    realityCheckAcknowledgedAt: row.reality_check_acknowledged_at ? new Date(row.reality_check_acknowledged_at as string | Date).toISOString() : null,
    fundedStartAcknowledged: row.funded_start_acknowledged === true,
    version: Number(row.version),
    receipt: row.terminal_snapshot ? TerminalReceiptSchema.parse(row.terminal_snapshot) : null,
    asset: {
      denom: String((row.asset_snapshot as Record<string, unknown> | null)?.denom ?? row.asset_denom),
      decimals: Number((row.asset_snapshot as Record<string, unknown> | null)?.decimals ?? 6),
      symbol: String((row.asset_snapshot as Record<string, unknown> | null)?.symbol ?? "verUSD"),
      displayDenomination: String(row.display_denomination ?? "USD"),
    },
    balanceSnapshot: (row.balance_snapshot as Record<string, unknown> | null) ?? {},
    termsSnapshot: (row.terms_snapshot as Record<string, unknown> | null) ?? {},
    legalSnapshot: (row.legal_snapshot as Record<string, unknown> | null) ?? {},
    settlementTxHash: row.settlement_tx_hash === null ? null : String(row.settlement_tx_hash),
    escrowSnapshot: (row.escrow_snapshot as Record<string, unknown> | null) ?? {},
    acceptances: Array.isArray(row.acceptances)
      ? (row.acceptances as Array<Record<string, unknown>>).map((acceptance) => ({
          principal: String(acceptance.principal),
          quoteHash: String(acceptance.quoteHash),
          acceptedAt: new Date(String(acceptance.acceptedAt)).toISOString(),
          evidence: (acceptance.evidence as Record<string, unknown> | null) ?? {},
        }))
      : [],
    fundsMode: (typeof row.funds_mode === "string" ? row.funds_mode : "legacy_unverified") as CashQuote["fundsMode"],
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    testFunds: row.test_funds === true || typeof row.funds_mode !== "string",
    reviewReason: typeof row.review_reason === "string" ? row.review_reason as GameReviewReason : null,
  };
}

async function attachAcceptanceEvidence(client: PoolClient, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const acceptances = await client.query(
    `SELECT jsonb_agg(jsonb_build_object(
      'principal', principal,
      'quoteHash', quote_hash,
      'acceptedAt', accepted_at,
      'evidence', evidence_snapshot
    ) ORDER BY accepted_at) AS acceptances
       FROM cash_game_acceptances WHERE quote_id = $1`,
    [row.id],
  );
  row.acceptances = acceptances.rows[0]?.acceptances ?? [];
  return row;
}

export async function createCashQuote(input: {
  readonly playerA: string;
  readonly playerB: string;
  readonly stakeMicroUsd: bigint;
  readonly idempotencyKey: string;
  readonly termsSnapshot: Record<string, unknown>;
  readonly legalSnapshot: Record<string, unknown>;
  readonly balanceSnapshot: Record<string, unknown>;
  readonly escrowSnapshot: Record<string, unknown>;
}): Promise<CashQuote> {
  const approved = fundsGate.escrowRecoverySnapshot();
  if (!approved || payloadHash(input.escrowSnapshot) !== payloadHash(approved)) {
    throw new Error("ESCROW_ATTESTATION_UNAVAILABLE");
  }
  const legacyBlockers = await legacyCashReconciliationBlockers();
  if (legacyBlockers.length > 0) throw new FundsActionDeniedError(legacyBlockers);
  if (input.playerA === input.playerB) throw new TypeError("Players must be distinct");
  const asset = fundsGate.config.asset;
  if (!asset) throw new Error("ASSET_NOT_CONFIGURED");
  const reserve = maximumReserve(input.stakeMicroUsd);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const findExisting = () => client.query(
      "SELECT * FROM cash_game_quotes WHERE player_a = $1 AND creator_idempotency_key = $2",
      [input.playerA, input.idempotencyKey],
    );
    let existing = await findExisting();
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.player_b !== input.playerB || BigInt(row.stake_micro_usd) !== input.stakeMicroUsd) {
        throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
      }
      await client.query("COMMIT");
      return quoteFromRow(row);
    }

    const decision = await lockFundsAction(client, input.playerA, "wager", reserve);
    if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
    existing = await findExisting();
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.player_b !== input.playerB || BigInt(row.stake_micro_usd) !== input.stakeMicroUsd) {
        throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
      }
      await client.query("COMMIT");
      return quoteFromRow(row);
    }

    const id = randomUUID();
    const gameId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const rules = JSON.parse(serializeCashGameRules(CASH_GAME_RULES_V1)) as Record<string, unknown>;
    const assetSnapshot = {
      chainId: asset.chainId,
      decimals: asset.decimals,
      denom: asset.denom,
      displayDenomination: "USD",
      symbol: asset.symbol,
    };
    const fundsSnapshot = {
      mode: fundsGate.config.mode,
      testFunds: fundsGate.config.mode === "verusd_testnet",
    };
    const quotePayload = {
      asset: assetSnapshot,
      balance: input.balanceSnapshot,
      cubeCap: CASH_GAME_RULES_V1.cubeCap,
      expiresAt: expiresAt.toISOString(),
      funds: fundsSnapshot,
      gameId,
      legal: input.legalSnapshot,
      playerA: input.playerA,
      playerB: input.playerB,
      rakeBps: CASH_GAME_RULES_V1.rakeBps,
      reservePerPlayerMicroUsd: reserve.toString(),
      rules,
      stakeMicroUsd: input.stakeMicroUsd.toString(),
      terms: input.termsSnapshot,
      escrow: input.escrowSnapshot,
    };
    const quoteHash = payloadHash(quotePayload);
    const inserted = await client.query(
      `INSERT INTO cash_game_quotes
        (id, game_id, rules_hash, rules_snapshot, stake_micro_usd, cube_cap,
         reserve_per_player_micro_usd, rake_bps, state, expires_at, quote_hash,
         player_a, player_b, asset_denom, escrow_game_id, creator_idempotency_key,
         funds_mode, test_funds, asset_snapshot, display_denomination, balance_snapshot,
         terms_snapshot, legal_snapshot, escrow_snapshot)
       VALUES ($1, $2, $3, $4, $5, 8, $6, $7, 'offered', $8, $3, $9, $10, $11, $2, $12,
               $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        id,
        gameId,
        quoteHash,
        rules,
        input.stakeMicroUsd.toString(),
        reserve.toString(),
        CASH_GAME_RULES_V1.rakeBps,
        expiresAt,
        input.playerA,
        input.playerB,
        asset.denom,
        input.idempotencyKey,
        fundsSnapshot.mode,
        fundsSnapshot.testFunds,
        assetSnapshot,
        assetSnapshot.displayDenomination,
        input.balanceSnapshot,
        input.termsSnapshot,
        input.legalSnapshot,
        input.escrowSnapshot,
      ],
    );
    await client.query("COMMIT");
    return quoteFromRow(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function participantQuoteSelect(principalPlaceholder: "$1" | "$2"): string {
  return `quote.*,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'principal', acceptance.principal,
        'quoteHash', acceptance.quote_hash,
        'acceptedAt', acceptance.accepted_at,
        'evidence', CASE WHEN acceptance.principal = ${principalPlaceholder}
          THEN acceptance.evidence_snapshot ELSE '{}'::jsonb END
      ) ORDER BY acceptance.accepted_at)
        FROM cash_game_acceptances acceptance
       WHERE acceptance.quote_id = quote.id
    ), '[]'::jsonb) AS acceptances,
    (
      SELECT acknowledgement.acknowledged_at
        FROM cash_game_reality_interval_acknowledgements acknowledgement
       WHERE acknowledgement.quote_id = quote.id AND acknowledgement.principal = ${principalPlaceholder}
       ORDER BY acknowledgement.interval_number DESC
       LIMIT 1
    ) AS reality_check_acknowledged_at,
    COALESCE((
      SELECT MAX(acknowledgement.interval_number)
        FROM cash_game_reality_interval_acknowledgements acknowledgement
       WHERE acknowledgement.quote_id = quote.id AND acknowledgement.principal = ${principalPlaceholder}
    ), 0) AS acknowledged_reality_interval,
    EXISTS (
      SELECT 1 FROM cash_game_start_acknowledgements acknowledgement
       WHERE acknowledgement.quote_id = quote.id AND acknowledgement.principal = ${principalPlaceholder}
    ) AS funded_start_acknowledged`;
}

export async function getCashQuote(principal: string, quoteId: string): Promise<CashQuote | null> {
  const result = await database().query(
    `SELECT ${participantQuoteSelect("$2")}
       FROM cash_game_quotes quote
      WHERE quote.id = $1 AND $2 IN (quote.player_a, quote.player_b)`,
    [quoteId, principal],
  );
  return result.rows[0] ? quoteFromRow(result.rows[0]) : null;
}

export async function listCashQuotes(principal: string, limit = 100): Promise<readonly CashQuote[]> {
  const result = await database().query(
    `SELECT ${participantQuoteSelect("$1")}
       FROM cash_game_quotes quote
      WHERE $1 IN (quote.player_a, quote.player_b)
      ORDER BY quote.created_at DESC
      LIMIT $2`,
    [principal, Math.max(1, Math.min(limit, 100))],
  );
  return result.rows.map(quoteFromRow);
}

export async function quoteForGame(gameId: string): Promise<CashQuote | null> {
  const result = await database().query("SELECT * FROM cash_game_quotes WHERE game_id = $1", [gameId]);
  return result.rows[0] ? quoteFromRow(result.rows[0]) : null;
}

export async function acceptCashQuote(input: {

  readonly principal: string;
  readonly quoteId: string;
  readonly quoteHash: string;
  readonly consentSnapshot: Record<string, unknown>;
  readonly evidenceSnapshot: Record<string, unknown>;
}): Promise<CashQuote> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    const row = found.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(input.principal)) throw new Error("QUOTE_NOT_FOUND");
    if (row.quote_hash !== input.quoteHash) throw new Error("QUOTE_HASH_MISMATCH");

    const existingAcceptance = await client.query<{
      quote_hash: string;
    }>(
      "SELECT quote_hash FROM cash_game_acceptances WHERE quote_id = $1 AND principal = $2",
      [input.quoteId, input.principal],
    );
    if (existingAcceptance.rows[0]) {
      if (existingAcceptance.rows[0].quote_hash !== input.quoteHash) {
        throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
      }
      await client.query("COMMIT");
      return quoteFromRow(row);
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      const expired = await client.query(
        `UPDATE cash_game_quotes SET state = 'expired', version = version + 1
          WHERE id = $1 RETURNING *`,
        [input.quoteId],
      );
      await client.query("COMMIT");
      return quoteFromRow(expired.rows[0]);
    }
    if (!["offered", "accepted"].includes(row.state)) throw new Error("QUOTE_STATE_CONFLICT");

    const priorAcceptances = await client.query<{ principal: string }>(
      "SELECT principal FROM cash_game_acceptances WHERE quote_id = $1 ORDER BY principal",
      [input.quoteId],
    );
    const principalsToAuthorize = priorAcceptances.rowCount === 1
      ? [String(row.player_a), String(row.player_b)].sort()
      : [input.principal];
    const lockedDecisions = await lockWagerParticipants(
      client,
      principalsToAuthorize,
      BigInt(row.reserve_per_player_micro_usd),
      input.quoteId,
    );
    const eligibilityDecisionIds = new Map<string, string | null>();
    for (const { principal, decision } of lockedDecisions) {
      if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
      eligibilityDecisionIds.set(principal, decision.decisionId);
    }
    await client.query(
      `INSERT INTO cash_game_acceptances
        (quote_id, principal, quote_hash, consent_snapshot, evidence_snapshot, eligibility_decision_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.quoteId, input.principal, input.quoteHash, input.consentSnapshot, input.evidenceSnapshot, eligibilityDecisionIds.get(input.principal) ?? null],
    );
    const accepted = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM cash_game_acceptances WHERE quote_id = $1 AND quote_hash = $2",
      [input.quoteId, input.quoteHash],
    );
    const count = Number(accepted.rows[0]?.count ?? "0");
    if (count === 2) {
      const reserve = BigInt(row.reserve_per_player_micro_usd);
      const commitmentBalances = new Map<string, Record<string, unknown>>();
      for (const principal of [String(row.player_a), String(row.player_b)].sort()) {
        commitmentBalances.set(principal, await assertCommitmentCapacity(client, principal, reserve));
      }
      await client.query(
        `INSERT INTO cash_game_commitment_decisions
          (quote_id, principal, quote_hash, eligibility_decision_id, balance_snapshot)
         VALUES ($1, $2, $3, $4, $5), ($1, $6, $3, $7, $8)`,
        [
          row.id, row.player_a, row.quote_hash, eligibilityDecisionIds.get(row.player_a) ?? null, commitmentBalances.get(row.player_a),
          row.player_b, eligibilityDecisionIds.get(row.player_b) ?? null, commitmentBalances.get(row.player_b),
        ],
      );
      await client.query(
        `INSERT INTO cash_game_commitments (quote_id, principal, amount_micro_usd, state)
         VALUES ($1, $2, $3, 'pending'), ($1, $4, $3, 'pending')`,
        [row.id, row.player_a, reserve.toString(), row.player_b],
      );
      const operationId = randomUUID();
      const effectId = randomUUID();
      const effectPayload = {
        gameId: row.game_id,
        playerA: row.player_a,
        playerB: row.player_b,
        quoteHash: row.quote_hash,
        quoteId: row.id,
        stakeMicroUsd: String(row.stake_micro_usd),
      };
      await client.query(
        `INSERT INTO money_operations
          (id, principal, kind, state, amount_micro_usd, asset_denom,
           request_hash, client_idempotency_key, quote_snapshot)
         VALUES ($1, $2, 'wager_reserve', 'queued', $3, $4, $5, $6, $7)`,
        [
          operationId,
          row.player_a,
          String(BigInt(row.reserve_per_player_micro_usd) * 2n),
          row.asset_denom,
          row.quote_hash,
          `cash-quote:${row.id}`,
          {
            asset: row.asset_snapshot,
            destination: { type: "escrow", quoteId: row.id },
            funds: { mode: row.funds_mode, testFunds: row.test_funds },
            grossMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
            netMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
            quoteHash: row.quote_hash,
            quoteId: row.id,
            source: { type: "participant_reserves" },
          },
        ],
      );
      await client.query(
        `INSERT INTO external_effects
          (id, operation_id, provider, effect_type, state, request_payload,
           request_hash, provider_idempotency_key)
         VALUES ($1, $2, 'settlement_authorizer', 'escrow_create', 'queued', $3, $4, $5)`,
        [effectId, operationId, effectPayload, row.quote_hash, `gammon:${row.game_id}:create`],
      );
    }
    const updated = await client.query(
      `UPDATE cash_game_quotes
          SET state = $2, version = version + 1
        WHERE id = $1 RETURNING *`,
      [input.quoteId, count === 2 ? "reserving" : "accepted"],
    );
    await attachAcceptanceEvidence(client, updated.rows[0]);
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmReserve(input: {
  readonly principal: string;
  readonly quoteId: string;
  readonly txHash: string;
  readonly chainHeight: number;
  readonly finalityBlockHash: string;
}): Promise<CashQuote> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    const row = found.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(input.principal)) throw new Error("QUOTE_NOT_FOUND");
    const existing = await client.query<{ chain_tx_hash: string }>(
      "SELECT chain_tx_hash FROM cash_game_reserves WHERE quote_id = $1 AND principal = $2",
      [input.quoteId, input.principal],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].chain_tx_hash !== input.txHash) throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
      await client.query("COMMIT");
      return quoteFromRow(row);
    }
    if (row.state !== "reserving") throw new Error("QUOTE_STATE_CONFLICT");
    const reusedTransaction = await client.query(
      "SELECT 1 FROM cash_game_reserves WHERE chain_tx_hash = $1",
      [input.txHash],
    );
    if (reusedTransaction.rowCount !== 0) throw new Error("CHAIN_TRANSACTION_MISMATCH");
    const operation = await client.query<{ operation_id: string }>(
      `SELECT operation_id
         FROM external_effects
        WHERE effect_type = 'escrow_create' AND request_payload->>'quoteId' = $1
        FOR KEY SHARE`,
      [input.quoteId],
    );
    const operationId = operation.rows[0]?.operation_id;
    if (!operationId || !/^[0-9A-F]{64}$/.test(input.txHash) || !input.finalityBlockHash) {
      throw new Error("CHAIN_TRANSACTION_MISMATCH");
    }
    const reserveBatchId = randomUUID();
    const reserveBatch = await client.query(
      `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation_id, entry_key) DO NOTHING`,
      [reserveBatchId, operationId, row.asset_denom, `reserve:${input.principal}`],
    );
    if (reserveBatch.rowCount !== 1) throw new Error("RESERVE_EVIDENCE_CONFLICT");
    await client.query(
      `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
       VALUES ($1, 'player_escrow_available', $2, 'debit', $3),
              ($1, 'escrow_reserve', $2, 'credit', $3)`,
      [reserveBatchId, input.principal, row.reserve_per_player_micro_usd],
    );
    await client.query(
      `INSERT INTO cash_game_reserves
        (quote_id, principal, amount_micro_usd, chain_tx_hash, chain_height, finality_block_hash, reserve_journal_batch_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'final')`,
      [
        input.quoteId, input.principal, row.reserve_per_player_micro_usd, input.txHash, input.chainHeight,
        input.finalityBlockHash, reserveBatchId,
      ],
    );
    await client.query(
      `UPDATE cash_game_commitments
          SET state = 'funded'
        WHERE quote_id = $1 AND principal = $2 AND state = 'pending'`,
      [input.quoteId, input.principal],
    );
    const reserves = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM cash_game_reserves WHERE quote_id = $1 AND state = 'final'",
      [input.quoteId],
    );
    const active = Number(reserves.rows[0]?.count ?? "0") === 2;
    const updated = await client.query(
      `UPDATE cash_game_quotes
          SET state = $2,
              funded_start_deadline = CASE WHEN $2 = 'active' THEN $3 ELSE funded_start_deadline END,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [input.quoteId, active ? "active" : "reserving", active ? fundedStartDeadline() : null],
    );
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function legacyCashReconciliationBlockers(): Promise<readonly string[]> {
  if (fundsGate.config.mode === "free") return [];
  try {
    const result = await database().query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM legacy_escrow_reserve_reconciliations
          WHERE state <> 'reconciled'
       ) OR EXISTS (
         SELECT 1 FROM legacy_escrow_manual_reconstruction_requirements requirement
          WHERE NOT EXISTS (
            SELECT 1 FROM legacy_escrow_manual_reconstruction_resolutions resolution
             WHERE resolution.effect_id = requirement.effect_id
          )
       ) AS pending`,
    );
    return result.rows[0]?.pending ? ["legacy_escrow_reconciliation_pending"] : [];
  } catch {
    return ["legacy_escrow_reconciliation_status_unavailable"];
  }
}

async function recordLegacyReserveReconciliation(
  quoteId: string,
  principal: string,
  state: "attestation_required" | "chain_convergence_required" | "manual_reconstruction_required",
  reasonCode: string,
  leaseOwner: string,
): Promise<void> {
  await database().query(
    `UPDATE legacy_escrow_reserve_reconciliations
        SET state = $3, reason_code = $4, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = NOW()
      WHERE quote_id = $1 AND principal = $2
        AND state <> 'reconciled' AND lease_owner = $5`,
    [quoteId, principal, state, reasonCode, leaseOwner],
  );
}

export async function reconcileLegacyCashReserves(limit = 100): Promise<{
  readonly reconciled: number;
  readonly pending: number;
  readonly manual: number;
}> {
  const leaseOwner = `legacy-recovery:${randomUUID()}`;
  const claimClient = await database().connect();
  const rows = await (async () => {
    try {
      await claimClient.query("BEGIN");
      await claimClient.query(
        `WITH candidates AS (
           SELECT quote_id, principal
             FROM legacy_escrow_reserve_reconciliations
            WHERE state IN ('attestation_required', 'chain_convergence_required')
              AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
            ORDER BY updated_at, quote_id, principal
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE legacy_escrow_reserve_reconciliations reconciliation
            SET lease_owner = $1, lease_expires_at = NOW() + INTERVAL '5 minutes'
           FROM candidates
          WHERE reconciliation.quote_id = candidates.quote_id
            AND reconciliation.principal = candidates.principal`,
        [leaseOwner, Math.max(1, Math.min(limit, 1_000))],
      );
      const claimed = await claimClient.query<{
        quote_id: string;
        principal: string;
        amount_micro_usd: string;
        chain_tx_hash: string | null;
        chain_height: string | number | null;
        escrow_snapshot: unknown;
        game_id: string;
      }>(
        `SELECT reconciliation.quote_id, reconciliation.principal, reserve.amount_micro_usd,
                reserve.chain_tx_hash, reserve.chain_height, quote.escrow_snapshot, quote.game_id
           FROM legacy_escrow_reserve_reconciliations reconciliation
           JOIN cash_game_reserves reserve
             ON reserve.quote_id = reconciliation.quote_id AND reserve.principal = reconciliation.principal
           JOIN cash_game_quotes quote ON quote.id = reconciliation.quote_id
          WHERE reconciliation.lease_owner = $1
          ORDER BY reconciliation.updated_at, reconciliation.quote_id, reconciliation.principal`,
        [leaseOwner],
      );
      await claimClient.query("COMMIT");
      return claimed;
    } catch (error) {
      await claimClient.query("ROLLBACK");
      throw error;
    } finally {
      claimClient.release();
    }
  })();
  let reconciled = 0;
  let pending = 0;
  let manual = 0;
  for (const row of rows.rows) {
    const snapshot = LegacyEscrowSnapshotSchema.safeParse(row.escrow_snapshot);
    const height = Number(row.chain_height);
    if (
      !snapshot.success ||
      !row.chain_tx_hash ||
      !/^[0-9A-F]{64}$/.test(row.chain_tx_hash) ||
      !Number.isSafeInteger(height) ||
      height < 1
    ) {
      await recordLegacyReserveReconciliation(
        row.quote_id,
        row.principal,
        "manual_reconstruction_required",
        "legacy_reserve_chain_evidence_unreconstructable",
        leaseOwner,
      );
      manual++;
      continue;
    }
    let verified: EscrowReserveVerification;
    try {
      verified = await verifyReserveTransaction({
        snapshot: snapshot.data as EscrowChainSnapshot,
        txHash: row.chain_tx_hash,
        principal: row.principal,
        signer: null,
        gameId: row.game_id,
        expectedAmountMicroUsd: String(row.amount_micro_usd),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "CHAIN_TRANSACTION_MISMATCH") {
        await recordLegacyReserveReconciliation(
          row.quote_id,
          row.principal,
          "manual_reconstruction_required",
          "legacy_reserve_signer_evidence_unavailable",
          leaseOwner,
        );
        manual++;
      } else {
        await recordLegacyReserveReconciliation(
          row.quote_id,
          row.principal,
          "chain_convergence_required",
          "legacy_reserve_chain_attestation_pending",
          leaseOwner,
        );
        pending++;
      }
      continue;
    }
    if (verified.height !== height) {
      await recordLegacyReserveReconciliation(
        row.quote_id,
        row.principal,
        "manual_reconstruction_required",
        "legacy_reserve_height_mismatch",
        leaseOwner,
      );
      manual++;
      continue;
    }

    const client = await database().connect();
    let recoveryIncomplete = false;
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        amount_micro_usd: string;
        chain_tx_hash: string | null;
        chain_height: string | number | null;
        reserve_journal_batch_id: string | null;
        reserve_state: string;
        asset_denom: string;
        quote_state: string;
        review_reason: string | null;
        terminal_snapshot: unknown;
        settlement_tx_hash: string | null;
        reconciliation_state: string;
        lease_owner: string | null;
        lease_expires_at: Date | null;
        terminal_effect_id: string | null;
        terminal_operation_id: string | null;
      }>(
        `SELECT reserve.amount_micro_usd, reserve.chain_tx_hash, reserve.chain_height,
                reserve.reserve_journal_batch_id, reserve.state AS reserve_state,
                quote.asset_denom, quote.state AS quote_state, quote.review_reason,
                quote.terminal_snapshot, quote.settlement_tx_hash,
                reconciliation.state AS reconciliation_state,
                reconciliation.lease_owner, reconciliation.lease_expires_at,
                terminal_attestation.effect_id AS terminal_effect_id,
                terminal_attestation.operation_id AS terminal_operation_id
           FROM cash_game_reserves reserve
           JOIN cash_game_quotes quote ON quote.id = reserve.quote_id
           JOIN legacy_escrow_reserve_reconciliations reconciliation
             ON reconciliation.quote_id = reserve.quote_id
            AND reconciliation.principal = reserve.principal
           LEFT JOIN LATERAL (
             SELECT attestation.effect_id, terminal_effect.operation_id
               FROM cash_game_effect_attestations attestation
               JOIN external_effects terminal_effect ON terminal_effect.id = attestation.effect_id
               JOIN money_operations terminal_operation ON terminal_operation.id = terminal_effect.operation_id
              WHERE attestation.quote_id = quote.id
                AND attestation.effect_type = CASE
                  WHEN quote.state = 'settled' THEN 'escrow_settle'
                  WHEN quote.state = 'refunded' THEN 'escrow_refund'
                  ELSE ''
                END
                AND terminal_operation.kind = CASE
                  WHEN quote.state = 'settled' THEN 'wager_settlement'
                  WHEN quote.state = 'refunded' THEN 'refund'
                  ELSE ''
                END
                AND attestation.receipt_snapshot IS NOT NULL
                AND terminal_effect.state = 'confirmed'
              ORDER BY attestation.observed_at DESC, attestation.effect_id
              LIMIT 1
           ) terminal_attestation ON true
          WHERE reserve.quote_id = $1 AND reserve.principal = $2
          FOR UPDATE OF reserve, quote, reconciliation`,
        [row.quote_id, row.principal],
      );
      const reserve = locked.rows[0];
      if (
        !reserve ||
        reserve.chain_tx_hash !== row.chain_tx_hash ||
        Number(reserve.chain_height) !== height ||
        reserve.amount_micro_usd !== String(row.amount_micro_usd)
      ) throw new Error("LEGACY_RESERVE_CHANGED");
      if (
        reserve.lease_owner !== leaseOwner ||
        !reserve.lease_expires_at ||
        reserve.lease_expires_at.getTime() <= Date.now() ||
        !["attestation_required", "chain_convergence_required"].includes(reserve.reconciliation_state)
      ) throw new Error("LEGACY_RESERVE_LEASE_LOST");
      if (reserve.quote_state === "settled" || reserve.quote_state === "refunded") {
        if (reserve.terminal_effect_id && reserve.terminal_operation_id) {
          await resolveLegacyManualRequirements(
            client,
            row.quote_id,
            reserve.terminal_effect_id,
            reserve.terminal_operation_id,
            {
              quoteId: row.quote_id,
              terminalState: reserve.quote_state,
              terminalSnapshot: reserve.terminal_snapshot,
              transactionHash: reserve.settlement_tx_hash,
              recovery: "legacy_terminal_state_preserved",
            },
          );
          const terminal = await client.query(
            `UPDATE legacy_escrow_reserve_reconciliations
                SET state = 'reconciled', reason_code = 'legacy_terminal_state_preserved',
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
              WHERE quote_id = $1 AND principal = $2 AND lease_owner = $3`,
            [row.quote_id, row.principal, leaseOwner],
          );
          if (terminal.rowCount !== 1) throw new Error("LEGACY_RESERVE_LEASE_LOST");
          await client.query("COMMIT");
          reconciled++;
        } else {
          const terminal = await client.query(
            `UPDATE legacy_escrow_reserve_reconciliations
                SET state = 'manual_reconstruction_required',
                    reason_code = 'legacy_terminal_attestation_missing',
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
              WHERE quote_id = $1 AND principal = $2 AND lease_owner = $3`,
            [row.quote_id, row.principal, leaseOwner],
          );
          if (terminal.rowCount !== 1) throw new Error("LEGACY_RESERVE_LEASE_LOST");
          await client.query("COMMIT");
          manual++;
        }
        continue;
      }
      if (
        reserve.quote_state !== "review" ||
        reserve.review_reason !== "escrow_reconciliation" ||
        reserve.reserve_state !== "review"
      ) {
        const changed = await client.query(
          `UPDATE legacy_escrow_reserve_reconciliations
              SET state = 'manual_reconstruction_required',
                  reason_code = 'legacy_quote_or_reserve_state_changed',
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE quote_id = $1 AND principal = $2 AND lease_owner = $3`,
          [row.quote_id, row.principal, leaseOwner],
        );
        if (changed.rowCount !== 1) throw new Error("LEGACY_RESERVE_LEASE_LOST");
        await client.query("COMMIT");
        manual++;
        continue;
      }
      const operation = await client.query<{ operation_id: string }>(
        `SELECT effect.operation_id
           FROM external_effects effect
          WHERE effect.effect_type = 'escrow_create'
            AND effect.request_payload->>'quoteId' = $1
          FOR KEY SHARE`,
        [row.quote_id],
      );
      const operationId = operation.rows[0]?.operation_id;
      if (!operationId) throw new Error("LEGACY_RESERVE_OPERATION_MISSING");
      const batchId = reserve.reserve_journal_batch_id ?? randomUUID();
      if (!reserve.reserve_journal_batch_id) {
        const inserted = await client.query(
          `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (operation_id, entry_key) DO NOTHING`,
          [batchId, operationId, reserve.asset_denom, `reserve:${row.principal}`],
        );
        if (inserted.rowCount !== 1) throw new Error("LEGACY_RESERVE_EVIDENCE_CONFLICT");
        await client.query(
          `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
           VALUES ($1, 'player_escrow_available', $2, 'debit', $3),
                  ($1, 'escrow_reserve', $2, 'credit', $3)`,
          [batchId, row.principal, reserve.amount_micro_usd],
        );
      }
      await client.query(
        `UPDATE cash_game_reserves
            SET state = 'final', finality_block_hash = $3, reserve_journal_batch_id = $4, updated_at = NOW()
          WHERE quote_id = $1 AND principal = $2`,
        [row.quote_id, row.principal, verified.blockHash, batchId],
      );
      await client.query(
        `UPDATE cash_game_commitments
            SET state = 'funded'
          WHERE quote_id = $1 AND principal = $2 AND state = 'pending'`,
        [row.quote_id, row.principal],
      );
      const reconciledRow = await client.query(
        `UPDATE legacy_escrow_reserve_reconciliations
            SET state = 'reconciled', reason_code = 'legacy_reserve_reconciled',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE quote_id = $1 AND principal = $2 AND lease_owner = $3
            AND lease_expires_at > NOW()
            AND state IN ('attestation_required', 'chain_convergence_required')`,
        [row.quote_id, row.principal, leaseOwner],
      );
      if (reconciledRow.rowCount !== 1) throw new Error("LEGACY_RESERVE_LEASE_LOST");
      const completion = await client.query<{ complete: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1 FROM legacy_escrow_reserve_reconciliations
            WHERE quote_id = $1 AND state <> 'reconciled'
         ) AND NOT EXISTS (
           SELECT 1 FROM legacy_escrow_manual_reconstruction_requirements requirement
            WHERE requirement.quote_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM legacy_escrow_manual_reconstruction_resolutions resolution
                 WHERE resolution.effect_id = requirement.effect_id
              )
         ) AS complete`,
        [row.quote_id],
      );
      if (completion.rows[0]?.complete) {
        await client.query(
          `UPDATE external_effects effect
              SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                  next_attempt_at = NOW(), last_error_code = NULL, updated_at = NOW()
             FROM money_operations operation
            WHERE effect.operation_id = operation.id
              AND operation.quote_snapshot->>'quoteId' = $1
              AND (
                (operation.kind = 'wager_reserve' AND effect.effect_type = 'escrow_create')
                OR (operation.kind = 'wager_settlement' AND effect.effect_type = 'escrow_settle')
                OR (operation.kind = 'refund' AND effect.effect_type = 'escrow_refund')
              )
              AND (
                effect.state IN ('queued', 'retry')
                OR (effect.state = 'leased' AND effect.lease_expires_at <= NOW())
              )
              AND effect.request_payload <> '{"redacted":true}'::jsonb
              AND NOT EXISTS (
                SELECT 1 FROM external_effect_dispatches dispatch
                 WHERE dispatch.effect_id = effect.id
              )`,
          [row.quote_id],
        );
        await client.query(
          `UPDATE external_effects effect
              SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
                  next_attempt_at = NOW(), updated_at = NOW()
             FROM money_operations operation
            WHERE effect.operation_id = operation.id
              AND operation.quote_snapshot->>'quoteId' = $1
              AND (
                (operation.kind = 'wager_reserve' AND effect.effect_type = 'escrow_create')
                OR (operation.kind = 'wager_settlement' AND effect.effect_type = 'escrow_settle')
                OR (operation.kind = 'refund' AND effect.effect_type = 'escrow_refund')
              )
              AND (
                effect.state IN ('queued', 'retry', 'ambiguous', 'sent')
                OR (effect.state = 'leased' AND effect.lease_expires_at <= NOW())
              )
              AND effect.request_payload <> '{"redacted":true}'::jsonb
              AND EXISTS (
                SELECT 1 FROM external_effect_dispatches dispatch
                 WHERE dispatch.effect_id = effect.id
                   AND dispatch.step = effect.effect_type
              )`,
          [row.quote_id],
        );
        await client.query(
          `UPDATE money_operations operation
              SET state = 'complete', failure_code = NULL, updated_at = NOW(), version = version + 1
            WHERE operation.state = 'review'
              AND operation.quote_snapshot->>'quoteId' = $1
              AND EXISTS (
                SELECT 1 FROM external_effects effect
                 WHERE effect.operation_id = operation.id
                   AND (
                     (operation.kind = 'wager_reserve' AND effect.effect_type = 'escrow_create')
                     OR (operation.kind = 'wager_settlement' AND effect.effect_type = 'escrow_settle')
                     OR (operation.kind = 'refund' AND effect.effect_type = 'escrow_refund')
                   )
                   AND effect.state = 'confirmed'
              )`,
          [row.quote_id],
        );
        await client.query(
          `UPDATE money_operations operation
              SET state = 'queued', failure_code = NULL, updated_at = NOW(), version = version + 1
            WHERE operation.state = 'review'
              AND operation.quote_snapshot->>'quoteId' = $1
              AND EXISTS (
                SELECT 1 FROM external_effects effect
                 WHERE effect.operation_id = operation.id
                   AND (
                     (operation.kind = 'wager_reserve' AND effect.effect_type = 'escrow_create')
                     OR (operation.kind = 'wager_settlement' AND effect.effect_type = 'escrow_settle')
                     OR (operation.kind = 'refund' AND effect.effect_type = 'escrow_refund')
                   )
                   AND effect.state IN ('queued', 'retry')
                   AND effect.request_payload <> '{"redacted":true}'::jsonb
              )`,
          [row.quote_id],
        );
        const unresolved = await client.query<{ unresolved: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM money_operations operation
              WHERE operation.quote_snapshot->>'quoteId' = $1
                AND operation.state = 'review'
           ) AS unresolved`,
          [row.quote_id],
        );
        recoveryIncomplete = unresolved.rows[0]?.unresolved === true;
        if (recoveryIncomplete) {
          await client.query(
            `UPDATE legacy_escrow_reserve_reconciliations
                SET state = 'manual_reconstruction_required',
                    reason_code = 'legacy_operation_recovery_incomplete',
                    updated_at = NOW()
              WHERE quote_id = $1`,
            [row.quote_id],
          );
        } else {
          await client.query(
            `UPDATE cash_game_quotes
                SET state = CASE
                      WHEN pre_review_state IN ('reserving', 'active', 'settlement_pending', 'expired') THEN pre_review_state
                      ELSE CASE WHEN (
                        SELECT COUNT(*) FROM cash_game_reserves
                         WHERE quote_id = cash_game_quotes.id AND state = 'final'
                      ) = 2 THEN 'active' ELSE 'reserving' END
                    END,
                    funding_deadline = COALESCE(pre_review_funded_start_deadline, funding_deadline),
                    review_reason = NULL, review_deadline = NULL,
                    resolution_state = 'none', resolution_reason = NULL,
                    version = version + 1
              WHERE id = $1 AND state = 'review'`,
            [row.quote_id],
          );
        }
      }
      await client.query("COMMIT");
      if (recoveryIncomplete) manual++;
      else reconciled++;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && [
        "LEGACY_RESERVE_OPERATION_MISSING",
        "LEGACY_RESERVE_EVIDENCE_CONFLICT",
      ].includes(error.message)) {
        await recordLegacyReserveReconciliation(
          row.quote_id,
          row.principal,
          "manual_reconstruction_required",
          error.message.toLowerCase(),
          leaseOwner,
        );
        manual++;
      } else {
        pending++;
      }
    } finally {
      client.release();
    }
  }
  return { reconciled, pending, manual };
}

export async function enqueueDueCashRefunds(limit = 100): Promise<number> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE cash_game_quotes
          SET state = 'expired', version = version + 1
        WHERE state IN ('offered', 'accepted') AND expires_at <= NOW()`,
    );
    await client.query(
      `UPDATE cash_game_quotes quote
          SET state = 'review', review_reason = 'escrow_reconciliation',
              review_deadline = $1, recovery_round = recovery_round + 1,
              resolution_state = 'none', resolution_reason = 'escrow_reconciliation',
              version = version + 1
        FROM money_operations operation
       WHERE quote.state = 'reserving'
         AND quote.funding_deadline IS NULL
         AND operation.client_idempotency_key = 'cash-quote:' || quote.id
         AND operation.state = 'failed'`,
      [reviewDeadline()],
    );
    await client.query(
      `UPDATE cash_game_quotes
          SET state = 'review', review_reason = 'funded_no_show',
              review_deadline = $1, recovery_round = recovery_round + 1,
              resolution_state = 'none', resolution_reason = 'funded_no_show',
              version = version + 1
        WHERE state = 'active'
          AND funded_start_deadline IS NOT NULL
          AND funded_start_deadline <= NOW()`,
      [reviewDeadline()],
    );
    await client.query(
      `UPDATE cash_game_quotes
          SET resolution_state = 'operator_resolution_required',
              resolution_reason = 'review_deadline_elapsed', version = version + 1
        WHERE state = 'review'
          AND review_deadline IS NOT NULL
          AND review_deadline <= NOW()
          AND resolution_state = 'none'`,
    );
    if (!fundsGate.allows("refund")) {
      await client.query("COMMIT");
      return 0;
    }
    const due = await client.query(
      `SELECT * FROM cash_game_quotes
        WHERE state = 'reserving'
          AND funding_deadline IS NOT NULL
          AND funding_deadline <= NOW()
        ORDER BY funding_deadline
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 1_000))],
    );
    let enqueued = 0;
    for (const row of due.rows) {
      const refundId = "funding-timeout";
      const operationId = randomUUID();
      const effectId = randomUUID();
      const reason = "funding_timeout";
      const payload = {
        gameId: String(row.game_id),
        quoteId: String(row.id),
        refundId,
        reason,
      };
      const operationSnapshot = {
        ...payload,
        asset: row.asset_snapshot,
        funds: { mode: row.funds_mode, testFunds: row.test_funds },
        quoteHash: row.quote_hash,
        transfer: {
          source: { type: "escrow" }, destination: { type: "participant_reserves" },
          grossMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
          feeMicroUsd: "0", netMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
          balanceEffectMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
        },
      };
      const operation = await client.query(
        `INSERT INTO money_operations
          (id, principal, kind, state, amount_micro_usd, asset_denom,
           request_hash, client_idempotency_key, quote_snapshot)
         VALUES ($1, $2, 'refund', 'queued', NULL, $3, $4, $5, $6)
         ON CONFLICT (principal, client_idempotency_key) DO NOTHING
         RETURNING id`,
        [
          operationId,
          row.player_a,
          row.asset_denom,
          payloadHash(payload),
          `cash-refund:${row.id}:funding-timeout`,
          operationSnapshot,
        ],
      );
      if (operation.rowCount === 1) {
        await client.query(
          `INSERT INTO external_effects
            (id, operation_id, provider, effect_type, state, request_payload,
             request_hash, provider_idempotency_key)
           VALUES ($1, $2, 'settlement_authorizer', 'escrow_refund', 'queued', $3, $4, $5)`,
          [
            effectId,
            operationId,
            payload,
            payloadHash(payload),
            `gammon:${row.game_id}:refund:funding-timeout`,
          ],
        );
        enqueued++;
      }
      await client.query(
        `UPDATE cash_game_quotes
            SET state = 'review', review_reason = 'funding_timeout',
                pre_review_state = state, pre_review_funded_start_deadline = funded_start_deadline,
                review_deadline = $3, recovery_round = recovery_round + 1,
                resolution_state = 'refund', resolution_reason = 'funding_timeout',
                terminal_id = COALESCE(terminal_id, $2), version = version + 1
          WHERE id = $1`,
        [row.id, refundId, reviewDeadline()],
      );
    }
    await client.query("COMMIT");
    return enqueued;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function realityIntervalSeconds(): number {
  return deadlineSeconds("CASH_GAME_REALITY_CHECK_INTERVAL_SECONDS", 60 * 60, 60, 24 * 60 * 60);
}

export async function captureCashGameReviewSnapshot(input: {
  readonly gameId: string;
  readonly reason: GameReviewReason;
  readonly phase: string;
  readonly deadlineAt: Date | null;
  readonly gameRevision: number;
}): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE cash_game_quotes
          SET state = 'review', review_reason = $2, review_deadline = $3,
              pre_review_state = state, pre_review_funded_start_deadline = funded_start_deadline,
              recovery_round = recovery_round + 1, resolution_state = 'none',
              resolution_reason = $2, version = version + 1
        WHERE game_id = $1 AND state = 'active'
        RETURNING id, recovery_round`,
      [input.gameId, input.reason, reviewDeadline()],
    );
    const row = updated.rows[0];
    if (row) {
      await client.query(
        `INSERT INTO cash_game_review_snapshots
          (quote_id, recovery_round, phase, deadline_at, game_revision)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.recovery_round, input.phase, input.deadlineAt, input.gameRevision],
      );
    }
    await client.query("COMMIT");
    return Boolean(row);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cashGameRecoveryState(gameId: string): Promise<{
  readonly phase: string;
  readonly deadlineAt: string | null;
  readonly gameRevision: number;
} | null> {
  const result = await database().query(
    `SELECT snapshot.phase, snapshot.deadline_at, snapshot.game_revision
       FROM cash_game_quotes quote
       JOIN cash_game_review_snapshots snapshot
         ON snapshot.quote_id = quote.id AND snapshot.recovery_round = quote.recovery_round
      WHERE quote.game_id = $1 AND quote.state IN ('review', 'active')`,
    [gameId],
  );
  const row = result.rows[0];
  return row ? {
    phase: String(row.phase),
    deadlineAt: row.deadline_at ? new Date(row.deadline_at as Date).toISOString() : null,
    gameRevision: Number(row.game_revision),
  } : null;
}

export async function markCashGameForReview(gameId: string, reason: GameReviewReason): Promise<boolean> {
  const result = await database().query(
    `UPDATE cash_game_quotes
        SET state = 'review', review_reason = $2, review_deadline = $3,
            pre_review_state = state, pre_review_funded_start_deadline = funded_start_deadline,
            recovery_round = recovery_round + 1, resolution_state = 'none',
            resolution_reason = $2, version = version + 1
      WHERE game_id = $1 AND state = 'active'
      RETURNING id`,
    [gameId, reason, reviewDeadline()],
  );
  if (result.rowCount === 1) return true;
  const existing = await database().query(
    "SELECT state, review_reason FROM cash_game_quotes WHERE game_id = $1",
    [gameId],
  );
  return existing.rows[0]?.state === "review" && existing.rows[0]?.review_reason === reason;
}



export type CashAuthorizerDispatch =
  | { readonly kind: "authorized" }
  | { readonly kind: "entry_denied" }
  | { readonly kind: "recovery_hold" }
  | { readonly kind: "recovery_deferred" };

function hasRecoveryLegalHold(reasonCodes: readonly string[]): boolean {
  return reasonCodes.some((code) => ["sanctions", "sanctions_hold", "fraud", "fraud_hold", "legal_hold"].includes(code));
}

export async function hasCashAuthorizerDispatch(effectId: string, step: "escrow_create" | "escrow_settle" | "escrow_refund"): Promise<boolean> {
  const result = await database().query(
    "SELECT 1 FROM external_effect_dispatches WHERE effect_id = $1 AND step = $2",
    [effectId, step],
  );
  return result.rowCount === 1;
}

/**
 * Fences the lease, locks the sorted participant policies, and durably records
 * authorization before any authorizer HTTP request. The marker is immutable:
 * later retries can safely re-use the original idempotency key without a
 * policy recheck, after first converging against immutable escrow state.
 */
export async function authorizeCashAuthorizerDispatch(input: {
  readonly effectId: string;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly quoteId: string;
  readonly action: "create" | "settle" | "refund";
  readonly recoveryBlockers?: () => readonly string[];
  readonly step: "escrow_create" | "escrow_settle" | "escrow_refund";
}): Promise<CashAuthorizerDispatch> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await fenceEscrowEffect(client, input);
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    const row = found.rows[0];
    if (!row) throw new Error("QUOTE_NOT_FOUND");
    const quote = quoteFromRow(row);
    if (input.action === "create") {
      const decisions = await lockWagerParticipants(
        client,
        [quote.playerA, quote.playerB],
        BigInt(quote.reservePerPlayerMicroUsd),
        quote.id,
      );
      if (quote.state !== "reserving" || decisions.some(({ decision }) => !decision.allowed)) {
        await client.query(
          `UPDATE cash_game_commitments
              SET state = 'released', released_at = NOW()
            WHERE quote_id = $1 AND state = 'pending'`,
          [quote.id],
        );
        await client.query(
          `UPDATE external_effects
              SET state = 'failed', last_error_code = 'escrow_entry_not_allowed',
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1`,
          [input.effectId],
        );
        await client.query(
          `UPDATE money_operations
              SET state = 'failed', failure_code = 'escrow_entry_not_allowed',
                  updated_at = NOW(), version = version + 1
            WHERE id = $1`,
          [input.operationId],
        );
        await client.query(
          `UPDATE cash_game_quotes
              SET state = 'expired', resolution_state = 'refund',
                  resolution_reason = 'escrow_entry_not_allowed', version = version + 1
            WHERE id = $1 AND state IN ('offered', 'accepted', 'reserving')`,
          [quote.id],
        );
        await client.query("COMMIT");
        return { kind: "entry_denied" };
      }
    } else {
      const decisions = await lockRecoveryParticipants(client, [quote.playerA, quote.playerB], input.action);
      if (decisions.some(({ decision }) => hasRecoveryLegalHold(decision.reasonCodes))) {
        await client.query(
          `UPDATE cash_game_quotes
              SET state = 'review', review_reason = 'escrow_reconciliation',
                  review_deadline = $2, resolution_state = 'operator_resolution_required',
                  resolution_reason = 'recovery_hold', version = version + 1
            WHERE id = $1 AND state IN ('reserving', 'active', 'settlement_pending', 'review')`,
          [quote.id, reviewDeadline()],
        );
        await client.query(
          `UPDATE external_effects
              SET state = 'failed', last_error_code = 'escrow_recovery_hold',
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1`,
          [input.effectId],
        );
        await client.query(
          `UPDATE money_operations
              SET state = 'review', failure_code = 'escrow_recovery_hold',
                  updated_at = NOW(), version = version + 1
            WHERE id = $1`,
          [input.operationId],
        );
        await client.query("COMMIT");
        return { kind: "recovery_hold" };
      }
      if (
        decisions.some(({ decision }) => !decision.allowed) ||
        input.recoveryBlockers?.().length
      ) {
        await client.query("COMMIT");
        return { kind: "recovery_deferred" };
      }
    }
    await markEffectDispatchUnderLease(client, {
      effectId: input.effectId,
      operationId: input.operationId,
      leaseToken: input.leaseToken,
      principal: quote.playerA,
      step: input.step,
    });
    await client.query("COMMIT");
    return { kind: "authorized" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A terminal escrow state that is not the immutable command this effect owns
 * cannot be retried safely. Fence the lease, preserve the evidence, and leave
 * the quote in operator review rather than emitting another command.
 */
export async function quarantineCashEscrowEffect(input: {
  readonly effectId: string;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly quoteId: string;
  readonly reason: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await fenceEscrowEffect(client, input);
    await client.query(
      `UPDATE cash_game_quotes
          SET state = 'review', review_reason = 'escrow_reconciliation',
              review_deadline = $2, resolution_state = 'operator_resolution_required',
              resolution_reason = $3, version = version + 1
        WHERE id = $1 AND state IN ('reserving', 'active', 'settlement_pending', 'settled', 'refunded', 'review')`,
      [input.quoteId, reviewDeadline(), input.reason],
    );
    await client.query(
      `UPDATE external_effects
          SET state = 'failed', last_error_code = $2,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.reason],
    );
    await client.query(
      `UPDATE money_operations
          SET state = 'review', failure_code = $2, updated_at = NOW(), version = version + 1
        WHERE id = $1`,
      [input.operationId, input.reason],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function dueRealityInterval(
  client: PoolClient,
  quoteId: string,
  startedAt: Date,
): Promise<number | null> {
  const intervalSeconds = realityIntervalSeconds();
  const elapsed = Math.floor((Date.now() - startedAt.getTime()) / (intervalSeconds * 1_000));
  if (elapsed < 1) return null;
  await client.query(
    `INSERT INTO cash_game_reality_intervals (quote_id, interval_number, due_at)
     SELECT $1, interval_number, $2::timestamptz + interval_number * ($3 * INTERVAL '1 second')
       FROM generate_series(1, $4) AS interval_number
     ON CONFLICT (quote_id, interval_number) DO NOTHING`,
    [quoteId, startedAt, intervalSeconds, elapsed],
  );
  return elapsed;
}

export async function acknowledgeCashRealityCheck(principal: string, quoteId: string): Promise<CashQuote> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [quoteId]);
    const row = found.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(principal)) throw new Error("QUOTE_NOT_FOUND");
    if (row.state !== "active" || !row.cash_session_started_at) throw new Error("CASH_GAME_START_ACK_REQUIRED");
    const interval = await dueRealityInterval(client, quoteId, new Date(row.cash_session_started_at));
    if (interval === null) throw new Error("REALITY_CHECK_NOT_DUE");
    const acknowledged = await client.query<{ acknowledged_at: Date }>(
      `INSERT INTO cash_game_reality_interval_acknowledgements (quote_id, interval_number, principal)
       VALUES ($1, $2, $3)
       ON CONFLICT (quote_id, interval_number, principal) DO NOTHING
       RETURNING acknowledged_at`,
      [quoteId, interval, principal],
    );
    const updated = await client.query(
      `UPDATE cash_game_quotes SET version = version + 1 WHERE id = $1 RETURNING *`,
      [quoteId],
    );
    updated.rows[0].reality_check_acknowledged_at = acknowledged.rows[0]?.acknowledged_at ?? new Date();
    updated.rows[0].acknowledged_reality_interval = interval;
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function requestCashGameResume(principal: string, quoteId: string): Promise<CashQuote> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [quoteId]);
    const row = found.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(principal)) throw new Error("QUOTE_NOT_FOUND");
    if (row.state !== "review" || Number(row.recovery_round) < 1) throw new Error("QUOTE_STATE_CONFLICT");
    await client.query(
      `INSERT INTO cash_game_recovery_consents (quote_id, principal, recovery_round, action)
       VALUES ($1, $2, $3, 'resume')
       ON CONFLICT (quote_id, principal, recovery_round) DO NOTHING`,
      [quoteId, principal, row.recovery_round],
    );
    const consents = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM cash_game_recovery_consents
        WHERE quote_id = $1 AND recovery_round = $2 AND action = 'resume'
          AND principal IN ($3, $4)`,
      [quoteId, row.recovery_round, row.player_a, row.player_b],
    );
    const bothResumed = Number(consents.rows[0]?.count ?? "0") === 2;
    const updated = await client.query(
      `UPDATE cash_game_quotes
          SET state = CASE WHEN $2 THEN COALESCE(pre_review_state, 'active') ELSE state END,
              review_deadline = CASE WHEN $2 THEN NULL ELSE review_deadline END,
              funded_start_deadline = CASE WHEN $2 THEN pre_review_funded_start_deadline ELSE funded_start_deadline END,
              resolution_state = CASE WHEN $2 THEN 'resume' ELSE resolution_state END,
              resolution_reason = CASE WHEN $2 THEN 'participant_resume' ELSE resolution_reason END,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [quoteId, bothResumed],
    );
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeCashGameStart(principal: string, quoteId: string): Promise<CashQuote> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [quoteId]);
    const row = found.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(principal)) throw new Error("QUOTE_NOT_FOUND");
    if (row.state !== "active") throw new Error("CASH_GAME_START_ACK_INVALID");
    const existingAcknowledgement = await client.query(
      "SELECT 1 FROM cash_game_start_acknowledgements WHERE quote_id = $1 AND principal = $2",
      [quoteId, principal],
    );
    if (
      existingAcknowledgement.rowCount === 0 &&
      (!row.funded_start_deadline || new Date(row.funded_start_deadline).getTime() <= Date.now())
    ) throw new Error("CASH_GAME_START_ACK_INVALID");
    if (existingAcknowledgement.rowCount === 0) {
      await client.query(
        "INSERT INTO cash_game_start_acknowledgements (quote_id, principal) VALUES ($1, $2)",
        [quoteId, principal],
      );
    }
    const acknowledgements = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM cash_game_start_acknowledgements
        WHERE quote_id = $1 AND principal IN ($2, $3)`,
      [quoteId, row.player_a, row.player_b],
    );
    const started = Number(acknowledgements.rows[0]?.count ?? "0") === 2;
    const updated = await client.query(
      `UPDATE cash_game_quotes
          SET funded_start_deadline = CASE WHEN $2 THEN NULL ELSE funded_start_deadline END,
              version = version + 1
        WHERE id = $1 RETURNING *`,
      [quoteId, started],
    );
    updated.rows[0].funded_start_acknowledged = true;
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function startCashGameSession(gameId: string): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const quote = await client.query("SELECT * FROM cash_game_quotes WHERE game_id = $1 FOR UPDATE", [gameId]);
    const row = quote.rows[0];
    if (!row || row.state !== "active") throw new Error("CASH_GAME_START_ACK_REQUIRED");
    const acknowledgements = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM cash_game_start_acknowledgements
        WHERE quote_id = $1 AND principal IN ($2, $3)`,
      [row.id, row.player_a, row.player_b],
    );
    const game = await client.query(
      `SELECT 1 FROM games
        WHERE id = $1 AND status = 'playing'
          AND ((player_white = $2 AND player_black = $3) OR (player_white = $3 AND player_black = $2))
        FOR SHARE`,
      [gameId, row.player_a, row.player_b],
    );
    if (Number(acknowledgements.rows[0]?.count ?? "0") !== 2 || game.rowCount !== 1) {
      throw new Error("CASH_GAME_START_ACK_REQUIRED");
    }
    await client.query(
      `UPDATE cash_game_quotes
          SET cash_session_started_at = NOW(), version = version + 1
        WHERE id = $1 AND cash_session_started_at IS NULL`,
      [row.id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cashGameJoinGate(gameId: string, principal: string): Promise<{
  readonly allowed: boolean;
  readonly code: "CASH_GAME_NOT_FUNDED" | "CASH_GAME_START_ACK_REQUIRED" | "CASH_GAME_REVIEW" | null;
}> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const quote = await client.query("SELECT * FROM cash_game_quotes WHERE game_id = $1 FOR UPDATE", [gameId]);
    const row = quote.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(principal)) {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_NOT_FUNDED" };
    }
    if (row.state === "review") {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_REVIEW" };
    }
    if (row.state !== "active") {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_NOT_FUNDED" };
    }
    const acknowledgement = await client.query(
      "SELECT 1 FROM cash_game_start_acknowledgements WHERE quote_id = $1 AND principal = $2",
      [row.id, principal],
    );
    await client.query("COMMIT");
    return acknowledgement.rowCount === 1
      ? { allowed: true, code: null }
      : { allowed: false, code: "CASH_GAME_START_ACK_REQUIRED" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cashGamePlayGate(gameId: string, principal: string): Promise<{
  readonly allowed: boolean;
  readonly code: "CASH_GAME_NOT_FUNDED" | "CASH_GAME_START_ACK_REQUIRED" | "CASH_GAME_REALITY_CHECK_REQUIRED" | "CASH_GAME_REVIEW" | null;
}> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const quote = await client.query("SELECT * FROM cash_game_quotes WHERE game_id = $1 FOR UPDATE", [gameId]);
    const row = quote.rows[0];
    if (!row || ![row.player_a, row.player_b].includes(principal)) {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_NOT_FUNDED" };
    }
    if (row.state === "review") {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_REVIEW" };
    }
    if (row.state !== "active") {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_NOT_FUNDED" };
    }
    const acknowledgements = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM cash_game_start_acknowledgements
        WHERE quote_id = $1 AND principal IN ($2, $3)`,
      [row.id, row.player_a, row.player_b],
    );
    if (Number(acknowledgements.rows[0]?.count ?? "0") !== 2 || !row.cash_session_started_at) {
      await client.query("COMMIT");
      return { allowed: false, code: "CASH_GAME_START_ACK_REQUIRED" };
    }
    const interval = await dueRealityInterval(client, String(row.id), new Date(row.cash_session_started_at));
    if (interval !== null) {
      const acknowledged = await client.query(
        `SELECT 1 FROM cash_game_reality_interval_acknowledgements
          WHERE quote_id = $1 AND interval_number = $2 AND principal = $3`,
        [row.id, interval, principal],
      );
      if (acknowledged.rowCount !== 1) {
        await client.query("COMMIT");
        return { allowed: false, code: "CASH_GAME_REALITY_CHECK_REQUIRED" };
      }
    }
    await client.query("COMMIT");
    return { allowed: true, code: null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordCashRecoveryResolution(client: PoolClient, operatorId: string, quoteId: string, purpose: string): Promise<void> {
  await client.query(
    `INSERT INTO sensitive_access_audit (operator_id, purpose, resource_type, resource_id_hash)
     VALUES ($1, $2, 'cash_game_quote', $3)`,
    [operatorId, purpose, payloadHash({ quoteId })],
  );
}

export async function resolveCashQuoteRefund(input: {
  readonly operatorId: string;
  readonly quoteId: string;
}): Promise<CashQuote> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    const row = found.rows[0];
    if (!row) throw new Error("QUOTE_NOT_FOUND");
    if (row.resolution_state === "refund") {
      await client.query("COMMIT");
      return quoteFromRow(row);
    }
    if (!["reserving", "active", "review"].includes(row.state)) throw new Error("QUOTE_STATE_CONFLICT");
    const reserves = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM cash_game_reserves WHERE quote_id = $1 AND state = 'final'",
      [row.id],
    );
    const reserveCount = Number(reserves.rows[0]?.count ?? "0");
    if (row.state === "active" && reserveCount !== 2) throw new Error("ESCROW_STATE_MISMATCH");
    if (row.state === "reserving" && !row.funding_deadline && reserveCount === 0) {
      const released = await client.query(
        `UPDATE cash_game_commitments SET state = 'released', released_at = NOW()
          WHERE quote_id = $1 AND state = 'pending'`,
        [row.id],
      );
      const updated = await client.query(
        `UPDATE cash_game_quotes
            SET state = 'expired', resolution_state = 'refund',
                resolution_reason = 'escrow_never_created', version = version + 1
          WHERE id = $1 RETURNING *`,
        [row.id],
      );
      if (released.rowCount === 0) throw new Error("ESCROW_STATE_MISMATCH");
      await client.query("COMMIT");
      return quoteFromRow(updated.rows[0]);
    }
    const refundId = randomUUID();
    const operationId = randomUUID();
    const effectId = randomUUID();
    const payload = { gameId: String(row.game_id), quoteId: String(row.id), refundId, reason: "operator_refund" };
    const operationSnapshot = {
      ...payload,
      asset: row.asset_snapshot,
      funds: { mode: row.funds_mode, testFunds: row.test_funds },
      quoteHash: row.quote_hash,
      transfer: {
        source: { type: "escrow" }, destination: { type: "participant_reserves" },
        grossMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
        feeMicroUsd: "0", netMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
        balanceEffectMicroUsd: String(BigInt(row.reserve_per_player_micro_usd) * 2n),
      },
    };
    await client.query(
      `INSERT INTO money_operations
        (id, principal, kind, state, amount_micro_usd, asset_denom, request_hash, client_idempotency_key, quote_snapshot)
       VALUES ($1, $2, 'refund', 'queued', NULL, $3, $4, $5, $6)`,
      [operationId, row.player_a, row.asset_denom, payloadHash(payload), `cash-refund:${row.id}:operator:${row.recovery_round}`, operationSnapshot],
    );
    await client.query(
      `INSERT INTO external_effects
        (id, operation_id, provider, effect_type, state, request_payload, request_hash, provider_idempotency_key)
       VALUES ($1, $2, 'settlement_authorizer', 'escrow_refund', 'queued', $3, $4, $5)`,
      [effectId, operationId, payload, payloadHash(payload), `gammon:${row.game_id}:refund:operator:${row.recovery_round}`],
    );
    const updated = await client.query(
      `UPDATE cash_game_quotes
          SET state = 'review', terminal_id = COALESCE(terminal_id, $2),
              resolution_state = 'refund', resolution_reason = 'operator_refund',
              review_deadline = NULL, version = version + 1
        WHERE id = $1 RETURNING *`,
      [row.id, refundId],
    );
    await recordCashRecoveryResolution(client, input.operatorId, row.id, "cash_game_refund");
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveCashQuoteSettlement(input: {
  readonly operatorId: string;
  readonly quoteId: string;
  readonly winner: string;
  readonly cubeValue: CubeValue;
  readonly resultMultiplier: ResultMultiplier;
  readonly cubeWasTurned: boolean;
}): Promise<CashQuote> {
  const quote = await database().query("SELECT game_id, state FROM cash_game_quotes WHERE id = $1", [input.quoteId]);
  if (!quote.rows[0]) throw new Error("QUOTE_NOT_FOUND");
  if (quote.rows[0].state !== "review") throw new Error("QUOTE_STATE_CONFLICT");
  await requestCashSettlement({
    gameId: String(quote.rows[0].game_id),
    winner: input.winner,
    cubeValue: input.cubeValue,
    resultMultiplier: input.resultMultiplier,
    cubeWasTurned: input.cubeWasTurned,
    allowReviewResolution: true,
    resolutionReason: "operator_adjudication",
  });
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    if (!updated.rows[0]) throw new Error("QUOTE_NOT_FOUND");
    await recordCashRecoveryResolution(client, input.operatorId, input.quoteId, "cash_game_adjudicated_settlement");
    await client.query("COMMIT");
    return quoteFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


export async function requestCashSettlement(input: {
  readonly gameId: string;
  readonly winner: string;
  readonly cubeValue: CubeValue;
  readonly resultMultiplier: ResultMultiplier;
  readonly cubeWasTurned: boolean;
  readonly allowReviewResolution?: boolean;
  readonly resolutionReason?: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cash_game_quotes WHERE game_id = $1 FOR UPDATE", [input.gameId]);
    const row = found.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    if (![row.player_a, row.player_b].includes(input.winner)) throw new Error("INVALID_SETTLEMENT_WINNER");
    if (row.state === "settled" || row.state === "settlement_pending") {
      await client.query("COMMIT");
      return;
    }
    if (row.state !== "active" && !(input.allowReviewResolution && row.state === "review")) {
      throw new Error("QUOTE_STATE_CONFLICT");
    }
    const reserves = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM cash_game_reserves WHERE quote_id = $1 AND state = 'final'",
      [row.id],
    );
    if (Number(reserves.rows[0]?.count ?? "0") !== 2) throw new Error("ESCROW_STATE_MISMATCH");
    const terminalId = randomUUID();
    const operationId = randomUUID();
    const effectId = randomUUID();
    const settlement = settleCashGame(
      BigInt(row.stake_micro_usd),
      input.cubeValue,
      input.resultMultiplier,
      input.cubeWasTurned,
    );
    const payload = {
      cubeValue: input.cubeValue,
      cubeWasTurned: input.cubeWasTurned,
      gameId: input.gameId,
      quoteId: row.id,
      resultMultiplier: input.resultMultiplier,
      settlementId: terminalId,
      winner: input.winner,
    };
    const operationSnapshot = {
      ...payload,
      asset: row.asset_snapshot,
      funds: { mode: row.funds_mode, testFunds: row.test_funds },
      quoteHash: row.quote_hash,
      transfer: {
        source: { type: "escrow" },
        destination: { type: "winner_and_treasury" },
        grossMicroUsd: settlement.liabilityMicroUsd.toString(),
        feeMicroUsd: settlement.rakeMicroUsd.toString(),
        netMicroUsd: settlement.winnerPayoutMicroUsd.toString(),
        balanceEffectMicroUsd: settlement.winnerPayoutMicroUsd.toString(),
      },
    };
    await client.query(
      `INSERT INTO money_operations
        (id, principal, kind, state, amount_micro_usd, asset_denom,
         request_hash, client_idempotency_key, quote_snapshot)
       VALUES ($1, $2, 'wager_settlement', 'queued', $3, $4, $5, $6, $7)`,
      [
        operationId,
        input.winner,
        settlement.liabilityMicroUsd.toString(),
        row.asset_denom,
        payloadHash(payload),
        `cash-settlement:${row.game_id}`,
        operationSnapshot,
      ],
    );
    await client.query(
      `INSERT INTO external_effects
        (id, operation_id, provider, effect_type, state, request_payload,
         request_hash, provider_idempotency_key)
       VALUES ($1, $2, 'settlement_authorizer', 'escrow_settle', 'queued', $3, $4, $5)`,
      [effectId, operationId, payload, payloadHash(payload), `gammon:${row.game_id}:settle`],
    );
    await client.query(
      `UPDATE cash_game_quotes
          SET state = 'settlement_pending', terminal_id = $2, terminal_snapshot = $3,
              resolution_state = CASE WHEN $4 THEN 'adjudicated_settlement' ELSE resolution_state END,
              resolution_reason = CASE WHEN $4 THEN $5 ELSE resolution_reason END,
              review_deadline = CASE WHEN $4 THEN NULL ELSE review_deadline END,
              version = version + 1
        WHERE id = $1`,
      [
        row.id,
        terminalId,
        {
          ...payload,
          settlement: {
            liabilityMicroUsd: settlement.liabilityMicroUsd.toString(),
            loserRefundMicroUsd: settlement.loserRefundMicroUsd.toString(),
            rakeMicroUsd: settlement.rakeMicroUsd.toString(),
            totalDepositedMicroUsd: settlement.totalDepositedMicroUsd.toString(),
            winnerPayoutMicroUsd: settlement.winnerPayoutMicroUsd.toString(),
          },
        },
        input.allowReviewResolution ?? false,
        input.resolutionReason ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileFinishedCashSettlements(): Promise<{
  readonly enqueued: number;
  readonly reviewed: number;
  readonly failed: number;
}> {
  if (!fundsGate.allows("settle")) return { enqueued: 0, reviewed: 0, failed: 0 };
  const result = await database().query<{
    game_id: string;
    player_a: string;
    player_b: string;
    player_white: string | null;
    player_black: string | null;
    game_state: unknown;
  }>(
    `SELECT quote.game_id, quote.player_a, quote.player_b,
            game.player_white, game.player_black, game.game_state
       FROM cash_game_quotes quote
       JOIN games game ON game.id = quote.game_id
      WHERE quote.state = 'active'
        AND game.status IN ('finished', 'abandoned')
      ORDER BY game.finished_at ASC
      LIMIT 100`,
  );
  let enqueued = 0;
  let reviewed = 0;
  let failed = 0;
  for (const row of result.rows) {
    const state = FinishedGameStateSchema.safeParse(row.game_state);
    const winner = state.success
      ? state.data.winner === "white" ? row.player_white : row.player_black
      : null;
    if (
      !state.success ||
      !winner ||
      ![row.player_a, row.player_b].includes(winner) ||
      row.player_white === row.player_black
    ) {
      if (await markCashGameForReview(row.game_id, "escrow_reconciliation")) reviewed++;
      continue;
    }
    try {
      await requestCashSettlement({
        gameId: row.game_id,
        winner,
        cubeValue: state.data.cubeValue,
        resultMultiplier: state.data.resultType === "normal" ? 1 : state.data.resultType === "gammon" ? 2 : 3,
        cubeWasTurned: state.data.cubeValue > 1,
      });
      enqueued++;
    } catch {
      failed++;
    }
  }
  return { enqueued, reviewed, failed };
}

interface EscrowFinalityAttestation {
  readonly transactionHeight: number;
  readonly finalityBlockHash: string;
  readonly source: "transaction" | "finalized_state";
  readonly receipt: Record<string, unknown> | null;
  readonly authorizerKeyId: string;
  readonly terminalId: string | null;
}

async function fenceEscrowEffect(
  client: PoolClient,
  input: { readonly effectId: string; readonly operationId: string; readonly leaseToken: string },
): Promise<void> {
  const effect = await client.query(
    `SELECT state, lease_owner, lease_expires_at
       FROM external_effects
      WHERE id = $1 AND operation_id = $2
      FOR UPDATE`,
    [input.effectId, input.operationId],
  );
  if (
    effect.rows[0]?.state !== "leased" ||
    effect.rows[0]?.lease_owner !== input.leaseToken ||
    !effect.rows[0]?.lease_expires_at ||
    new Date(effect.rows[0].lease_expires_at as Date).getTime() <= Date.now()
  ) throw new Error("EFFECT_LEASE_LOST");
  const operation = await client.query(
    "SELECT id FROM money_operations WHERE id = $1 FOR UPDATE",
    [input.operationId],
  );
  if (!operation.rows[0]) throw new Error("OPERATION_NOT_FOUND");
}

async function persistEscrowEffectAttestation(
  client: PoolClient,
  input: {
    readonly effectId: string;
    readonly quoteId: string;
    readonly effectType: "escrow_create" | "escrow_settle" | "escrow_refund";
    readonly gameId: string;
    readonly txHash: string | null;
    readonly attestation: EscrowFinalityAttestation;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO cash_game_effect_attestations
      (effect_id, quote_id, effect_type, game_id, terminal_id, transaction_hash,
       transaction_height, finality_block_hash, attestation_source, authorizer_key_id, receipt_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.effectId, input.quoteId, input.effectType, input.gameId, input.attestation.terminalId,
      input.txHash, input.attestation.transactionHeight, input.attestation.finalityBlockHash,
      input.attestation.source, input.attestation.authorizerKeyId, input.attestation.receipt,
    ],
  );
}

async function confirmEscrowEffect(
  client: PoolClient,
  input: {
    readonly effectId: string;
    readonly operationId: string;
    readonly txHash: string | null;
    readonly attestation: EscrowFinalityAttestation;
  },
): Promise<void> {
  await client.query(
    `UPDATE external_effects
        SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
            response_payload = jsonb_build_object(
              'attestationSource', $3::text, 'chainTxHash', $2, 'finalityBlockHash', $4::text,
              'transactionHeight', $5::bigint, 'terminalId', $6::text, 'authorizerKeyId', $7::text, 'receipt', $8::jsonb
            ),
            lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [
      input.effectId, input.txHash, input.attestation.source, input.attestation.finalityBlockHash,
      input.attestation.transactionHeight, input.attestation.terminalId,
      input.attestation.authorizerKeyId, input.attestation.receipt,
    ],
  );
  await client.query(
    `UPDATE money_operations
        SET state = 'complete', chain_tx_hash = COALESCE(chain_tx_hash, $2), updated_at = NOW(), version = version + 1
      WHERE id = $1`,
    [input.operationId, input.txHash],
  );
}

export async function markEscrowCreated(input: {
  readonly effectId: string;
  readonly operationId: string;
  readonly quoteId: string;
  readonly leaseToken: string;
  readonly txHash: string | null;
  readonly fundingDeadline: Date;
  readonly gameId: string;
  readonly attestation: EscrowFinalityAttestation;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await fenceEscrowEffect(client, input);
    const quote = await client.query("SELECT id FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    if (!quote.rows[0]) throw new Error("QUOTE_NOT_FOUND");
    await persistEscrowEffectAttestation(client, { ...input, effectType: "escrow_create" });
    await confirmEscrowEffect(client, input);
    await client.query(
      "UPDATE cash_game_quotes SET funding_deadline = $2, version = version + 1 WHERE id = $1",
      [input.quoteId, input.fundingDeadline],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function appendReserveReversalEvidence(
  client: PoolClient,
  input: {
    readonly quoteId: string;
    readonly operationId: string;
    readonly assetDenom: string;
    readonly entryPrefix: string;
    readonly requiredReserveCount: 0 | 2;
  },
): Promise<void> {
  const reserves = await client.query<{ principal: string; amount_micro_usd: string; reserve_journal_batch_id: string | null }>(
    `SELECT principal, amount_micro_usd, reserve_journal_batch_id
       FROM cash_game_reserves
      WHERE quote_id = $1 AND state = 'final'
      ORDER BY principal
      FOR UPDATE`,
    [input.quoteId],
  );
  if (
    reserves.rows.length < input.requiredReserveCount ||
    reserves.rows.some((reserve) => !reserve.reserve_journal_batch_id)
  ) {
    throw new Error("CASH_RESERVE_EVIDENCE_MISSING");
  }
  for (const reserve of reserves.rows) {
    const batchId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key, reverses_batch_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (operation_id, entry_key) DO NOTHING`,
      [
        batchId, input.operationId, input.assetDenom, `${input.entryPrefix}:${reserve.principal}`,
        reserve.reserve_journal_batch_id,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error("CASH_RESERVE_REVERSAL_CONFLICT");
    await client.query(
      `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
       VALUES ($1, 'escrow_reserve', $2, 'debit', $3),
              ($1, 'player_escrow_available', $2, 'credit', $3)`,
      [batchId, reserve.principal, reserve.amount_micro_usd],
    );
  }
}
async function resolveLegacyManualRequirements(
  client: PoolClient,
  quoteId: string,
  terminalEffectId: string,
  terminalOperationId: string,
  evidenceSnapshot: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO legacy_escrow_manual_reconstruction_resolutions
      (effect_id, resolution_type, evidence_snapshot, resolved_by)
     SELECT requirement.effect_id, 'terminal_custody_recovered', $4, 'system:verified_terminal_effect'
       FROM legacy_escrow_manual_reconstruction_requirements requirement
      WHERE requirement.quote_id = $1
        AND EXISTS (
          SELECT 1
            FROM cash_game_effect_attestations attestation
            JOIN external_effects terminal_effect ON terminal_effect.id = attestation.effect_id
            JOIN money_operations terminal_operation ON terminal_operation.id = terminal_effect.operation_id
           WHERE attestation.quote_id = requirement.quote_id
             AND attestation.effect_id = $2
             AND terminal_effect.operation_id = $3
             AND attestation.receipt_snapshot IS NOT NULL
             AND terminal_effect.state = 'confirmed'
             AND (
               (attestation.effect_type = 'escrow_settle' AND terminal_operation.kind = 'wager_settlement')
               OR (attestation.effect_type = 'escrow_refund' AND terminal_operation.kind = 'refund')
             )
        )
     ON CONFLICT (effect_id) DO NOTHING`,
    [quoteId, terminalEffectId, terminalOperationId, evidenceSnapshot],
  );
}


export async function markCashSettled(input: {
  readonly effectId: string;
  readonly operationId: string;
  readonly quoteId: string;
  readonly leaseToken: string;
  readonly txHash: string | null;
  readonly gameId: string;
  readonly attestation: EscrowFinalityAttestation;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await fenceEscrowEffect(client, input);
    const quote = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    const row = quote.rows[0];
    if (!row) throw new Error("QUOTE_NOT_FOUND");
    await persistEscrowEffectAttestation(client, { ...input, effectType: "escrow_settle" });
    await confirmEscrowEffect(client, input);
    if (row.state !== "settled") {
      await appendReserveReversalEvidence(client, {
        quoteId: input.quoteId,
        operationId: input.operationId,
        assetDenom: row.asset_denom,
        entryPrefix: "settlement_reserve_reversal",
        requiredReserveCount: 2,
      });
      const terminal = SettlementReceiptSchema.parse(row.terminal_snapshot);
      const liability = terminal.settlement.liabilityMicroUsd;
      const rake = terminal.settlement.rakeMicroUsd;
      const batchId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key)
         VALUES ($1, $2, $3, 'settlement')
         ON CONFLICT (operation_id, entry_key) DO NOTHING`,
        [batchId, input.operationId, row.asset_denom],
      );
      if (inserted.rowCount !== 1) throw new Error("SETTLEMENT_EVIDENCE_CONFLICT");
      const loser = terminal.winner === row.player_a ? row.player_b : row.player_a;
      if (rake === "0") {
        await client.query(
          `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
           VALUES ($1, 'player_wager_loss', $2, 'debit', $3),
                  ($1, 'player_wager_win', $4, 'credit', $3)`,
          [batchId, loser, liability, terminal.winner],
        );
      } else {
        await client.query(
          `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
           VALUES ($1, 'player_wager_loss', $2, 'debit', $3),
                  ($1, 'player_wager_win', $4, 'credit', $5),
                  ($1, 'treasury_rake', NULL, 'credit', $6)`,
          [batchId, loser, liability, terminal.winner, (BigInt(liability) - BigInt(rake)).toString(), rake],
        );
      }
      await client.query(
        "UPDATE cash_game_quotes SET state = 'settled', settlement_tx_hash = $2, version = version + 1 WHERE id = $1",
        [input.quoteId, input.txHash],
      );
      await client.query(
        "UPDATE cash_game_reserves SET state = 'settled', updated_at = NOW() WHERE quote_id = $1",
        [input.quoteId],
      );
      await client.query(
        `UPDATE cash_game_commitments SET state = 'settled', released_at = NOW()
          WHERE quote_id = $1 AND state IN ('pending', 'funded')`,
        [input.quoteId],
      );
    }
    await resolveLegacyManualRequirements(
      client,
      input.quoteId,
      input.effectId,
      input.operationId,
      {
        quoteId: input.quoteId,
        recoveryEffectId: input.effectId,
        recoveryOperationId: input.operationId,
        terminalState: "settled",
        transactionHash: input.txHash,
        attestation: input.attestation,
      },
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCashRefunded(input: {
  readonly effectId: string;
  readonly operationId: string;
  readonly quoteId: string;
  readonly leaseToken: string;
  readonly refundId: string;
  readonly reason: string;
  readonly txHash: string | null;
  readonly gameId: string;
  readonly attestation: EscrowFinalityAttestation;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await fenceEscrowEffect(client, input);
    const quote = await client.query("SELECT * FROM cash_game_quotes WHERE id = $1 FOR UPDATE", [input.quoteId]);
    const row = quote.rows[0];
    if (!row) throw new Error("QUOTE_NOT_FOUND");
    if (row.state === "settled") throw new Error("QUOTE_STATE_CONFLICT");
    await persistEscrowEffectAttestation(client, { ...input, effectType: "escrow_refund" });
    await confirmEscrowEffect(client, input);
    if (row.state !== "refunded") {
      await appendReserveReversalEvidence(client, {
        quoteId: input.quoteId,
        operationId: input.operationId,
        assetDenom: row.asset_denom,
        entryPrefix: "refund_reserve_reversal",
        requiredReserveCount: 0,
      });
      await client.query(
        `UPDATE cash_game_quotes
            SET state = 'refunded', terminal_id = $2, terminal_snapshot = $3,
                settlement_tx_hash = $4, version = version + 1
          WHERE id = $1`,
        [
          input.quoteId, input.refundId,
          {
            kind: "refund", gameId: row.game_id, quoteId: row.id, refundId: input.refundId,
            reason: input.reason, refundedAt: new Date().toISOString(),
          },
          input.txHash,
        ],
      );
      await client.query(
        "UPDATE cash_game_reserves SET state = 'refunded', updated_at = NOW() WHERE quote_id = $1",
        [input.quoteId],
      );
      await client.query(
        `UPDATE cash_game_commitments SET state = 'refunded', released_at = NOW()
          WHERE quote_id = $1 AND state IN ('pending', 'funded')`,
        [input.quoteId],
      );
    }
    await resolveLegacyManualRequirements(
      client,
      input.quoteId,
      input.effectId,
      input.operationId,
      {
        quoteId: input.quoteId,
        recoveryEffectId: input.effectId,
        recoveryOperationId: input.operationId,
        terminalState: "refunded",
        transactionHash: input.txHash,
        attestation: input.attestation,
      },
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
