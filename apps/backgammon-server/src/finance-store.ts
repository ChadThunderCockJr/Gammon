import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./db.js";
import { payloadHash, type EncryptedPayload } from "./finance-crypto.js";
import { FundsActionDeniedError, lockFundsAction, lockProviderEntryAction, lockRecoveryAction } from "./action-policy.js";
import { fundsGate } from "./funds-config.js";

const EXTERNAL_EFFECT_LEASE_SECONDS = 120;

export type MoneyOperationKind = "enroll" | "link_bank" | "deposit" | "cash_out" | "wager_reserve" | "wager_settlement" | "refund";
export type MoneyOperationState =
  | "created"
  | "awaiting_user"
  | "queued"
  | "processing"
  | "pending"
  | "complete"
  | "canceled"
  | "failed"
  | "refunding"
  | "refunded"
  | "review";

export interface MoneyOperation {
  readonly id: string;
  readonly principal: string;
  readonly kind: MoneyOperationKind;
  readonly state: MoneyOperationState;
  readonly amountMicroUsd: string | null;
  readonly assetDenom: string | null;
  readonly fundsMode: "free" | "verusd_testnet" | "verusd_production" | "legacy_unverified";
  readonly chainTxHash: string | null;
  readonly testFunds: boolean;
  readonly transfer: {
    readonly source: { readonly type: string };
    readonly destination: { readonly type: string };
    readonly grossMicroUsd: string | null;
    readonly feeMicroUsd: string;
    readonly netMicroUsd: string | null;
    readonly balanceEffectMicroUsd: string | null;
  };
  readonly transitions: readonly {
    readonly sequence: number;
    readonly state: MoneyOperationState;
    readonly occurredAt: string;
    readonly reference: string | null;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface InternalMoneyOperation extends MoneyOperation {
  readonly providerTransferId: string | null;
  readonly quoteSnapshot: Record<string, unknown>;
}
export interface PaymentProfile {
  readonly principal: string;
  readonly providerAccountId: string;
  readonly walletAddress: string;
  readonly externalWalletAddressId: string | null;
  readonly internalAddressId: string | null;
  readonly internalWalletAddress: string | null;
  readonly status: "pending" | "active" | "restricted" | "closed";
}

export interface PaymentMethod {
  readonly id: string;
  readonly principal: string;
  readonly providerAddressId: string;
  readonly state: "pending" | "active" | "relink_required" | "disabled";
  readonly displayLabel: string;
}

export interface ClaimedEffect {
  readonly id: string;
  readonly operationId: string;
  readonly principal: string;
  readonly kind: MoneyOperationKind;
  readonly amountMicroUsd: string | null;
  readonly providerTransferId: string | null;
  readonly effectType: string;
  readonly requestPayload: EncryptedPayload | Record<string, unknown>;
  readonly requestHash: string;
  readonly providerIdempotencyKey: string;
  readonly leaseToken: string;
  readonly attemptCount: number;
}

function database(): pg.Pool {
  const pool = getPool();
  if (!pool) throw new Error("Finance database is unavailable");
  return pool;
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function moneyOperationFromRow(row: Record<string, unknown>): MoneyOperation {
  const snapshot = snapshotRecord(row.quote_snapshot);
  const funds = snapshotRecord(snapshot.funds);
  const tuple = snapshotRecord(snapshot.transfer);
  const source = snapshotRecord(tuple.source ?? snapshot.source);
  const destination = snapshotRecord(tuple.destination ?? snapshot.destination);
  const amountMicroUsd = row.amount_micro_usd === null ? null : String(row.amount_micro_usd);
  const storedTransitions = Array.isArray(row.transitions) ? row.transitions as Array<Record<string, unknown>> : [];
  const transitions = storedTransitions.length > 0
    ? storedTransitions
    : [{ sequence: 1, state: row.state, occurredAt: row.created_at, reference: null }];
  return {
    id: String(row.id),
    principal: String(row.principal),
    kind: row.kind as MoneyOperationKind,
    state: row.state as MoneyOperationState,
    amountMicroUsd,
    assetDenom: row.asset_denom === null ? null : String(row.asset_denom),
    fundsMode: (typeof funds.mode === "string" ? funds.mode : "legacy_unverified") as MoneyOperation["fundsMode"],
    chainTxHash: row.chain_tx_hash === null ? null : String(row.chain_tx_hash),
    testFunds: funds.testFunds === true || typeof funds.mode !== "string",
    transfer: {
      source: { type: typeof source.type === "string" ? source.type : "unverified" },
      destination: { type: typeof destination.type === "string" ? destination.type : "unverified" },
      grossMicroUsd: typeof tuple.grossMicroUsd === "string" ? tuple.grossMicroUsd : amountMicroUsd,
      feeMicroUsd: typeof tuple.feeMicroUsd === "string" ? tuple.feeMicroUsd : "0",
      netMicroUsd: typeof tuple.netMicroUsd === "string" ? tuple.netMicroUsd : amountMicroUsd,
      balanceEffectMicroUsd: typeof tuple.balanceEffectMicroUsd === "string" ? tuple.balanceEffectMicroUsd : null,
    },
    transitions: transitions.map((transition) => ({
      sequence: Number(transition.sequence),
      state: transition.state as MoneyOperationState,
      occurredAt: new Date(String(transition.occurredAt)).toISOString(),
      reference: typeof transition.reference === "string" ? transition.reference : null,
    })),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function operationFromRow(row: Record<string, unknown>): InternalMoneyOperation {
  return {
    ...moneyOperationFromRow(row),
    providerTransferId: row.provider_transfer_id === null ? null : String(row.provider_transfer_id),
    quoteSnapshot: snapshotRecord(row.quote_snapshot),
  };
}

const OPERATION_RECEIPT_COLUMNS = `operation.*,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'sequence', transition.sequence,
      'state', transition.state,
      'occurredAt', transition.occurred_at,
      'reference', transition.reference
    ) ORDER BY transition.sequence)
      FROM money_operation_transitions transition
     WHERE transition.operation_id = operation.id
  ), '[]'::jsonb) AS transitions`;

export async function createMoneyOperation(input: {
  principal: string;
  kind: MoneyOperationKind;
  initialState: MoneyOperationState;
  amountMicroUsd: string | null;
  assetDenom: string | null;
  clientIdempotencyKey: string;
  requestHash: string;
  quoteSnapshot?: Record<string, unknown>;
  consentSnapshot?: Record<string, unknown>;
  unresolvedSingletonKey?: string;
  effect?: {
    type: string;
    encryptedPayload: EncryptedPayload | Record<string, unknown> | ((operationId: string) => EncryptedPayload | Record<string, unknown>);
    requestHash: string;
  };
}): Promise<{ operation: MoneyOperation; created: boolean; reusedSingleton: boolean }> {
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(input.clientIdempotencyKey)) throw new TypeError("Invalid idempotency key");
  if (input.unresolvedSingletonKey && !/^[0-9a-f]{64}$/.test(input.unresolvedSingletonKey)) {
    throw new TypeError("Invalid unresolved operation key");
  }
  const pool = database();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.unresolvedSingletonKey) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`money-operation:${input.principal}:${input.kind}:${input.unresolvedSingletonKey}`],
      );
    }
    const existing = await client.query(
      `SELECT * FROM money_operations
        WHERE principal = $1 AND client_idempotency_key = $2
        FOR UPDATE`,
      [input.principal, input.clientIdempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== input.requestHash) throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
      await client.query("COMMIT");
      return { operation: operationFromRow(existing.rows[0]), created: false, reusedSingleton: false };
    }
    if (input.unresolvedSingletonKey) {
      const unresolved = await client.query(
        `SELECT *
           FROM money_operations
          WHERE principal = $1
            AND kind = $2
            AND state = 'awaiting_user'
            AND quote_snapshot->>'cashOutIntentKey' = $3
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE`,
        [input.principal, input.kind, input.unresolvedSingletonKey],
      );
      if (unresolved.rows[0]) {
        await client.query("COMMIT");
        return { operation: operationFromRow(unresolved.rows[0]), created: false, reusedSingleton: true };
      }
    }
    let actionPolicySnapshot: unknown = null;
    if (input.kind === "deposit" && input.amountMicroUsd !== null) {
      const decision = await lockFundsAction(client, input.principal, "deposit", BigInt(input.amountMicroUsd));
      if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
      if ("policyDecision" in decision && decision.policyDecision !== undefined) {
        actionPolicySnapshot = decision.policyDecision;
      } else {
        actionPolicySnapshot = {
          action: "deposit",
          decisionId: decision.decisionId,
          amountMicroUsd: input.amountMicroUsd,
        };
      }
    }
    if (input.kind === "enroll" || input.kind === "link_bank") {
      const action = input.kind === "enroll" ? "provider_account_create" : "link_bank";
      const decision = await lockProviderEntryAction(client, input.principal, action);
      if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
      actionPolicySnapshot = decision.policyDecision ?? { action, decisionId: decision.decisionId };
    }
    const actionPolicyFields = actionPolicySnapshot
      ? { actionPolicyDecision: actionPolicySnapshot, actionPolicyAmountMicroUsd: input.amountMicroUsd }
      : {};
    const suppliedSnapshot = input.quoteSnapshot ?? {};
    const suppliedTransfer = snapshotRecord(suppliedSnapshot.transfer);
    const defaultSource = input.kind === "deposit" ? "bank_account" : input.kind === "cash_out" ? "verusd_wallet" : "participant_reserve";
    const defaultDestination = input.kind === "deposit" ? "verusd_wallet" : input.kind === "cash_out" ? "bank_account" : "escrow";
    const quoteSnapshot = {
      ...suppliedSnapshot,
      ...actionPolicyFields,
      funds: {
        mode: typeof snapshotRecord(suppliedSnapshot.funds).mode === "string"
          ? snapshotRecord(suppliedSnapshot.funds).mode
          : typeof suppliedSnapshot.fundsMode === "string"
            ? suppliedSnapshot.fundsMode
            : fundsGate.config.mode,
        testFunds: snapshotRecord(suppliedSnapshot.funds).testFunds === true
          || suppliedSnapshot.testFunds === true
          || suppliedSnapshot.fundsMode === "verusd_testnet"
          || fundsGate.config.mode === "verusd_testnet",
      },
      transfer: {
        ...suppliedTransfer,
        source: snapshotRecord(suppliedTransfer.source).type ? suppliedTransfer.source : { type: defaultSource },
        destination: snapshotRecord(suppliedTransfer.destination).type ? suppliedTransfer.destination : { type: defaultDestination },
        grossMicroUsd: typeof suppliedTransfer.grossMicroUsd === "string" ? suppliedTransfer.grossMicroUsd : input.amountMicroUsd,
        feeMicroUsd: typeof suppliedTransfer.feeMicroUsd === "string" ? suppliedTransfer.feeMicroUsd : "0",
        netMicroUsd: typeof suppliedTransfer.netMicroUsd === "string" ? suppliedTransfer.netMicroUsd : input.amountMicroUsd,
        balanceEffectMicroUsd: typeof suppliedTransfer.balanceEffectMicroUsd === "string" ? suppliedTransfer.balanceEffectMicroUsd : null,
      },
    };
    const operationId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO money_operations
        (id, principal, kind, state, amount_micro_usd, asset_denom, request_hash,
         client_idempotency_key, quote_snapshot, consent_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        operationId,
        input.principal,
        input.kind,
        input.initialState,
        input.amountMicroUsd,
        input.assetDenom,
        input.requestHash,
        input.clientIdempotencyKey,
        quoteSnapshot,
        input.consentSnapshot ?? null,
      ],
    );
    if (input.effect) {
      await client.query(
        `INSERT INTO external_effects
          (id, operation_id, provider, effect_type, state, request_payload,
           request_hash, provider_idempotency_key)
         VALUES ($1, $2, 'brale', $3, 'queued', $4, $5, $6)`,
        [
          randomUUID(),
          operationId,
          input.effect.type,
          typeof input.effect.encryptedPayload === "function"
            ? input.effect.encryptedPayload(operationId)
            : input.effect.encryptedPayload,
          input.effect.requestHash,
          `gammon:${operationId}:${input.effect.type}`,
        ],
      );
    }
    await client.query("COMMIT");
    return { operation: operationFromRow(inserted.rows[0]), created: true, reusedSingleton: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface DirectEffectLease {
  readonly operation: MoneyOperation;
  readonly created: boolean;
  readonly status: "claimed" | "in_progress" | "complete";
  readonly effectId: string | null;
  readonly leaseToken: string | null;
  readonly providerIdempotencyKey: string | null;
}

export async function createOrLeaseDirectEffect(input: {
  principal: string;
  kind: "enroll" | "link_bank";
  clientIdempotencyKey: string;
  requestHash: string;
  assetDenom: string | null;
  quoteSnapshot: Record<string, unknown>;
  consentSnapshot: Record<string, unknown>;
  effectType: `direct_${string}`;
  providerIdempotencyKey?: string;
}): Promise<DirectEffectLease> {
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(input.clientIdempotencyKey)) throw new TypeError("Invalid idempotency key");
  const client = await database().connect();
  const leaseToken = `direct:${randomUUID()}`;
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM money_operations
        WHERE principal = $1 AND client_idempotency_key = $2
        FOR UPDATE`,
      [input.principal, input.clientIdempotencyKey],
    );
    let operationRow = existing.rows[0] as Record<string, unknown> | undefined;
    let created = false;
    if (!operationRow) {
      const action = input.kind === "enroll" ? "provider_account_create" : "link_bank";
      const decision = await lockProviderEntryAction(client, input.principal, action);
      if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
      const suppliedTransfer = snapshotRecord(input.quoteSnapshot.transfer);
      const inserted = await client.query(
        `INSERT INTO money_operations
          (id, principal, kind, state, amount_micro_usd, asset_denom, request_hash,
           client_idempotency_key, quote_snapshot, consent_snapshot)
         VALUES ($1, $2, $3, 'created', NULL, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          randomUUID(),
          input.principal,
          input.kind,
          input.assetDenom,
          input.requestHash,
          input.clientIdempotencyKey,
          {
            ...input.quoteSnapshot,
            actionPolicyDecision: decision.policyDecision ?? { action, decisionId: decision.decisionId },
            actionPolicyAmountMicroUsd: null,
            funds: {
              mode: fundsGate.config.mode,
              testFunds: fundsGate.config.mode === "verusd_testnet",
            },
            transfer: {
              ...suppliedTransfer,
              source: snapshotRecord(suppliedTransfer.source).type ? suppliedTransfer.source : { type: "participant_reserve" },
              destination: snapshotRecord(suppliedTransfer.destination).type ? suppliedTransfer.destination : { type: "escrow" },
              grossMicroUsd: null,
              feeMicroUsd: "0",
              netMicroUsd: null,
              balanceEffectMicroUsd: null,
            },
          },
          input.consentSnapshot,
        ],
      );
      const insertedOperation = inserted.rows[0] as Record<string, unknown> | undefined;
      if (!insertedOperation) throw new Error("DIRECT_OPERATION_CREATE_FAILED");
      operationRow = insertedOperation;
      created = true;
      await client.query(
        `INSERT INTO external_effects
          (id, operation_id, provider, effect_type, state, request_payload,
           request_hash, provider_idempotency_key, lease_owner, lease_expires_at, attempt_count)
         VALUES ($1, $2, 'brale', $3, 'leased', '{"redacted":true}'::jsonb, $4, $5, $6,
                 NOW() + ($7 * INTERVAL '1 second'), 1)`,
        [
          randomUUID(),
          operationRow.id,
          input.effectType,
          input.requestHash,
          input.providerIdempotencyKey ?? `gammon:${operationRow.id}:${input.effectType}`,
          leaseToken,
          EXTERNAL_EFFECT_LEASE_SECONDS,
        ],
      );
    } else if (operationRow.request_hash !== input.requestHash || operationRow.kind !== input.kind) {
      throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH");
    }
    if (!operationRow) throw new Error("DIRECT_OPERATION_MISSING");
    const effect = await client.query(
      `SELECT id, state, effect_type, lease_expires_at, next_attempt_at, provider_idempotency_key
         FROM external_effects
        WHERE operation_id = $1 AND effect_type = $2
        FOR UPDATE`,
      [operationRow.id, input.effectType],
    );
    const effectRow = effect.rows[0] as Record<string, unknown> | undefined;
    if (!effectRow) throw new Error("DIRECT_EFFECT_MISSING");
    if (created) {
      await client.query("COMMIT");
      return {
        operation: operationFromRow(operationRow),
        created: true,
        status: "claimed",
        effectId: String(effectRow.id),
        leaseToken,
        providerIdempotencyKey: String(effectRow.provider_idempotency_key),
      };
    }
    if (effectRow.state === "confirmed" || effectRow.state === "failed") {
      await client.query("COMMIT");
      return {
        operation: operationFromRow(operationRow),
        created,
        status: "complete",
        effectId: null,
        leaseToken: null,
        providerIdempotencyKey: null,
      };
    }
    const expiresAt = effectRow.lease_expires_at ? new Date(String(effectRow.lease_expires_at)).getTime() : 0;
    const nextAttemptAt = effectRow.next_attempt_at ? new Date(String(effectRow.next_attempt_at)).getTime() : 0;
    if (effectRow.state === "leased" && expiresAt > Date.now()) {
      await client.query("COMMIT");
      return {
        operation: operationFromRow(operationRow),
        created,
        status: "in_progress",
        effectId: null,
        leaseToken: null,
        providerIdempotencyKey: null,
      };
    }
    if (
      effectRow.state === "ambiguous" &&
      effectRow.effect_type === "direct_account" &&
      nextAttemptAt > Date.now()
    ) {
      await client.query("COMMIT");
      return {
        operation: operationFromRow(operationRow),
        created,
        status: "in_progress",
        effectId: null,
        leaseToken: null,
        providerIdempotencyKey: null,
      };
    }
    const claimed = await client.query(
      `UPDATE external_effects
          SET state = 'leased', lease_owner = $2,
              lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
              attempt_count = attempt_count + 1, updated_at = NOW()
        WHERE id = $1
          AND (
            state IN ('queued', 'retry')
            OR (state = 'leased' AND lease_expires_at <= NOW())
            OR (state = 'ambiguous' AND effect_type = 'direct_account' AND next_attempt_at <= NOW())
          )
        RETURNING id, provider_idempotency_key`,
      [effectRow.id, leaseToken, EXTERNAL_EFFECT_LEASE_SECONDS],
    );
    if (claimed.rowCount !== 1) throw new Error("DIRECT_EFFECT_LEASE_CONFLICT");
    await client.query("COMMIT");
    return {
      operation: operationFromRow(operationRow),
      created,
      status: "claimed",
      effectId: String(claimed.rows[0].id),
      leaseToken,
      providerIdempotencyKey: String(claimed.rows[0].provider_idempotency_key),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function authorizeDirectEffectDispatch(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  principal: string;
  step: "direct_account" | "direct_link_token" | "direct_register_bank";
  action: "provider_account_create" | "link_bank";
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const direct = await client.query(
      "SELECT effect_type FROM external_effects WHERE id = $1 AND operation_id = $2 FOR KEY SHARE",
      [input.effectId, input.operationId],
    );
    if (direct.rows[0]?.effect_type !== input.step) throw new Error("DIRECT_DISPATCH_STEP_MISMATCH");
    const existing = await client.query(
      "SELECT 1 FROM external_effect_dispatches WHERE effect_id = $1 AND step = $2 FOR KEY SHARE",
      [input.effectId, input.step],
    );
    if (existing.rowCount === 0) {
      const decision = await lockProviderEntryAction(client, input.principal, input.action);
      if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
      await markEffectDispatchUnderLease(client, input);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeDirectEffect(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  operationState: "awaiting_user" | "queued" | "complete";
  providerReference?: string;
  continuation?: {
    effectType: "enroll";
    encryptedPayload: EncryptedPayload | Record<string, unknown>;
    requestHash: string;
  };
  paymentMethod?: {
    id: string;
    principal: string;
    providerAddressId: string;
    displayLabel: string;
  };
}): Promise<MoneyOperation> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const dispatch = await client.query(
      "SELECT 1 FROM external_effect_dispatches WHERE effect_id = $1 AND step LIKE 'direct\\_%' ESCAPE '\\' FOR KEY SHARE",
      [input.effectId],
    );
    if (dispatch.rowCount !== 1) throw new Error("DIRECT_DISPATCH_NOT_AUTHORIZED");
    const operation = await client.query(
      "SELECT * FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const row = operation.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("DIRECT_OPERATION_MISSING");
    const currentState = row.state as MoneyOperationState;
    if (!(LEGAL_PROVIDER_TRANSITIONS[currentState] ?? []).includes(input.operationState)) {
      throw new Error(`Illegal provider state transition ${currentState} -> ${input.operationState}`);
    }
    if (input.paymentMethod) {
      const method = await client.query(
        `INSERT INTO payment_methods
          (id, principal, provider_address_id, kind, state, display_label)
         VALUES ($1, $2, $3, 'bank', 'pending', $4)
         ON CONFLICT (provider_address_id) DO UPDATE SET
           display_label = EXCLUDED.display_label, updated_at = NOW()
         WHERE payment_methods.principal = EXCLUDED.principal
         RETURNING id`,
        [
          input.paymentMethod.id,
          input.paymentMethod.principal,
          input.paymentMethod.providerAddressId,
          input.paymentMethod.displayLabel,
        ],
      );
      if (method.rowCount !== 1 || method.rows[0].id !== input.paymentMethod.id) {
        throw new Error("PAYMENT_METHOD_OWNERSHIP_CONFLICT");
      }
    }
    if (input.continuation) {
      await client.query(
        `INSERT INTO external_effects
          (id, operation_id, provider, effect_type, state, request_payload,
           request_hash, provider_idempotency_key)
         VALUES ($1, $2, 'brale', $3, 'queued', $4, $5, $6)
         ON CONFLICT (operation_id, effect_type) DO NOTHING`,
        [
          randomUUID(),
          input.operationId,
          input.continuation.effectType,
          input.continuation.encryptedPayload,
          input.continuation.requestHash,
          `gammon:${input.operationId}:${input.continuation.effectType}`,
        ],
      );
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference ?? null],
    );
    const updated = await client.query(
      `UPDATE money_operations
          SET state = $2, updated_at = NOW(), version = version + 1
        WHERE id = $1
        RETURNING *`,
      [input.operationId, input.operationState],
    );
    await client.query("COMMIT");
    return operationFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueEffectForOperation(input: {
  principal: string;
  operationId: string;
  expectedState: MoneyOperationState;
  effectType: string;
  encryptedPayload: EncryptedPayload | Record<string, unknown>;
  requestHash: string;
  chainTxHash?: string;
}): Promise<MoneyOperation> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const operation = await client.query(
      "SELECT * FROM money_operations WHERE id = $1 AND principal = $2 FOR UPDATE",
      [input.operationId, input.principal],
    );
    const row = operation.rows[0];
    if (!row) throw new Error("OPERATION_NOT_FOUND");
    if (input.chainTxHash && row.chain_tx_hash && row.chain_tx_hash !== input.chainTxHash) {
      throw new Error("CHAIN_TRANSACTION_MISMATCH");
    }
    if (row.state !== input.expectedState) {
      const existingEffect = await client.query(
        "SELECT id FROM external_effects WHERE operation_id = $1 AND effect_type = $2",
        [input.operationId, input.effectType],
      );
      if (existingEffect.rows[0]) {
        await client.query("COMMIT");
        return operationFromRow(row);
      }
      throw new Error("OPERATION_STATE_CONFLICT");
    }
    await client.query(
      `INSERT INTO external_effects
        (id, operation_id, provider, effect_type, state, request_payload,
         request_hash, provider_idempotency_key)
       VALUES ($1, $2, 'brale', $3, 'queued', $4, $5, $6)`,
      [
        randomUUID(),
        input.operationId,
        input.effectType,
        input.encryptedPayload,
        input.requestHash,
        `gammon:${input.operationId}:${input.effectType}`,
      ],
    );
    const updated = await client.query(
      `UPDATE money_operations
          SET state = 'queued', chain_tx_hash = COALESCE(chain_tx_hash, $2),
              updated_at = NOW(), version = version + 1
        WHERE id = $1 RETURNING *`,
      [input.operationId, input.chainTxHash ?? null],
    );
    await client.query("COMMIT");
    return operationFromRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordCashOutInboundChain(input: {
  operationId: string;
  principal: string;
  assetDenom: string;
  amountMicroUsd: string;
  txHash: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const operation = await client.query<{ state: MoneyOperationState; chain_tx_hash: string | null }>(
      "SELECT state, chain_tx_hash FROM money_operations WHERE id = $1 AND principal = $2 FOR UPDATE",
      [input.operationId, input.principal],
    );
    const current = operation.rows[0];
    if (!current || current.state !== "awaiting_user" || (current.chain_tx_hash && current.chain_tx_hash !== input.txHash)) {
      throw new Error("OPERATION_STATE_CONFLICT");
    }
    await client.query(
      "UPDATE money_operations SET chain_tx_hash = $2, updated_at = NOW(), version = version + 1 WHERE id = $1",
      [input.operationId, input.txHash],
    );
    const batchId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key)
       VALUES ($1, $2, $3, 'chain_inbound')
       ON CONFLICT (operation_id, entry_key) DO NOTHING`,
      [batchId, input.operationId, input.assetDenom],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
         VALUES ($1, 'player_chain_observed', $2, 'debit', $3),
                ($1, 'provider_clearing', $2, 'credit', $3)`,
        [batchId, input.principal, input.amountMicroUsd],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505"
    ) {
      throw new Error("CHAIN_TRANSACTION_MISMATCH");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getOperation(principal: string, operationId: string): Promise<MoneyOperation | null> {
  const result = await database().query(
    `SELECT ${OPERATION_RECEIPT_COLUMNS}
       FROM money_operations operation WHERE operation.id = $1 AND operation.principal = $2`,
    [operationId, principal],
  );
  return result.rows[0] ? moneyOperationFromRow(result.rows[0]) : null;
}

export async function listOperations(principal: string, limit = 50): Promise<MoneyOperation[]> {
  const result = await database().query(
    `SELECT ${OPERATION_RECEIPT_COLUMNS}
       FROM money_operations operation WHERE operation.principal = $1
      ORDER BY operation.created_at DESC LIMIT $2`,
    [principal, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows.map(moneyOperationFromRow);
}

export async function getOperationResult(principal: string, operationId: string): Promise<unknown | null> {
  const result = await database().query(
    `SELECT e.response_payload
       FROM external_effects e
       JOIN money_operations o ON o.id = e.operation_id
      WHERE o.id = $1 AND o.principal = $2`,
    [operationId, principal],
  );
  return result.rows[0]?.response_payload ?? null;
}

export async function claimNextEffect(workerId: string): Promise<ClaimedEffect | null> {
  const client = await database().connect();
  const leaseToken = `${workerId}:${randomUUID()}`;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE external_effects
          SET state = 'failed',
              last_error_code = 'late_reconciliation_attempt_exhausted',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
        WHERE effect_type LIKE 'reconcile_transfer:%'
          AND request_payload->>'reactivateAfterHorizon' = 'true'
          AND attempt_count > 0
          AND (
            state IN ('queued', 'retry', 'ambiguous')
            OR (state = 'leased' AND lease_expires_at < NOW())
          )`,
    );
    await client.query(
      `UPDATE external_effects effect
          SET state = 'failed',
              request_payload = '{"redacted":true}'::jsonb,
              last_error_code = 'escrow_quote_ineligible',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
         FROM money_operations operation
        WHERE effect.operation_id = operation.id
          AND effect.effect_type IN ('escrow_create', 'escrow_settle', 'escrow_refund')
          AND effect.state IN ('queued', 'retry', 'ambiguous', 'leased')
          AND (effect.state <> 'leased' OR effect.lease_expires_at < NOW())
          AND NOT EXISTS (
            SELECT 1 FROM external_effect_dispatches dispatch
             WHERE dispatch.effect_id = effect.id AND dispatch.step = effect.effect_type
          )
          AND NOT EXISTS (
            SELECT 1 FROM legacy_escrow_reserve_reconciliations reconciliation
             WHERE reconciliation.quote_id = operation.quote_snapshot->>'quoteId'
               AND reconciliation.state <> 'reconciled'
          )
          AND NOT EXISTS (
            SELECT 1 FROM legacy_escrow_manual_reconstruction_requirements requirement
             WHERE requirement.quote_id = operation.quote_snapshot->>'quoteId'
               AND NOT EXISTS (
                 SELECT 1 FROM legacy_escrow_manual_reconstruction_resolutions resolution
                  WHERE resolution.effect_id = requirement.effect_id
               )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM cash_game_quotes quote
               WHERE quote.id = effect.request_payload->>'quoteId'
            )
            OR EXISTS (
              SELECT 1 FROM cash_game_quotes quote
               WHERE quote.id = effect.request_payload->>'quoteId'
                 AND (
                   (effect.effect_type = 'escrow_create' AND quote.state <> 'reserving')
                   OR (effect.effect_type = 'escrow_settle' AND quote.state <> 'settlement_pending')
                   OR (
                     effect.effect_type = 'escrow_refund'
                     AND NOT (quote.state IN ('review', 'expired') AND quote.resolution_state = 'refund')
                   )
                 )
            )
          )`,
    );
    const configuredReturnHorizon = configuredReturnReconciliationHorizon();
    const result = await client.query(
      `SELECT e.id, e.operation_id, e.effect_type, e.request_payload, e.request_hash,
              e.provider_idempotency_key, e.attempt_count, o.principal, o.kind,
              o.amount_micro_usd, o.provider_transfer_id
         FROM external_effects e
         JOIN money_operations o ON o.id = e.operation_id
        WHERE e.effect_type NOT LIKE 'direct\\_%' ESCAPE '\\'
          AND (
            e.effect_type NOT LIKE 'reconcile_transfer:%'
            OR (
              e.request_payload->>'reactivateAfterHorizon' = 'true'
              AND e.attempt_count = 0
            )
            OR EXISTS (
              SELECT 1
                FROM provider_transfer_reconciliation_requests request
               WHERE request.operation_id = e.operation_id
                 AND request.provider_transfer_id = e.request_payload->>'providerTransferId'
                 AND (
                   ${transferReconciliationHasActiveWorkSql("o", "request")}
                   OR ${transferReconciliationDeadlineSql("o", "e.request_payload->>'providerTransferId'", "$1")} > NOW()
                 )
            )
          )
          AND (
            (e.state IN ('queued', 'retry', 'ambiguous')
             AND e.next_attempt_at <= NOW()
             AND (e.lease_expires_at IS NULL OR e.lease_expires_at < NOW()))
            OR (e.state = 'leased' AND e.lease_expires_at < NOW())
          )
        ORDER BY e.created_at
        FOR UPDATE OF e SKIP LOCKED
        LIMIT 1`,
      [configuredReturnHorizon],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const claimed = await client.query(
      `UPDATE external_effects
          SET state = 'leased', lease_owner = $2,
              lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
              attempt_count = attempt_count + 1, updated_at = NOW()
        WHERE id = $1
          AND (
            (state IN ('queued', 'retry', 'ambiguous') AND next_attempt_at <= NOW()
             AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
            OR (state = 'leased' AND lease_expires_at < NOW())
          )
        RETURNING id`,
      [row.id, leaseToken, EXTERNAL_EFFECT_LEASE_SECONDS],
    );
    if (claimed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE money_operations SET state = 'processing', updated_at = NOW(), version = version + 1
        WHERE id = $1
          AND state IN ('created', 'queued', 'pending', 'review')
          AND ($2 NOT IN ('escrow_create', 'escrow_settle', 'escrow_refund') OR state <> 'review')`,
      [row.operation_id, row.effect_type],
    );
    await client.query("COMMIT");
    return {
      id: row.id,
      operationId: row.operation_id,
      principal: row.principal,
      kind: row.kind,
      amountMicroUsd: row.amount_micro_usd === null ? null : String(row.amount_micro_usd),
      providerTransferId: row.provider_transfer_id === null ? null : String(row.provider_transfer_id),
      effectType: row.effect_type,
      requestPayload: row.request_payload,
      requestHash: row.request_hash,
      providerIdempotencyKey: row.provider_idempotency_key,
      leaseToken,
      attemptCount: Number(row.attempt_count) + 1,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requireLease(
  client: pg.PoolClient,
  effectId: string,
  operationId: string,
  leaseToken: string,
): Promise<void> {
  const effect = await client.query(
    `SELECT state, lease_owner, lease_expires_at FROM external_effects
      WHERE id = $1 AND operation_id = $2 FOR UPDATE`,
    [effectId, operationId],
  );
  if (
    effect.rows[0]?.state !== "leased" ||
    effect.rows[0]?.lease_owner !== leaseToken ||
    !effect.rows[0]?.lease_expires_at ||
    new Date(String(effect.rows[0].lease_expires_at)).getTime() <= Date.now()
  ) {
    throw new Error("EFFECT_LEASE_LOST");
  }
}
export async function completeEffect(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  operationState: MoneyOperationState;
  providerReference?: string;
  encryptedResponse?: EncryptedPayload | Record<string, unknown>;
  providerEventId?: string;
  scrubRequestPayload?: boolean;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const operation = await client.query(
      "SELECT state, provider_transfer_id FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const currentState = operation.rows[0]?.state as MoneyOperationState | undefined;
    if (
      !currentState ||
      !(LEGAL_PROVIDER_TRANSITIONS[currentState] ?? []).includes(input.operationState) ||
      (input.providerReference && operation.rows[0]?.provider_transfer_id && operation.rows[0].provider_transfer_id !== input.providerReference)
    ) {
      throw new Error(`Illegal provider state transition ${currentState ?? "missing"} -> ${input.operationState}`);
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              response_payload = COALESCE($3, response_payload),
              request_payload = CASE WHEN $4 THEN '{"redacted":true}'::jsonb ELSE request_payload END,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference ?? null, input.encryptedResponse ?? null, input.scrubRequestPayload ?? false],
    );
    await client.query(
      `UPDATE money_operations
          SET state = $2, provider_transfer_id = COALESCE(provider_transfer_id, $3),
              updated_at = NOW(), version = version + 1
        WHERE id = $1`,
      [input.operationId, input.operationState, input.providerReference ?? null],
    );
    if (input.providerReference) {
      await client.query(
        `INSERT INTO provider_state_history (provider_transfer_id, event_id, state)
         SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM provider_state_history
             WHERE provider_transfer_id = $1
             ORDER BY observed_at DESC LIMIT 1
          ) OR (SELECT state FROM provider_state_history
                 WHERE provider_transfer_id = $1 ORDER BY observed_at DESC LIMIT 1) IS DISTINCT FROM $3`,
        [input.providerReference, input.providerEventId ?? `effect:${input.effectId}`, input.operationState],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeTransferEffectWithJournal(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  providerReference: string;
  assetDenom: string;
  principal: string;
  debitAccount: string;
  creditAccount: string;
  amountMicroUsd: string;
  providerEventId?: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const operation = await client.query(
      "SELECT state, provider_transfer_id FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const currentState = operation.rows[0]?.state as MoneyOperationState | undefined;
    if (
      currentState === "complete" &&
      operation.rows[0]?.provider_transfer_id === input.providerReference
    ) {
      await client.query(
        `UPDATE external_effects
            SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
                lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [input.effectId, input.providerReference],
      );
      await client.query("COMMIT");
      return;
    }
    if (
      !currentState ||
      !(LEGAL_PROVIDER_TRANSITIONS[currentState] ?? []).includes("complete") ||
      (operation.rows[0]?.provider_transfer_id && operation.rows[0].provider_transfer_id !== input.providerReference)
    ) {
      throw new Error(`Illegal provider state transition ${currentState ?? "missing"} -> complete`);
    }
    const batchId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key)
       VALUES ($1, $2, $3, 'complete')
       ON CONFLICT (operation_id, entry_key) DO NOTHING`,
      [batchId, input.operationId, input.assetDenom],
    );
    if (inserted.rowCount === 1) {
      await client.query(
        `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
         VALUES ($1, $2, $3, 'debit', $5), ($1, $4, $3, 'credit', $5)`,
        [batchId, input.debitAccount, input.principal, input.creditAccount, input.amountMicroUsd],
      );
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference],
    );
    await client.query(
      `UPDATE money_operations
          SET state = 'complete', provider_transfer_id = COALESCE(provider_transfer_id, $2),
              updated_at = NOW(), version = version + 1
        WHERE id = $1`,
      [input.operationId, input.providerReference],
    );
    await client.query(
      `INSERT INTO provider_state_history (provider_transfer_id, event_id, state)
       SELECT $1, $2, 'complete'
        WHERE NOT EXISTS (
          SELECT 1 FROM provider_state_history WHERE provider_transfer_id = $1
           ORDER BY observed_at DESC LIMIT 1
        ) OR (SELECT state FROM provider_state_history
               WHERE provider_transfer_id = $1 ORDER BY observed_at DESC LIMIT 1) IS DISTINCT FROM 'complete'`,
      [input.providerReference, input.providerEventId ?? `effect:${input.effectId}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function reverseCompletedTransfer(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  providerReference: string;
  providerEventId: string;
  operationState: "canceled" | "failed" | "refunding" | "refunded";
  assetDenom: string;
  principal: string;
  originalDebitAccount: string;
  originalCreditAccount: string;
  amountMicroUsd: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const operation = await client.query<{ state: MoneyOperationState; kind: MoneyOperationKind; chain_tx_hash: string | null }>(
      "SELECT state, kind, chain_tx_hash FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const current = operation.rows[0];
    if (!current) {
      throw new Error("TRANSFER_OPERATION_MISSING");
    }
    if (current.state !== "complete") {
      if (current.state !== input.operationState && current.state !== "refunding" && current.state !== "refunded" && current.state !== "review") {
        throw new Error(`Illegal provider reversal ${current.state} -> ${input.operationState}`);
      }
      if (
        current.kind !== "cash_out" &&
        current.state !== input.operationState &&
        !(LEGAL_PROVIDER_TRANSITIONS[current.state] ?? []).includes(input.operationState)
      ) throw new Error(`Illegal provider reversal ${current.state} -> ${input.operationState}`);
      if (current.kind !== "cash_out" && current.state !== input.operationState) {
        await client.query(
          "UPDATE money_operations SET state = $2, updated_at = NOW(), version = version + 1 WHERE id = $1",
          [input.operationId, input.operationState],
        );
      }
      await client.query(
        `UPDATE external_effects
            SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
                lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [input.effectId, input.providerReference],
      );
      await client.query("COMMIT");
      return;
    }
    if (!(LEGAL_PROVIDER_TRANSITIONS.complete ?? []).includes(input.operationState)) {
      throw new Error(`Illegal provider reversal complete -> ${input.operationState}`);
    }
    const chainRefundRequired = current.kind === "cash_out" && current.chain_tx_hash !== null;
    if (chainRefundRequired) {
      await client.query(
        `INSERT INTO external_effects
          (id, operation_id, provider, effect_type, state, request_payload, request_hash, provider_idempotency_key)
         SELECT $1, operation_id, 'brale', 'cash_out_refund', 'queued', request_payload, request_hash,
                'gammon:' || operation_id || ':cash_out_refund'
           FROM external_effects
          WHERE operation_id = $2 AND effect_type = 'create_cash_out'
         ON CONFLICT (operation_id, effect_type) DO NOTHING`,
        [randomUUID(), input.operationId],
      );
    } else {
      const complete = await client.query<{ id: string }>(
        "SELECT id FROM journal_batches WHERE operation_id = $1 AND entry_key = 'complete' FOR KEY SHARE",
        [input.operationId],
      );
      if (!complete.rows[0]) throw new Error("TRANSFER_COMPLETE_JOURNAL_MISSING");
      const batchId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key, reverses_batch_id)
         VALUES ($1, $2, $3, 'reversal', $4)
         ON CONFLICT (operation_id, entry_key) DO NOTHING`,
        [batchId, input.operationId, input.assetDenom, complete.rows[0].id],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
           VALUES ($1, $2, $3, 'credit', $5), ($1, $4, $3, 'debit', $5)`,
          [batchId, input.originalDebitAccount, input.principal, input.originalCreditAccount, input.amountMicroUsd],
        );
      }
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference],
    );
    await client.query(
      "UPDATE money_operations SET state = $2, updated_at = NOW(), version = version + 1 WHERE id = $1",
      [input.operationId, chainRefundRequired ? "refunding" : input.operationState],
    );
    await client.query(
      `INSERT INTO provider_state_history (provider_transfer_id, event_id, state)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM provider_state_history WHERE provider_transfer_id = $1
           ORDER BY observed_at DESC LIMIT 1
        ) OR (SELECT state FROM provider_state_history
               WHERE provider_transfer_id = $1 ORDER BY observed_at DESC LIMIT 1) IS DISTINCT FROM $3`,
      [input.providerReference, input.providerEventId, input.operationState],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function confirmReconciliationObservation(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    await client.query(
      "UPDATE external_effects SET state = 'confirmed', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = $1",
      [input.effectId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function reviewCashOutRefund(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  providerReference: string;
  failureCode: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              last_error_code = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference, input.failureCode],
    );
    await client.query(
      `UPDATE money_operations
          SET state = 'review', failure_code = $2, updated_at = NOW(), version = version + 1
        WHERE id = $1 AND state = 'refunding'`,
      [input.operationId, input.failureCode],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reviewLateOriginalCashOutCompletion(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  providerReference: string;
  failureCode: string;
}): Promise<void> {
  const client = await database().connect();
  const failureCode = "late_original_cash_out_complete_after_refund_requires_compensation";
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const operation = await client.query<{
      state: MoneyOperationState;
      kind: MoneyOperationKind;
      amount_micro_usd: string | null;
    }>(
      "SELECT state, kind, amount_micro_usd::text FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const current = operation.rows[0];
    if (!current || current.kind !== "cash_out" || !current.amount_micro_usd) {
      throw new Error("LATE_ORIGINAL_COMPLETION_NOT_CASH_OUT");
    }
    if (current.state === "review") {
      const existing = await client.query<{
        effect_id: string;
        provider_transfer_id: string;
        held_micro_usd: string;
      }>(
        `SELECT effect_id, provider_transfer_id, held_micro_usd::text
           FROM late_cash_out_completion_reviews
          WHERE operation_id = $1 FOR KEY SHARE`,
        [input.operationId],
      );
      const evidence = existing.rows[0];
      if (
        !evidence ||
        evidence.effect_id !== input.effectId ||
        evidence.provider_transfer_id !== input.providerReference ||
        evidence.held_micro_usd !== current.amount_micro_usd
      ) {
        throw new Error("LATE_CASH_OUT_REVIEW_EVIDENCE_MISMATCH");
      }
    } else {
      if (current.state !== "refunded") throw new Error("LATE_ORIGINAL_COMPLETION_NOT_REFUNDED_CASH_OUT");
      await client.query(
        `INSERT INTO late_cash_out_completion_reviews
          (operation_id, effect_id, provider_transfer_id, provider_state, held_micro_usd, compensation_requirement)
         VALUES ($1, $2, $3, 'complete', $4, 'provider_payout_compensation_required_before_chain_funds_reuse')`,
        [input.operationId, input.effectId, input.providerReference, current.amount_micro_usd],
      );
      await client.query(
        `UPDATE money_operations
            SET state = 'review', failure_code = $2, updated_at = NOW(), version = version + 1
          WHERE id = $1`,
        [input.operationId, failureCode],
      );
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              last_error_code = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference, failureCode],
    );
    await client.query(
      `INSERT INTO provider_state_history (provider_transfer_id, event_id, state)
       SELECT $1, $2, 'complete'
        WHERE NOT EXISTS (
          SELECT 1 FROM provider_state_history
           WHERE provider_transfer_id = $1 AND event_id = $2
        )`,
      [input.providerReference, `late_cash_out_review:${input.effectId}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function reviewLateOriginalDepositCompletion(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  providerReference: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const operation = await client.query<{ state: MoneyOperationState; kind: MoneyOperationKind }>(
      "SELECT state, kind FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const current = operation.rows[0];
    if (!current || current.kind !== "deposit") throw new Error("LATE_ORIGINAL_COMPLETION_NOT_DEPOSIT");
    if (current.state === "review") {
      const existing = await client.query<{ provider_transfer_id: string }>(
        "SELECT provider_transfer_id FROM late_deposit_completion_reviews WHERE operation_id = $1 FOR KEY SHARE",
        [input.operationId],
      );
      if (existing.rows[0]?.provider_transfer_id !== input.providerReference) {
        throw new Error("LATE_DEPOSIT_REVIEW_EVIDENCE_MISMATCH");
      }
    } else {
      if (current.state !== "refunded") throw new Error("LATE_ORIGINAL_COMPLETION_NOT_REFUNDED_DEPOSIT");
      await client.query(
        `INSERT INTO late_deposit_completion_reviews
          (operation_id, effect_id, provider_transfer_id, provider_state, compensation_requirement)
         VALUES ($1, $2, $3, 'complete', 'chain_funds_reconciliation_required_before_any_recredit')`,
        [input.operationId, input.effectId, input.providerReference],
      );
      await client.query(
        `UPDATE money_operations
            SET state = 'review',
                failure_code = 'late_original_deposit_complete_after_refund_requires_compensation',
                updated_at = NOW(),
                version = version + 1
          WHERE id = $1`,
        [input.operationId],
      );
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', provider_reference = COALESCE(provider_reference, $2),
              last_error_code = 'late_original_deposit_complete_after_refund_requires_compensation',
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.providerReference],
    );
    await client.query(
      `INSERT INTO provider_state_history (provider_transfer_id, event_id, state)
       SELECT $1, $2, 'complete'
        WHERE NOT EXISTS (
          SELECT 1 FROM provider_state_history
           WHERE provider_transfer_id = $1 AND event_id = $2
        )`,
      [input.providerReference, `late_deposit_review:${input.effectId}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmCashOutRefundChainFinality(input: {
  operationId: string;
  returnedChainTxHash: string;
  confirmedHeight: string;
  effectId?: string;
  leaseToken?: string;
}): Promise<void> {
  if (!/^[0-9A-F]{64}$/.test(input.returnedChainTxHash) || !/^\d+$/.test(input.confirmedHeight)) {
    throw new TypeError("Invalid returned-chain finality evidence");
  }
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    if (input.effectId && input.leaseToken) {
      await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    }
    const operation = await client.query<{
      state: MoneyOperationState;
      kind: MoneyOperationKind;
      asset_denom: string | null;
      principal: string;
      amount_micro_usd: string | null;
    }>(
      `SELECT state, kind, asset_denom, principal, amount_micro_usd
         FROM money_operations WHERE id = $1 FOR UPDATE`,
      [input.operationId],
    );
    const current = operation.rows[0];
    if (
      !current ||
      current.kind !== "cash_out" ||
      current.state !== "refunding" ||
      !current.asset_denom ||
      !current.amount_micro_usd
    ) {
      throw new Error("CASH_OUT_REFUND_NOT_AWAITING_FINALITY");
    }
    const refundEffect = await client.query<{ id: string; state: string; lease_owner: string | null }>(
      `SELECT id, state, lease_owner FROM external_effects
        WHERE operation_id = $1 AND effect_type = 'cash_out_refund'
          AND state IN ('queued', 'retry', 'ambiguous', 'leased', 'confirmed')
        FOR UPDATE`,
      [input.operationId],
    );
    const effect = refundEffect.rows[0];
    if (!effect || (effect.id === input.effectId && effect.state === "leased" && effect.lease_owner !== input.leaseToken)) {
      throw new Error("CASH_OUT_REFUND_PROVIDER_NOT_COMPLETE");
    }
    const returnBatchId = randomUUID();
    const inbound = await client.query<{ id: string }>(
      "SELECT id FROM journal_batches WHERE operation_id = $1 AND entry_key = 'chain_inbound' FOR KEY SHARE",
      [input.operationId],
    );
    if (!inbound.rows[0]) throw new Error("CASH_OUT_INBOUND_JOURNAL_MISSING");
    const returned = await client.query(
      `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key, reverses_batch_id)
       VALUES ($1, $2, $3, 'chain_return', $4)
       ON CONFLICT (operation_id, entry_key) DO NOTHING`,
      [returnBatchId, input.operationId, current.asset_denom, inbound.rows[0].id],
    );
    if (returned.rowCount === 1) {
      await client.query(
        `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
         VALUES ($1, 'provider_clearing', $2, 'debit', $3),
                ($1, 'player_chain_observed', $2, 'credit', $3)`,
        [returnBatchId, current.principal, current.amount_micro_usd],
      );
    }
    const providerComplete = await client.query<{ id: string }>(
      `SELECT id FROM journal_batches
        WHERE operation_id = $1 AND entry_key = 'complete' FOR KEY SHARE`,
      [input.operationId],
    );
    if (providerComplete.rows[0]) {
      const reversalBatchId = randomUUID();
      const reversed = await client.query(
        `INSERT INTO journal_batches (id, operation_id, asset_denom, entry_key, reverses_batch_id)
         VALUES ($1, $2, $3, 'provider_reversal', $4)
         ON CONFLICT (operation_id, entry_key) DO NOTHING`,
        [reversalBatchId, input.operationId, current.asset_denom, providerComplete.rows[0].id],
      );
      if (reversed.rowCount === 1) {
        await client.query(
          `INSERT INTO journal_lines (batch_id, account_code, principal, direction, amount_micro_usd)
           VALUES ($1, 'provider_cash_out_obligation', $2, 'debit', $3),
                  ($1, 'provider_clearing', $2, 'credit', $3)`,
          [reversalBatchId, current.principal, current.amount_micro_usd],
        );
      }
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'confirmed', lease_owner = NULL, lease_expires_at = NULL,
              response_payload = COALESCE(response_payload, '{}'::jsonb) ||
              jsonb_build_object('returnedChainTxHash', $2, 'confirmedHeight', $3)
        WHERE id = $1`,
      [effect.id, input.returnedChainTxHash, input.confirmedHeight],
    );
    if (input.effectId && input.effectId !== effect.id) {
      await client.query(
        "UPDATE external_effects SET state = 'confirmed', lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = $1",
        [input.effectId],
      );
    }
    await client.query(
      "UPDATE money_operations SET state = 'refunded', updated_at = NOW(), version = version + 1 WHERE id = $1",
      [input.operationId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function retryEffect(
  effectId: string,
  operationId: string,
  leaseToken: string,
  errorCode: string,
  ambiguous: boolean,
  attemptCount = 1,
  providerReference?: string,
  scrubRequestPayload = false,
): Promise<void> {
  const backoffSeconds = Math.min(3_600, 5 * (2 ** Math.min(Math.max(attemptCount, 1), 9)));
  const retryDelaySeconds = ambiguous ? Math.max(30, backoffSeconds) : Math.max(10, backoffSeconds);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, effectId, operationId, leaseToken);
    await client.query(
      `UPDATE external_effects
          SET state = CASE
                WHEN request_payload->>'reactivateAfterHorizon' = 'true' THEN 'failed'
                ELSE $2
              END,
              last_error_code = CASE
                WHEN request_payload->>'reactivateAfterHorizon' = 'true' THEN 'late_reconciliation_attempt_exhausted'
                ELSE $3
              END,
              provider_reference = COALESCE(provider_reference, $5),
              request_payload = CASE WHEN $6 THEN '{"redacted":true}'::jsonb ELSE request_payload END,
              lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = NOW() + ($4 * INTERVAL '1 second'), updated_at = NOW()
        WHERE id = $1`,
      [effectId, ambiguous ? "ambiguous" : "retry", errorCode, retryDelaySeconds, providerReference ?? null, scrubRequestPayload],
    );
    await client.query(
      `UPDATE money_operations
          SET state = $2, failure_code = $3, provider_transfer_id = COALESCE(provider_transfer_id, $4),
              updated_at = NOW(), version = version + 1
        WHERE id = $1 AND state NOT IN ('complete', 'refunding', 'refunded')
          AND NOT EXISTS (
            SELECT 1 FROM external_effects effect
             WHERE effect.id = $5
               AND effect.request_payload->>'reactivateAfterHorizon' = 'true'
          )`,
      [operationId, ambiguous ? "review" : "pending", errorCode, providerReference ?? null, effectId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function retryDirectAccountEffect(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  errorCode: "provider_response_ambiguous";
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const effect = await client.query<{ effect_type: string }>(
      "SELECT effect_type FROM external_effects WHERE id = $1 AND operation_id = $2 FOR KEY SHARE",
      [input.effectId, input.operationId],
    );
    if (effect.rows[0]?.effect_type !== "direct_account") throw new Error("DIRECT_ACCOUNT_EFFECT_REQUIRED");
    const operation = await client.query<{ kind: MoneyOperationKind; state: MoneyOperationState }>(
      "SELECT kind, state FROM money_operations WHERE id = $1 FOR UPDATE",
      [input.operationId],
    );
    const current = operation.rows[0];
    if (!current || current.kind !== "enroll" || !(LEGAL_PROVIDER_TRANSITIONS[current.state] ?? []).includes("pending")) {
      throw new Error("DIRECT_ACCOUNT_RETRY_TRANSITION_INVALID");
    }
    await client.query(
      `UPDATE external_effects
          SET state = 'ambiguous', last_error_code = $2,
              lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.errorCode],
    );
    await client.query(
      `UPDATE money_operations
          SET state = 'pending', failure_code = $2, updated_at = NOW(), version = version + 1
        WHERE id = $1`,
      [input.operationId, input.errorCode],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failEffect(
  effectId: string,
  operationId: string,
  leaseToken: string,
  errorCode: string,
  scrubRequestPayload = false,
  providerReference?: string,
): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, effectId, operationId, leaseToken);
    const operation = await client.query(
      "SELECT state, kind, chain_tx_hash FROM money_operations WHERE id = $1 FOR UPDATE",
      [operationId],
    );
    const current = operation.rows[0] as { state?: MoneyOperationState; kind?: MoneyOperationKind; chain_tx_hash?: string | null } | undefined;
    if (!current || !(LEGAL_PROVIDER_TRANSITIONS[current.state ?? ""] ?? []).includes("failed")) {
      throw new Error(`Illegal provider state transition ${current?.state ?? "missing"} -> failed`);

    }
    const cashOutRefundRequired = current.kind === "cash_out" && current.chain_tx_hash !== null;
    if (cashOutRefundRequired) {
      await client.query(
        `INSERT INTO external_effects
          (id, operation_id, provider, effect_type, state, request_payload, request_hash, provider_idempotency_key)
         SELECT $1, operation_id, 'brale', 'cash_out_refund', 'queued', request_payload, request_hash,
                'gammon:' || operation_id || ':cash_out_refund'
           FROM external_effects
          WHERE operation_id = $2 AND effect_type = 'create_cash_out'
         ON CONFLICT (operation_id, effect_type) DO NOTHING`,
        [randomUUID(), operationId],
      );
    }
    await client.query(
      `UPDATE external_effects SET state = 'failed', last_error_code = $2,
        request_payload = CASE WHEN $3 THEN '{"redacted":true}'::jsonb ELSE request_payload END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
      [effectId, errorCode, scrubRequestPayload],
    );
    await client.query(
      "UPDATE money_operations SET state = $2, failure_code = $3, provider_transfer_id = COALESCE(provider_transfer_id, $4), updated_at = NOW(), version = version + 1 WHERE id = $1",
      [operationId, cashOutRefundRequired ? "refunding" : "failed", errorCode, providerReference ?? null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function failDirectEffect(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  errorCode: string;
  requireFreshClientCredential?: boolean;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const effect = await client.query<{ effect_type: string }>(
      "SELECT effect_type FROM external_effects WHERE id = $1 AND operation_id = $2 FOR KEY SHARE",
      [input.effectId, input.operationId],
    );
    if (!effect.rows[0]?.effect_type.startsWith("direct_")) throw new Error("DIRECT_EFFECT_REQUIRED");
    await client.query(
      `UPDATE external_effects
          SET state = 'failed', last_error_code = $2, request_payload = '{"redacted":true}'::jsonb,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [input.effectId, input.errorCode],
    );
    await client.query(
      `UPDATE money_operations
          SET state = 'failed',
              failure_code = $2,
              updated_at = NOW(),
              version = version + 1
        WHERE id = $1`,
      [input.operationId, input.requireFreshClientCredential ? "fresh_client_credential_required" : input.errorCode],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export interface EffectDispatchMarker {
  readonly effectId: string;
  readonly operationId: string;
  readonly leaseToken: string;
  readonly principal: string;
  readonly step: string;
}

export async function markEffectDispatchUnderLease(
  client: pg.PoolClient,
  input: EffectDispatchMarker,
): Promise<boolean> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.step)) throw new TypeError("Invalid effect dispatch step");
  await requireLease(client, input.effectId, input.operationId, input.leaseToken);
  const inserted = await client.query(
    `INSERT INTO external_effect_dispatches (effect_id, step, operation_id, principal)
     VALUES ($1, $2, $3, $4) ON CONFLICT (effect_id, step) DO NOTHING`,
    [input.effectId, input.step, input.operationId, input.principal],
  );
  return inserted.rowCount === 1;
}

export async function authorizeEffectDispatch(input: {
  effectId: string;
  operationId: string;
  leaseToken: string;
  principal: string;
  step: "external_wallet" | "internal_address" | "transfer" | "refund_transfer";
  action: "provider_account_create" | "deposit" | "cash_out" | "refund";
  amountMicroUsd?: string | null;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await requireLease(client, input.effectId, input.operationId, input.leaseToken);
    const existing = await client.query(
      "SELECT 1 FROM external_effect_dispatches WHERE effect_id = $1 AND step = $2 FOR KEY SHARE",
      [input.effectId, input.step],
    );
    if (existing.rowCount === 0) {
      const decision = input.action === "provider_account_create"
        ? await lockProviderEntryAction(client, input.principal, "provider_account_create")
        : input.action === "deposit"
          ? await lockFundsAction(client, input.principal, "deposit", BigInt(input.amountMicroUsd ?? "0"))
          : await lockRecoveryAction(client, input.principal, input.action);
      if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
      await client.query(
        `INSERT INTO external_effect_dispatches (effect_id, step, operation_id, principal)
         VALUES ($1, $2, $3, $4) ON CONFLICT (effect_id, step) DO NOTHING`,
        [input.effectId, input.step, input.operationId, input.principal],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}



export async function getPaymentProfile(principal: string): Promise<PaymentProfile | null> {
  const result = await database().query(
    `SELECT principal, provider_account_id, wallet_address, external_wallet_address_id,
            internal_address_id, internal_wallet_address, status
       FROM payment_profiles WHERE principal = $1`,
    [principal],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    principal: row.principal,
    providerAccountId: row.provider_account_id,
    walletAddress: row.wallet_address,
    externalWalletAddressId: row.external_wallet_address_id,
    internalAddressId: row.internal_address_id,
    internalWalletAddress: row.internal_wallet_address,
    status: row.status,
  };
}

export async function upsertPaymentProfile(input: {
  principal: string;
  providerAccountId: string;
  walletAddress: string;
  status: PaymentProfile["status"];
  externalWalletAddressId?: string;
  internalAddressId?: string;
  internalWalletAddress?: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      provider_account_id: string;
      wallet_address: string;
      external_wallet_address_id: string | null;
      internal_address_id: string | null;
      internal_wallet_address: string | null;
      status: PaymentProfile["status"];
    }>("SELECT * FROM payment_profiles WHERE principal = $1 FOR UPDATE", [input.principal]);
    const profile = existing.rows[0];
    if (
      profile?.status === "active" &&
      (
        profile.provider_account_id !== input.providerAccountId ||
        profile.wallet_address !== input.walletAddress ||
        (input.externalWalletAddressId !== undefined && profile.external_wallet_address_id !== input.externalWalletAddressId) ||
        (input.internalAddressId !== undefined && profile.internal_address_id !== input.internalAddressId) ||
        (input.internalWalletAddress !== undefined && profile.internal_wallet_address !== input.internalWalletAddress)
      )
    ) throw new Error("ACTIVE_PAYMENT_PROFILE_TUPLE_IMMUTABLE");
    await client.query(
      `INSERT INTO payment_profiles
        (principal, provider_account_id, wallet_address, external_wallet_address_id,
         internal_address_id, internal_wallet_address, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (principal) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         wallet_address = EXCLUDED.wallet_address,
         external_wallet_address_id = COALESCE(EXCLUDED.external_wallet_address_id, payment_profiles.external_wallet_address_id),
         internal_address_id = COALESCE(EXCLUDED.internal_address_id, payment_profiles.internal_address_id),
         internal_wallet_address = COALESCE(EXCLUDED.internal_wallet_address, payment_profiles.internal_wallet_address),
         status = EXCLUDED.status, updated_at = NOW()`,
      [
        input.principal,
        input.providerAccountId,
        input.walletAddress,
        input.externalWalletAddressId ?? null,
        input.internalAddressId ?? null,
        input.internalWalletAddress ?? null,
        input.status,
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


export async function getPaymentMethod(principal: string, id: string): Promise<PaymentMethod | null> {
  const result = await database().query(
    "SELECT * FROM payment_methods WHERE id = $1 AND principal = $2 AND state = 'active'",
    [id, principal],
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    principal: row.principal,
    providerAddressId: row.provider_address_id,
    state: row.state,
    displayLabel: row.display_label,
  } : null;
}

export async function listPaymentMethods(principal: string): Promise<Array<Omit<PaymentMethod, "providerAddressId">>> {
  const result = await database().query(
    "SELECT id, principal, state, display_label FROM payment_methods WHERE principal = $1 ORDER BY created_at DESC",
    [principal],
  );
  return result.rows.map((row) => ({
    id: row.id,
    principal: row.principal,
    state: row.state,
    displayLabel: row.display_label,
  }));
}


function configuredReturnReconciliationHorizon(): number {
  const horizon = fundsGate.config.approvedAchPolicy?.returnReconciliationHorizonSeconds;
  if (typeof horizon !== "number" || !Number.isSafeInteger(horizon) || horizon <= 0) {
    throw new Error("APPROVED_ACH_RETURN_HORIZON_REQUIRED");
  }
  return horizon;
}

function transferReconciliationDeadlineSql(
  operationAlias: string,
  providerTransferIdSql: string,
  fallbackPlaceholder: string,
): string {
  return `(
    COALESCE(
      (
        SELECT MIN(history.observed_at)
          FROM provider_state_history history
         WHERE history.provider_transfer_id = ${providerTransferIdSql}
           AND history.state IN ('complete', 'failed', 'canceled', 'refunding', 'refunded')
      ),
      ${operationAlias}.updated_at
    ) + (
      COALESCE(
        NULLIF(${operationAlias}.quote_snapshot->>'achReturnReconciliationHorizonSeconds', '')::integer,
        ${fallbackPlaceholder}
      ) * INTERVAL '1 second'
    )
  )`;
}

function transferReconciliationHasActiveWorkSql(operationAlias: string, requestAlias: string): string {
  return `(
    ${operationAlias}.state IN ('queued', 'processing', 'pending', 'review', 'refunding')
    OR EXISTS (
      SELECT 1
        FROM external_effects refund
       WHERE refund.operation_id = ${operationAlias}.id
         AND refund.effect_type = 'cash_out_refund'
         AND refund.provider_reference = ${requestAlias}.provider_transfer_id
         AND refund.state IN ('queued', 'retry', 'ambiguous', 'leased')
    )
  )`;
}

async function retireExpiredTransferReconciliations(
  client: pg.PoolClient,
  configuredReturnHorizon: number,
): Promise<void> {
  const deadline = transferReconciliationDeadlineSql("operation", "request.provider_transfer_id", "$1");
  const activeWork = transferReconciliationHasActiveWorkSql("operation", "request");
  await client.query(
    `WITH expired_requests AS (
       DELETE FROM provider_transfer_reconciliation_requests request
        USING money_operations operation
        WHERE request.operation_id = operation.id
          AND (request.lease_expires_at IS NULL OR request.lease_expires_at <= NOW())
          AND NOT ${activeWork}
          AND ${deadline} <= NOW()
          AND request.updated_at <= ${deadline}
        RETURNING request.provider_transfer_id, request.operation_id
     )
     UPDATE external_effects effect
        SET state = 'failed',
            last_error_code = 'reconciliation_horizon_expired',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
       FROM expired_requests expired
      WHERE effect.operation_id = expired.operation_id
        AND effect.effect_type = 'reconcile_transfer:' || expired.provider_transfer_id
        AND (
          effect.state IN ('queued', 'retry', 'ambiguous')
          OR (effect.state = 'leased' AND effect.lease_expires_at <= NOW())
        )`,
    [configuredReturnHorizon],
  );
}

export async function enqueueDueTransferReconciliations(): Promise<number> {
  const configuredReturnHorizon = configuredReturnReconciliationHorizon();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await retireExpiredTransferReconciliations(client, configuredReturnHorizon);
    const primaryDeadline = transferReconciliationDeadlineSql("operation", "operation.provider_transfer_id", "$1");
    const refundDeadline = transferReconciliationDeadlineSql("operation", "refund.provider_reference", "$1");
    const result = await client.query(
      `WITH candidates AS (
         SELECT operation.id AS operation_id, operation.provider_transfer_id
           FROM money_operations operation
          WHERE operation.provider_transfer_id IS NOT NULL
            AND (
              operation.state IN ('queued', 'processing', 'pending', 'review', 'refunding')
              OR ${primaryDeadline} > NOW()
            )
         UNION
         SELECT operation.id, refund.provider_reference
           FROM money_operations operation
           JOIN external_effects refund
             ON refund.operation_id = operation.id
            AND refund.effect_type = 'cash_out_refund'
          WHERE refund.provider_reference IS NOT NULL
            AND (
              refund.state IN ('queued', 'retry', 'ambiguous', 'leased')
              OR ${refundDeadline} > NOW()
            )
       )
       INSERT INTO provider_transfer_reconciliation_requests
         (provider_transfer_id, operation_id, next_poll_at)
       SELECT provider_transfer_id, operation_id, NOW() FROM candidates
       ON CONFLICT (provider_transfer_id) DO UPDATE
         SET next_poll_at = LEAST(provider_transfer_reconciliation_requests.next_poll_at, NOW()),
             updated_at = NOW()
       RETURNING provider_transfer_id`,
      [configuredReturnHorizon],
    );
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ProviderTransferReconciliationRequest {
  readonly providerTransferId: string;
  readonly operationId: string;
  readonly leaseToken: string;
}

export async function claimProviderTransferReconciliations(
  workerId: string,
  limit: number,
): Promise<readonly ProviderTransferReconciliationRequest[]> {
  const configuredReturnHorizon = configuredReturnReconciliationHorizon();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await retireExpiredTransferReconciliations(client, configuredReturnHorizon);
    const deadline = transferReconciliationDeadlineSql("operation", "request.provider_transfer_id", "$1");
    const activeWork = transferReconciliationHasActiveWorkSql("operation", "request");
    const result = await client.query<{
      provider_transfer_id: string;
      operation_id: string;
    }>(
      `WITH candidates AS (
         SELECT request.provider_transfer_id
           FROM provider_transfer_reconciliation_requests request
           JOIN money_operations operation ON operation.id = request.operation_id
          WHERE request.next_poll_at <= NOW()
            AND (request.lease_expires_at IS NULL OR request.lease_expires_at <= NOW())
            AND (
              ${activeWork}
              OR ${deadline} > NOW()
              OR request.updated_at > ${deadline}
            )
          ORDER BY request.next_poll_at, request.updated_at, request.provider_transfer_id
          LIMIT $3
          FOR UPDATE OF request SKIP LOCKED
       )
       UPDATE provider_transfer_reconciliation_requests request
          SET lease_owner = $2,
              lease_expires_at = NOW() + INTERVAL '2 minutes'
         FROM candidates
        WHERE request.provider_transfer_id = candidates.provider_transfer_id
       RETURNING request.provider_transfer_id, request.operation_id`,
      [configuredReturnHorizon, workerId, Math.max(1, Math.min(limit, 500))],
    );
    await client.query("COMMIT");
    return result.rows.map((row) => ({
      providerTransferId: row.provider_transfer_id,
      operationId: row.operation_id,
      leaseToken: workerId,
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function dispatchProviderTransferReconciliation(input: ProviderTransferReconciliationRequest): Promise<void> {
  const configuredReturnHorizon = configuredReturnReconciliationHorizon();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const deadline = transferReconciliationDeadlineSql("operation", "request.provider_transfer_id", "$3");
    const activeWork = transferReconciliationHasActiveWorkSql("operation", "request");
    const request = await client.query<{
      has_active_work: boolean;
      within_horizon: boolean;
      late_webhook_reactivation: boolean;
    }>(
      `SELECT ${activeWork} AS has_active_work,
              ${deadline} > NOW() AS within_horizon,
              request.updated_at > ${deadline} AS late_webhook_reactivation
         FROM provider_transfer_reconciliation_requests request
         JOIN money_operations operation ON operation.id = request.operation_id
        WHERE request.provider_transfer_id = $1
          AND request.operation_id = $2
          AND request.lease_owner = $4
        FOR UPDATE OF request`,
      [input.providerTransferId, input.operationId, configuredReturnHorizon, input.leaseToken],
    );
    const current = request.rows[0];
    if (!current) {
      await client.query("COMMIT");
      return;
    }
    const retired = !current.has_active_work && !current.within_horizon && !current.late_webhook_reactivation;
    if (retired) {
      await client.query(
        `DELETE FROM provider_transfer_reconciliation_requests
          WHERE provider_transfer_id = $1 AND operation_id = $2 AND lease_owner = $3`,
        [input.providerTransferId, input.operationId, input.leaseToken],
      );
      await client.query(
        `UPDATE external_effects
            SET state = 'failed',
                last_error_code = 'reconciliation_horizon_expired',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
          WHERE operation_id = $1
            AND effect_type = $2
            AND state IN ('queued', 'retry', 'ambiguous')`,
        [input.operationId, `reconcile_transfer:${input.providerTransferId}`],
      );
      await client.query("COMMIT");
      return;
    }
    const lateWebhookReactivation = !current.has_active_work && !current.within_horizon;
    const installed = await client.query(
      `INSERT INTO external_effects
        (id, operation_id, provider, effect_type, state, request_payload, request_hash, provider_idempotency_key)
       VALUES ($1, $2, 'brale', $3, 'queued', $4, $5, $6)
       ON CONFLICT (operation_id, effect_type) DO UPDATE
         SET state = 'queued',
             request_payload = EXCLUDED.request_payload,
             next_attempt_at = NOW(),
             attempt_count = CASE
               WHEN EXCLUDED.request_payload->>'reactivateAfterHorizon' = 'true' THEN 0
               ELSE external_effects.attempt_count
             END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = NOW()
       WHERE external_effects.state <> 'leased' OR external_effects.lease_expires_at <= NOW()
       RETURNING id`,
      [
        randomUUID(),
        input.operationId,
        `reconcile_transfer:${input.providerTransferId}`,
        {
          providerTransferId: input.providerTransferId,
          ...(lateWebhookReactivation ? { reactivateAfterHorizon: true } : {}),
        },
        input.providerTransferId,
        `gammon:${input.operationId}:reconcile:${input.providerTransferId}`,
      ],
    );
    if (lateWebhookReactivation && installed.rowCount !== 1) {
      await client.query(
        `UPDATE provider_transfer_reconciliation_requests
            SET next_poll_at = NOW() + INTERVAL '30 seconds',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
          WHERE provider_transfer_id = $1 AND operation_id = $2 AND lease_owner = $3`,
        [input.providerTransferId, input.operationId, input.leaseToken],
      );
    } else if (lateWebhookReactivation) {
      await client.query(
        `DELETE FROM provider_transfer_reconciliation_requests
          WHERE provider_transfer_id = $1 AND operation_id = $2 AND lease_owner = $3`,
        [input.providerTransferId, input.operationId, input.leaseToken],
      );
    } else {
      await client.query(
        `UPDATE provider_transfer_reconciliation_requests
            SET next_poll_at = NOW() + INTERVAL '5 minutes',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
          WHERE provider_transfer_id = $1 AND operation_id = $2 AND lease_owner = $3`,
        [input.providerTransferId, input.operationId, input.leaseToken],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function operationForProviderTransfer(providerTransferId: string): Promise<InternalMoneyOperation | null> {
  const result = await database().query(
    `SELECT ${OPERATION_RECEIPT_COLUMNS}
       FROM money_operations operation
       LEFT JOIN external_effects refund
         ON refund.operation_id = operation.id
        AND refund.effect_type = 'cash_out_refund'
      WHERE operation.provider_transfer_id = $1 OR refund.provider_reference = $1
      ORDER BY (operation.provider_transfer_id = $1) DESC
      LIMIT 1`,
    [providerTransferId],
  );
  return result.rows[0] ? operationFromRow(result.rows[0]) : null;
}

const LEGAL_PROVIDER_TRANSITIONS: Record<string, readonly MoneyOperationState[]> = {
  created: ["queued", "processing", "pending", "awaiting_user", "complete", "failed", "review"],
  awaiting_user: ["queued", "processing", "awaiting_user", "canceled", "failed", "review"],
  queued: ["queued", "pending", "processing", "complete", "canceled", "failed", "review"],
  pending: ["queued", "pending", "processing", "complete", "canceled", "failed", "refunding", "refunded", "review"],
  processing: ["processing", "awaiting_user", "pending", "complete", "canceled", "failed", "refunding", "refunded", "review"],
  complete: ["complete", "canceled", "failed", "refunding", "refunded", "review"],
  failed: ["failed", "complete", "refunding", "refunded", "review"],
  canceled: ["canceled", "complete", "review"],
  refunding: ["refunding", "refunded", "failed", "review"],
  refunded: ["refunded", "review"],
  review: ["review"],
};


async function derivePaymentProfilesForResource(
  client: pg.PoolClient,
  resourceType: ProviderResourceType,
  resourceId: string,
): Promise<void> {
  await client.query(
    `UPDATE payment_profiles profile
        SET status = CASE
          WHEN account.status = 'archived' THEN 'closed'
          WHEN account.status IN ('rejected', 'stale')
            OR EXISTS (
              SELECT 1
                FROM provider_resource_states address
               WHERE address.resource_type = 'address'
                 AND address.resource_id IN (
                   profile.external_wallet_address_id,
                   profile.internal_address_id
                 )
                 AND address.status IN ('relink_required', 'disabled', 'rejected', 'archived', 'stale')
            )
            THEN 'restricted'
          WHEN account.status = 'complete'
            AND EXISTS (
              SELECT 1
                FROM provider_resource_states external_address
               WHERE external_address.resource_type = 'address'
                 AND external_address.resource_id = profile.external_wallet_address_id
                 AND external_address.status IN ('active', 'complete')
            )
            AND EXISTS (
              SELECT 1
                FROM provider_resource_states internal_address
               WHERE internal_address.resource_type = 'address'
                 AND internal_address.resource_id = profile.internal_address_id
                 AND internal_address.status IN ('active', 'complete')
            )
            THEN 'active'
          ELSE 'pending'
        END,
        updated_at = NOW()
       FROM provider_resource_states account
      WHERE account.resource_type = 'account'
        AND account.resource_id = profile.provider_account_id
        AND (
          ($1 = 'account' AND profile.provider_account_id = $2)
          OR ($1 = 'address' AND (
            profile.external_wallet_address_id = $2
            OR profile.internal_address_id = $2
          ))
        )`,
    [resourceType, resourceId],
  );
}

async function reconcileProviderResourceStateInTransaction(
  client: pg.PoolClient,
  input: { resourceType: ProviderResourceType; resourceId: string; status: string },
): Promise<void> {
  await client.query(
    `INSERT INTO provider_resource_states (resource_type, resource_id, status, observed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (resource_type, resource_id) DO UPDATE
       SET status = EXCLUDED.status, observed_at = NOW(), updated_at = NOW()`,
    [input.resourceType, input.resourceId, input.status],
  );
  if (input.resourceType === "address") {
    await client.query(
      `UPDATE payment_methods
          SET state = CASE
            WHEN $2 IN ('active', 'complete') THEN 'active'
            WHEN $2 = 'relink_required' THEN 'relink_required'
            WHEN $2 IN ('pending', 'documents_required', 'stale') THEN 'pending'
            WHEN $2 IN ('disabled', 'rejected', 'archived') THEN 'disabled'
            ELSE 'disabled'
          END,
          updated_at = NOW()
        WHERE provider_address_id = $1`,
      [input.resourceId, input.status],
    );
  }
  await derivePaymentProfilesForResource(client, input.resourceType, input.resourceId);
}

export async function reconcileProviderResourceState(input: {
  resourceType: ProviderResourceType;
  resourceId: string;
  status: string;
}): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await reconcileProviderResourceStateInTransaction(client, input);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ProviderResourceType = "account" | "address";

export interface ProviderResourceReconciliationRequest {
  readonly resourceType: ProviderResourceType;
  readonly resourceId: string;
  readonly parentAccountId: string;
  readonly leaseToken: string;
  readonly attemptCount: number;
}

export async function queueProviderResourceReconciliation(input: {
  resourceType: ProviderResourceType;
  resourceId: string;
  parentAccountId: string;
}): Promise<void> {
  await database().query(
    `INSERT INTO provider_resource_reconciliation_requests
      (resource_type, resource_id, parent_account_id, next_attempt_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (resource_type, resource_id) DO UPDATE
       SET parent_account_id = EXCLUDED.parent_account_id,
           next_attempt_at = LEAST(
             provider_resource_reconciliation_requests.next_attempt_at,
             NOW()
           ),
           updated_at = NOW()`,
    [input.resourceType, input.resourceId, input.parentAccountId],
  );
}

export async function claimProviderResourceReconciliations(
  workerId: string,
  limit: number,
): Promise<readonly ProviderResourceReconciliationRequest[]> {
  const result = await database().query<{
    resource_type: ProviderResourceType;
    resource_id: string;
    parent_account_id: string;
    attempt_count: number;
  }>(
    `WITH candidates AS (
       SELECT resource_type, resource_id
         FROM provider_resource_reconciliation_requests
        WHERE next_attempt_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        ORDER BY next_attempt_at, updated_at, resource_type, resource_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE provider_resource_reconciliation_requests request
        SET lease_owner = $1,
            lease_expires_at = NOW() + INTERVAL '2 minutes',
            updated_at = NOW()
       FROM candidates
      WHERE request.resource_type = candidates.resource_type
        AND request.resource_id = candidates.resource_id
     RETURNING request.resource_type, request.resource_id, request.parent_account_id, request.attempt_count`,
    [workerId, Math.max(1, Math.min(limit, 500))],
  );
  return result.rows.map((row) => ({
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    parentAccountId: row.parent_account_id,
    leaseToken: workerId,
    attemptCount: row.attempt_count,
  }));
}

export async function completeProviderResourceReconciliation(input: {
  resourceType: ProviderResourceType;
  resourceId: string;
  leaseToken: string;
}): Promise<void> {
  await database().query(
    `DELETE FROM provider_resource_reconciliation_requests
      WHERE resource_type = $1 AND resource_id = $2 AND lease_owner = $3`,
    [input.resourceType, input.resourceId, input.leaseToken],
  );
}

export async function failProviderResourceReconciliation(input: {
  resourceType: ProviderResourceType;
  resourceId: string;
  leaseToken: string;
  errorCode: string;
}): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,99}$/.test(input.errorCode)) throw new TypeError("Invalid provider resource reconciliation error code");
  await database().query(
    `UPDATE provider_resource_reconciliation_requests
        SET attempt_count = LEAST(255, attempt_count + 1),
            last_error_code = $4,
            next_attempt_at = NOW() + (
              LEAST(3600::double precision, 30::double precision * power(2::double precision, LEAST(attempt_count, 6)))
              * INTERVAL '1 second'
            ),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE resource_type = $1 AND resource_id = $2 AND lease_owner = $3`,
    [input.resourceType, input.resourceId, input.leaseToken, input.errorCode],
  );
}

export async function acceptWebhookEvent(input: {
  subscriptionId: string;
  environment: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  providerResourceId: string | null;
  masterAccountId: string;
}): Promise<{ accepted: boolean; bound: boolean }> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO webhook_events (subscription_id, environment, event_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [input.subscriptionId, input.environment, input.eventId, input.eventType, input.payload],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ payload: unknown; processed_at: Date | null }>(
        `SELECT payload, processed_at FROM webhook_events
          WHERE subscription_id = $1 AND environment = $2 AND event_id = $3 AND event_type = $4
          FOR UPDATE`,
        [input.subscriptionId, input.environment, input.eventId, input.eventType],
      );
      const row = existing.rows[0];
      if (!row || payloadHash(row.payload) !== payloadHash(input.payload)) throw new Error("WEBHOOK_IDENTITY_MISMATCH");
      if (row.processed_at) {
        await client.query("COMMIT");
        return { accepted: true, bound: true };
      }
    }
    let bound = true;
    if (input.eventType.startsWith("account.") || input.eventType.startsWith("address.")) {
      const resourceType: ProviderResourceType = input.eventType.startsWith("account.") ? "account" : "address";
      if (!input.providerResourceId) {
        bound = false;
      } else {
        const binding = resourceType === "account"
          ? await client.query<{ parent_account_id: string }>(
            `SELECT provider_account_id AS parent_account_id
               FROM payment_profiles
              WHERE provider_account_id = $1
              LIMIT 1`,
            [input.providerResourceId],
          )
          : await client.query<{ parent_account_id: string }>(
            `SELECT parent_account_id
               FROM (
                 SELECT provider_account_id AS parent_account_id
                   FROM payment_profiles
                  WHERE external_wallet_address_id = $1
                 UNION ALL
                 SELECT $2 AS parent_account_id
                   FROM payment_profiles
                  WHERE internal_address_id = $1
                 UNION ALL
                 SELECT profile.provider_account_id AS parent_account_id
                   FROM payment_methods method
                   JOIN payment_profiles profile ON profile.principal = method.principal
                  WHERE method.provider_address_id = $1
               ) bound_address
              LIMIT 1`,
            [input.providerResourceId, input.masterAccountId],
          );
        const parentAccountId = binding.rows[0]?.parent_account_id;
        if (!parentAccountId) {
          bound = false;
        } else {
          await client.query(
            `INSERT INTO provider_resource_states (resource_type, resource_id, status, observed_at)
             VALUES ($1, $2, 'stale', NOW())
             ON CONFLICT (resource_type, resource_id) DO UPDATE
               SET status = 'stale', observed_at = NOW(), updated_at = NOW()`,
            [resourceType, input.providerResourceId],
          );
          await derivePaymentProfilesForResource(client, resourceType, input.providerResourceId);
          await client.query(
            `INSERT INTO provider_resource_reconciliation_requests
              (resource_type, resource_id, parent_account_id, next_attempt_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (resource_type, resource_id) DO UPDATE
               SET parent_account_id = EXCLUDED.parent_account_id,
                   next_attempt_at = NOW(),
                   updated_at = NOW()`,
            [resourceType, input.providerResourceId, parentAccountId],
          );
        }
      }
    }
    if (input.eventType.startsWith("transfer.")) {
      if (!input.providerResourceId) bound = false;
      else {
        const operation = await client.query<{ id: string }>(
          `SELECT operation.id
             FROM money_operations operation
             LEFT JOIN external_effects refund
               ON refund.operation_id = operation.id AND refund.effect_type = 'cash_out_refund'
            WHERE operation.provider_transfer_id = $1 OR refund.provider_reference = $1
            FOR UPDATE OF operation`,
          [input.providerResourceId],
        );
        const operationId = operation.rows[0]?.id;
        if (!operationId) bound = false;
        else {
          await client.query(
            `INSERT INTO provider_transfer_reconciliation_requests
              (provider_transfer_id, operation_id, next_poll_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (provider_transfer_id) DO UPDATE
               SET next_poll_at = NOW(), updated_at = NOW()`,
            [input.providerResourceId, operationId],
          );
        }
      }
    }
    if (bound) {
      await client.query(
        `UPDATE webhook_events SET processed_at = NOW(), processing_error = NULL
          WHERE subscription_id = $1 AND environment = $2 AND event_id = $3 AND event_type = $4`,
        [input.subscriptionId, input.environment, input.eventId, input.eventType],
      );
    }
    await client.query("COMMIT");
    return { accepted: bound, bound };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listProviderResourcesForReconciliation(): Promise<Array<{
  providerAccountId: string;
  externalWalletAddressId: string | null;
  internalAddressId: string | null;
  providerAddressIds: readonly string[];
}>> {
  const result = await database().query<{
    provider_account_id: string;
    external_wallet_address_id: string | null;
    internal_address_id: string | null;
    provider_address_ids: string[];
  }>(
    `SELECT profile.provider_account_id, profile.external_wallet_address_id, profile.internal_address_id,
            COALESCE(array_agg(DISTINCT method.provider_address_id)
              FILTER (WHERE method.provider_address_id IS NOT NULL), '{}') AS provider_address_ids
       FROM payment_profiles profile
       LEFT JOIN payment_methods method ON method.principal = profile.principal
      WHERE profile.status IN ('active', 'pending', 'restricted')
      GROUP BY profile.provider_account_id, profile.external_wallet_address_id, profile.internal_address_id`,
  );
  return result.rows.map((row) => ({
    providerAccountId: row.provider_account_id,
    externalWalletAddressId: row.external_wallet_address_id,
    internalAddressId: row.internal_address_id,
    providerAddressIds: row.provider_address_ids,
  }));
}


