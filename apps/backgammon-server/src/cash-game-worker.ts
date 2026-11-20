import { z } from "zod";
import {
  assertEscrowStateFinality,
  queryEscrowGame,
  verifyEscrowTransaction,
  type EscrowChainSnapshot,
  type EscrowGame,
} from "./cash-game-chain.js";
import {
  authorizeCashAuthorizerDispatch,
  hasCashAuthorizerDispatch,
  markCashRefunded,
  markCashSettled,
  markEscrowCreated,
  quarantineCashEscrowEffect,
  quoteForGame,
  type CashQuote,
} from "./cash-game-store.js";
import { payloadHash } from "./finance-crypto.js";
import type { ClaimedEffect } from "./finance-store.js";
import { fundsGate } from "./funds-config.js";
import { configuredSettlementAuthorizer } from "./settlement-authorizer.js";

const CreatePayload = z.object({
  gameId: z.string().uuid(),
  playerA: z.string(),
  playerB: z.string(),
  quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
  quoteId: z.string().uuid(),
  stakeMicroUsd: z.string().regex(/^[1-9]\d*$/),
}).strict();

const SettlePayload = z.object({
  cubeValue: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  cubeWasTurned: z.boolean(),
  gameId: z.string().uuid(),
  quoteId: z.string().uuid(),
  resultMultiplier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  settlementId: z.string().uuid(),
  winner: z.string(),
}).strict();

const RefundPayload = z.object({
  gameId: z.string().uuid(),
  quoteId: z.string().uuid(),
  refundId: z.union([z.string().uuid(), z.literal("funding-timeout")]),
  reason: z.string().min(1).max(100),
}).strict();
const EscrowRecoverySnapshotSchema = z.object({
  chainId: z.string().min(1),
  genesisHash: z.string().regex(/^[0-9a-f]{64}$/i),
  escrowContract: z.string().min(1),
  escrowCodeChecksum: z.string().regex(/^[0-9a-f]{64}$/i),
  denom: z.string().min(1),
  finalityBlocks: z.number().int().positive().max(1_000),
  settlementAuthority: z.string().min(1),
  escrowAdmin: z.string().min(1),
  rakeBps: z.number().int().min(0).max(10_000),
  rakeRecipient: z.string().min(1),
  minStakePerPoint: z.string().regex(/^[1-9]\d*$/),
  maxStakePerPoint: z.string().regex(/^[1-9]\d*$/),
  fundingTimeoutSeconds: z.number().int().positive(),
  cubeCap: z.number().int().positive(),
  rulesVersion: z.string().min(1),
  rakeCapMicroUsd: z.string().regex(/^(0|[1-9]\d*)$/),
  rulesHash: z.string().regex(/^[0-9a-f]{64}$/),
  authorizerContract: z.string().min(1),
  authorizerSigningKeyId: z.string().min(1),
}).strict();


const QuoteRulesSchema = z.object({
  automaticDoubles: z.literal(false),
  beavers: z.literal(false),
  cubeCap: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  disconnectCheckIntervalMs: z.number().int().positive(),
  disconnectGraceSeconds: z.number().int().positive(),
  disconnectPolicy: z.literal("pause_then_review"),
  doubleOfferPhase: z.literal("before_roll"),
  doubleResponseSeconds: z.number().int().positive(),
  jacoby: z.literal(true),
  openingRollPolicy: z.literal("single_future_beacon_assigns_one_die_per_color"),
  proofFailurePolicy: z.literal("pause_then_refund_or_review"),
  raccoons: z.literal(false),
  rakeBps: z.number().int().min(0).max(10_000),
  rakeCapMicroUsd: z.literal("0"),
  rakeRounding: z.literal("floor_micro_usd"),
  resignationPolicy: z.literal("normal_immediate_higher_requires_acceptance"),
  resignationResponseSeconds: z.number().int().positive(),
  turnTimeoutPolicy: z.literal("pause_then_review"),
  turnTimeLimitSeconds: z.number().int().positive(),
  version: z.literal("cash-v1"),
}).strict();

export class CashEffectPendingError extends Error {
  constructor(readonly code = "escrow_confirmation_pending") {
    super(code);
    this.name = "CashEffectPendingError";
  }
}

function unresolvedAttestation(): never {
  throw new CashEffectPendingError("escrow_attestation_unresolved");
}

interface AttestedEscrowGame {
  readonly escrow: EscrowGame;
  readonly quote: CashQuote;
  readonly snapshot: EscrowChainSnapshot;
}

async function attestedEscrowGame(input: {
  readonly gameId: string;
  readonly quoteId: string;
}): Promise<AttestedEscrowGame> {
  let quote: CashQuote | null;
  try {
    quote = await quoteForGame(input.gameId);
  } catch {
    return unresolvedAttestation();
  }
  const snapshot = quote ? recoverySnapshot(quote) : null;
  if (!quote || quote.id !== input.quoteId || !snapshot) return unresolvedAttestation();
  let escrow: EscrowGame;
  try {
    escrow = await queryEscrowGame(snapshot, input.gameId);
  } catch {
    return unresolvedAttestation();
  }
  const rules = QuoteRulesSchema.safeParse(quote.rules);
  if (
    !rules.success ||
    escrow.game_id !== quote.gameId ||
    escrow.player_a !== quote.playerA ||
    escrow.player_b !== quote.playerB ||
    escrow.stake_per_point !== quote.stakeMicroUsd ||
    BigInt(escrow.stake_per_point) < BigInt(snapshot.minStakePerPoint) ||
    BigInt(escrow.stake_per_point) > BigInt(snapshot.maxStakePerPoint) ||
    escrow.reserve_per_player !== quote.reservePerPlayerMicroUsd ||
    escrow.quote_hash !== quote.quoteHash ||
    escrow.wager_denom !== snapshot.denom ||
    escrow.rake_bps !== quote.rakeBps ||
    escrow.rake_bps !== rules.data.rakeBps ||
    escrow.rake_bps !== snapshot.rakeBps ||
    escrow.rake_recipient !== snapshot.rakeRecipient ||
    escrow.cube_cap !== quote.cubeCap ||
    escrow.cube_cap !== rules.data.cubeCap ||
    escrow.cube_cap !== snapshot.cubeCap ||
    escrow.rules_version !== rules.data.version ||
    escrow.rules_version !== snapshot.rulesVersion ||
    escrow.funding_deadline - escrow.created_at !== snapshot.fundingTimeoutSeconds ||
    rules.data.rakeCapMicroUsd !== snapshot.rakeCapMicroUsd ||
    payloadHash(quote.rules) !== snapshot.rulesHash
  ) return unresolvedAttestation();
  return { escrow, quote, snapshot };
}

function hasExpectedSettlementReceipt(escrow: EscrowGame, payload: z.infer<typeof SettlePayload>): boolean {
  const receipt = escrow.receipt;
  if (!receipt || payload.winner !== escrow.player_a && payload.winner !== escrow.player_b) return false;
  const multiplier = payload.cubeWasTurned ? payload.resultMultiplier : 1;
  const liability = BigInt(escrow.stake_per_point) * BigInt(payload.cubeValue) * BigInt(multiplier);
  const reserve = BigInt(escrow.reserve_per_player);
  const rake = liability * BigInt(escrow.rake_bps) / 10_000n;
  const winnerPayout = reserve + liability - rake;
  const loserPayout = reserve - liability;
  return (
    receipt.terminal_id === payload.settlementId &&
    receipt.winner === payload.winner &&
    receipt.cube_value === payload.cubeValue &&
    receipt.result_multiplier === multiplier &&
    receipt.liability === liability.toString() &&
    receipt.rake === rake.toString() &&
    receipt.winner_payout === winnerPayout.toString() &&
    receipt.loser_payout === loserPayout.toString() &&
    receipt.reason === null
  );
}

function expectedRefundTerminalId(payload: z.infer<typeof RefundPayload>): string {
  return payload.reason === "funding_timeout" ? "funding-timeout" : payload.refundId;
}

function hasExpectedRefundReceipt(escrow: EscrowGame, payload: z.infer<typeof RefundPayload>): boolean {
  const receipt = escrow.receipt;
  const playerARefund = escrow.player_a_deposited ? escrow.reserve_per_player : "0";
  const playerBRefund = escrow.player_b_deposited ? escrow.reserve_per_player : "0";
  return Boolean(
    receipt &&
    receipt.terminal_id === expectedRefundTerminalId(payload) &&
    receipt.winner === null &&
    receipt.cube_value === null &&
    receipt.result_multiplier === null &&
    receipt.liability === "0" &&
    receipt.rake === "0" &&
    receipt.winner_payout === playerARefund &&
    receipt.loser_payout === playerBRefund &&
    receipt.reason === payload.reason,
  );
}

async function verifyAuthorizerTransaction(input: {
  readonly txHash: string;
  readonly quote: CashQuote;
  readonly snapshot: EscrowChainSnapshot;
  readonly message: Record<string, unknown>;
}): Promise<void> {
  const sender = input.quote.escrowSnapshot.settlementAuthority;
  if (typeof sender !== "string" || sender === "") return unresolvedAttestation();
  try {
    await verifyEscrowTransaction({
      snapshot: input.snapshot,
      txHash: input.txHash,
      sender,
      message: input.message,
    });
  } catch {
    return unresolvedAttestation();
  }
}

function recoverySnapshot(quote: CashQuote): EscrowChainSnapshot | null {
  const parsed = EscrowRecoverySnapshotSchema.safeParse(quote.escrowSnapshot);
  return parsed.success ? parsed.data : null;
}

function hasPinnedAuthorizerIdentity(quote: CashQuote, signingKeyId?: string, contract?: string): boolean {
  const snapshot = quote.escrowSnapshot;
  return (
    typeof snapshot.authorizerSigningKeyId === "string" &&
    snapshot.authorizerSigningKeyId !== "" &&
    typeof snapshot.authorizerContract === "string" &&
    snapshot.authorizerContract !== "" &&
    (signingKeyId === undefined || signingKeyId === snapshot.authorizerSigningKeyId) &&
    (contract === undefined || contract === snapshot.authorizerContract)
  );
}

function configuredAuthorizerMatches(quote: CashQuote): boolean {
  const authorizer = fundsGate.config.settlementAuthorizer;
  return Boolean(
    authorizer &&
    quote.escrowSnapshot.authorizerSigningKeyId === authorizer.signingKeyId &&
    quote.escrowSnapshot.authorizerContract === authorizer.contract,
  );
}

async function requireFinalEscrowState(
  snapshot: EscrowChainSnapshot,
  height: number,
): Promise<{ readonly height: number; readonly blockHash: string }> {
  try {
    return await assertEscrowStateFinality(snapshot, height);
  } catch {
    throw new CashEffectPendingError("escrow_state_not_final");
  }
}

/**
 * Once an authorizer request crosses the network boundary, every failure is
 * conservatively possibly-delivered. Retrying begins with the chain state,
 * never with another policy gate.
 */
async function submitPossiblyDelivered<T>(submit: () => Promise<T>): Promise<T> {
  try {
    return await submit();
  } catch (error) {
    if (error instanceof CashEffectPendingError) throw error;
    throw new CashEffectPendingError("escrow_authorizer_response_ambiguous");
  }
}

export async function processCashGameEffect(effect: ClaimedEffect): Promise<boolean> {
  if (!["escrow_create", "escrow_settle", "escrow_refund"].includes(effect.effectType)) return false;

  if (effect.effectType === "escrow_create") {
    const payload = CreatePayload.parse(effect.requestPayload);
    const dispatched = await hasCashAuthorizerDispatch(effect.id, "escrow_create");
    let observed: AttestedEscrowGame | null = null;
    try {
      observed = await attestedEscrowGame({ gameId: payload.gameId, quoteId: payload.quoteId });
    } catch {
      // A missing game is expected before the first create; a durable marker
      // makes a crash in that gap safe to resend with the same idempotency key.
    }
    if (observed) {
      const exact = hasPinnedAuthorizerIdentity(observed.quote) &&
        observed.escrow.quote_hash === payload.quoteHash &&
        observed.escrow.player_a === payload.playerA &&
        observed.escrow.player_b === payload.playerB &&
        observed.escrow.stake_per_point === payload.stakeMicroUsd &&
        ["awaiting_reserves", "active"].includes(observed.escrow.status) &&
        observed.escrow.receipt === null;
      if (exact) {
        const finality = await requireFinalEscrowState(observed.snapshot, observed.escrow.created_height);
        await markEscrowCreated({
          effectId: effect.id, operationId: effect.operationId, quoteId: payload.quoteId, leaseToken: effect.leaseToken,
          txHash: null, fundingDeadline: new Date(observed.escrow.funding_deadline * 1_000), gameId: payload.gameId,
          attestation: {
            transactionHeight: finality.height, finalityBlockHash: finality.blockHash, source: "finalized_state",
            authorizerKeyId: String(observed.quote.escrowSnapshot.authorizerSigningKeyId), terminalId: null, receipt: null,
          },
        });
        return true;
      }
      if (observed.escrow.status === "settled" || observed.escrow.status === "refunded" || observed.escrow.receipt !== null) {
        await quarantineCashEscrowEffect({
          effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
          quoteId: payload.quoteId, reason: "escrow_create_terminal_mismatch",
        });
        return true;
      }
    }
    if (!dispatched) {
      const gate = await authorizeCashAuthorizerDispatch({
        effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
        quoteId: payload.quoteId, action: "create", step: "escrow_create",
      });
      if (gate.kind === "entry_denied") return true;
      if (gate.kind !== "authorized") throw new CashEffectPendingError("escrow_create_policy_deferred");
    }
    const quote = observed?.quote ?? await quoteForGame(payload.gameId);
    if (!quote || quote.id !== payload.quoteId || !configuredAuthorizerMatches(quote)) {
      throw new CashEffectPendingError("escrow_authorizer_identity_mismatch");
    }
    const authorizer = configuredSettlementAuthorizer();
    if (!authorizer) throw new Error("SETTLEMENT_AUTHORIZER_NOT_CONFIGURED");
    const result = await submitPossiblyDelivered(() => authorizer.createGame({
      gameId: payload.gameId, playerA: payload.playerA, playerB: payload.playerB,
      stakeMicroUsd: payload.stakeMicroUsd, quoteHash: payload.quoteHash,
    }, effect.providerIdempotencyKey));
    const after = await attestedEscrowGame({ gameId: payload.gameId, quoteId: payload.quoteId });
    if (
      !hasPinnedAuthorizerIdentity(after.quote, result.signingKeyId, result.contract) ||
      after.escrow.quote_hash !== payload.quoteHash ||
      after.escrow.player_a !== payload.playerA ||
      after.escrow.player_b !== payload.playerB ||
      after.escrow.stake_per_point !== payload.stakeMicroUsd ||
      !["awaiting_reserves", "active"].includes(after.escrow.status) ||
      after.escrow.receipt !== null
    ) {
      await quarantineCashEscrowEffect({
        effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
        quoteId: payload.quoteId, reason: "escrow_create_terminal_mismatch",
      });
      return true;
    }
    await verifyAuthorizerTransaction({
      snapshot: after.snapshot,
      txHash: result.txHash,
      quote: after.quote,
      message: { create_game: {
        game_id: payload.gameId, player_a: payload.playerA, player_b: payload.playerB,
        stake_per_point: payload.stakeMicroUsd, quote_hash: payload.quoteHash,
      } },
    });
    const finality = await requireFinalEscrowState(after.snapshot, after.escrow.created_height);
    await markEscrowCreated({
      effectId: effect.id, operationId: effect.operationId, quoteId: payload.quoteId, leaseToken: effect.leaseToken,
      txHash: result.txHash, fundingDeadline: new Date(after.escrow.funding_deadline * 1_000), gameId: payload.gameId,
      attestation: {
        transactionHeight: finality.height, finalityBlockHash: finality.blockHash, source: "transaction",
        authorizerKeyId: result.signingKeyId, terminalId: null, receipt: null,
      },
    });
    return true;
  }

  if (effect.effectType === "escrow_refund") {
    const payload = RefundPayload.parse(effect.requestPayload);
    const before = await attestedEscrowGame({ gameId: payload.gameId, quoteId: payload.quoteId });
    const exact = before.escrow.status === "refunded" && hasExpectedRefundReceipt(before.escrow, payload) && before.escrow.receipt;
    if (exact && before.escrow.receipt) {
      const finality = await requireFinalEscrowState(before.snapshot, before.escrow.receipt.terminal_height);
      const terminalId = expectedRefundTerminalId(payload);
      await markCashRefunded({
        effectId: effect.id, operationId: effect.operationId, quoteId: payload.quoteId, leaseToken: effect.leaseToken,
        refundId: terminalId, reason: payload.reason, txHash: null, gameId: payload.gameId,
        attestation: {
          transactionHeight: finality.height, finalityBlockHash: finality.blockHash, source: "finalized_state",
          authorizerKeyId: String(before.quote.escrowSnapshot.authorizerSigningKeyId),
          terminalId: before.escrow.receipt.terminal_id, receipt: before.escrow.receipt,
        },
      });
      return true;
    }
    if (before.escrow.status === "settled" || before.escrow.status === "refunded" || before.escrow.receipt !== null) {
      await quarantineCashEscrowEffect({
        effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
        quoteId: payload.quoteId, reason: "escrow_refund_terminal_mismatch",
      });
      return true;
    }
    const snapshot = recoverySnapshot(before.quote);
    if (!snapshot) throw new CashEffectPendingError("escrow_recovery_attestation_pending");
    if (!await hasCashAuthorizerDispatch(effect.id, "escrow_refund")) {
      const gate = await authorizeCashAuthorizerDispatch({
        effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
        quoteId: payload.quoteId, action: "refund", step: "escrow_refund",
        recoveryBlockers: () => fundsGate.escrowRecoveryBlockers(snapshot),
      });
      if (gate.kind === "recovery_hold") return true;
      if (gate.kind !== "authorized") throw new CashEffectPendingError("escrow_recovery_attestation_pending");
    }
    if (!configuredAuthorizerMatches(before.quote)) throw new CashEffectPendingError("escrow_authorizer_identity_mismatch");
    const authorizer = configuredSettlementAuthorizer();
    if (!authorizer) throw new Error("SETTLEMENT_AUTHORIZER_NOT_CONFIGURED");
    const terminalId = expectedRefundTerminalId(payload);
    const result = await submitPossiblyDelivered(() => authorizer.refundGame({
      gameId: payload.gameId, refundId: terminalId, reason: payload.reason,
    }, effect.providerIdempotencyKey));
    await verifyAuthorizerTransaction({
      snapshot: before.snapshot,
      txHash: result.txHash,
      quote: before.quote,
      message: { refund: { game_id: payload.gameId, refund_id: terminalId, reason: payload.reason } },
    });
    const after = await attestedEscrowGame({ gameId: payload.gameId, quoteId: payload.quoteId });
    if (after.escrow.status !== "refunded" || !hasExpectedRefundReceipt(after.escrow, payload) || !after.escrow.receipt) {
      if (after.escrow.status === "settled" || after.escrow.status === "refunded" || after.escrow.receipt !== null) {
        await quarantineCashEscrowEffect({
          effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
          quoteId: payload.quoteId, reason: "escrow_refund_terminal_mismatch",
        });
        return true;
      }
      throw new CashEffectPendingError("escrow_refund_confirmation_pending");
    }
    const finality = await requireFinalEscrowState(after.snapshot, after.escrow.receipt.terminal_height);
    await markCashRefunded({
      effectId: effect.id, operationId: effect.operationId, quoteId: payload.quoteId, leaseToken: effect.leaseToken,
      refundId: terminalId, reason: payload.reason, txHash: result.txHash, gameId: payload.gameId,
      attestation: {
        transactionHeight: finality.height, finalityBlockHash: finality.blockHash, source: "transaction",
        authorizerKeyId: result.signingKeyId, terminalId: after.escrow.receipt.terminal_id, receipt: after.escrow.receipt,
      },
    });
    return true;
  }

  const payload = SettlePayload.parse(effect.requestPayload);
  const before = await attestedEscrowGame({ gameId: payload.gameId, quoteId: payload.quoteId });
  const exact = before.escrow.status === "settled" && hasExpectedSettlementReceipt(before.escrow, payload) && before.escrow.receipt;
  if (exact && before.escrow.receipt) {
    const finality = await requireFinalEscrowState(before.snapshot, before.escrow.receipt.terminal_height);
    await markCashSettled({
      effectId: effect.id, operationId: effect.operationId, quoteId: payload.quoteId, leaseToken: effect.leaseToken,
      txHash: null, gameId: payload.gameId,
      attestation: {
        transactionHeight: finality.height, finalityBlockHash: finality.blockHash, source: "finalized_state",
        authorizerKeyId: String(before.quote.escrowSnapshot.authorizerSigningKeyId),
        terminalId: before.escrow.receipt.terminal_id, receipt: before.escrow.receipt,
      },
    });
    return true;
  }
  if (before.escrow.status === "settled" || before.escrow.status === "refunded" || before.escrow.receipt !== null) {
    await quarantineCashEscrowEffect({
      effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
      quoteId: payload.quoteId, reason: "escrow_settle_terminal_mismatch",
    });
    return true;
  }
  const snapshot = recoverySnapshot(before.quote);
  if (!snapshot) throw new CashEffectPendingError("escrow_recovery_attestation_pending");
  if (!await hasCashAuthorizerDispatch(effect.id, "escrow_settle")) {
    const gate = await authorizeCashAuthorizerDispatch({
      effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
      quoteId: payload.quoteId, action: "settle", step: "escrow_settle",
      recoveryBlockers: () => fundsGate.escrowRecoveryBlockers(snapshot),
    });
    if (gate.kind === "recovery_hold") return true;
    if (gate.kind !== "authorized") throw new CashEffectPendingError("escrow_recovery_attestation_pending");
  }
  if (!configuredAuthorizerMatches(before.quote)) throw new CashEffectPendingError("escrow_authorizer_identity_mismatch");
  const authorizer = configuredSettlementAuthorizer();
  if (!authorizer) throw new Error("SETTLEMENT_AUTHORIZER_NOT_CONFIGURED");
  const result = await submitPossiblyDelivered(() => authorizer.settleGame({
    gameId: payload.gameId, winner: payload.winner, resultMultiplier: payload.resultMultiplier,
    cubeValue: payload.cubeValue, cubeWasTurned: payload.cubeWasTurned, settlementId: payload.settlementId,
  }, effect.providerIdempotencyKey));
  await verifyAuthorizerTransaction({
    snapshot: before.snapshot,
    txHash: result.txHash,
    quote: before.quote,
    message: { settle: {
      game_id: payload.gameId, winner: payload.winner, result_multiplier: payload.resultMultiplier,
      cube_value: payload.cubeValue, cube_was_turned: payload.cubeWasTurned, settlement_id: payload.settlementId,
    } },
  });
  const after = await attestedEscrowGame({ gameId: payload.gameId, quoteId: payload.quoteId });
  if (after.escrow.status !== "settled" || !hasExpectedSettlementReceipt(after.escrow, payload) || !after.escrow.receipt) {
    if (after.escrow.status === "settled" || after.escrow.status === "refunded" || after.escrow.receipt !== null) {
      await quarantineCashEscrowEffect({
        effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
        quoteId: payload.quoteId, reason: "escrow_settle_terminal_mismatch",
      });
      return true;
    }
    throw new CashEffectPendingError("escrow_settle_confirmation_pending");
  }
  const finality = await requireFinalEscrowState(after.snapshot, after.escrow.receipt.terminal_height);
  await markCashSettled({
    effectId: effect.id, operationId: effect.operationId, quoteId: payload.quoteId, leaseToken: effect.leaseToken,
    txHash: result.txHash, gameId: payload.gameId,
    attestation: {
      transactionHeight: finality.height, finalityBlockHash: finality.blockHash, source: "transaction",
      authorizerKeyId: result.signingKeyId, terminalId: after.escrow.receipt.terminal_id, receipt: after.escrow.receipt,
    },
  });
  return true;
}
