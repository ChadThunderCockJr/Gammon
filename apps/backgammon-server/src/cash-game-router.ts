import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { maximumReserve, parseUsdToMicroUsd } from "@xion-beginner/backgammon-core";
import { z } from "zod";
import { evaluateFundsAction, FundsActionDeniedError } from "./action-policy.js";
import { queryEscrowConfig, verifyReserveTransaction } from "./cash-game-chain.js";
import {
  acceptCashQuote,
  acknowledgeCashGameStart,
  acknowledgeCashRealityCheck,
  confirmReserve,
  createCashQuote,
  getCashQuote,
  legacyCashReconciliationBlockers,
  listCashQuotes,
  requestCashGameResume,
  resolveCashQuoteRefund,
  resolveCashQuoteSettlement,
} from "./cash-game-store.js";
import { payloadHash } from "./finance-crypto.js";
import { authoritativeBalance } from "./finance-router.js";
import { fundsGate } from "./funds-config.js";
import {
  paidEscrowGrantIsSufficient,
  requireCsrf,
  requireSession,
  type AuthenticatedRequest,
  type SessionRecord,
} from "./session.js";
import { isBlockedEitherDirection } from "./social-store.js";

const router = express.Router();
const XION_ADDRESS = /^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/;
const CreateQuote = z.object({
  opponent: z.string().regex(XION_ADDRESS),
  stakeUsd: z.string().regex(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,5}(?:\.\d{1,2})?)$/),
}).strict();
const AcceptQuote = z.object({
  quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
  consent: z.object({
    acceptedAt: z.string().datetime(),
    cashTermsVersion: z.string().min(1).max(100),
    responsiblePlayVersion: z.string().min(1).max(100),
    maximumLossAcknowledged: z.literal(true),
    testFundsAcknowledged: z.boolean(),
  }).strict(),
}).strict();

const EscrowChainSnapshotSchema = z.object({
  chainId: z.string().min(1),
  genesisHash: z.string().regex(/^[0-9a-f]{64}$/i),
  escrowContract: z.string().regex(XION_ADDRESS),
  escrowCodeChecksum: z.string().regex(/^[0-9a-f]{64}$/i),
  denom: z.string().min(1),
  finalityBlocks: z.number().int().positive().max(1_000),
  settlementAuthority: z.string().regex(XION_ADDRESS),
  escrowAdmin: z.string().regex(XION_ADDRESS),
  rakeBps: z.number().int().min(0).max(10_000),
  rakeRecipient: z.string().regex(XION_ADDRESS),
  minStakePerPoint: z.string().regex(/^[1-9]\d*$/),
  maxStakePerPoint: z.string().regex(/^[1-9]\d*$/),
  fundingTimeoutSeconds: z.number().int().positive(),
  cubeCap: z.number().int().positive(),
  rulesVersion: z.string().min(1),
  rakeCapMicroUsd: z.string().regex(/^(0|[1-9]\d*)$/),
  rulesHash: z.string().regex(/^[0-9a-f]{64}$/),
  authorizerContract: z.string().regex(XION_ADDRESS),
  authorizerSigningKeyId: z.string().min(1),
}).strict();
const ConfirmReserve = z.object({ txHash: z.string().regex(/^[0-9A-Fa-f]{64}$/) }).strict();
const OperatorResolution = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refund") }).strict(),
  z.object({
    action: z.literal("settle"),
    winner: z.string().regex(XION_ADDRESS),
    cubeValue: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
    resultMultiplier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    cubeWasTurned: z.boolean(),
  }).strict(),
]);

function requireCashRecoveryOperator(request: Request): void {
  const configured = process.env.CASH_GAME_RECOVERY_OPERATOR_TOKEN ?? "";
  const supplied = request.get("authorization") ?? "";
  const expected = `Bearer ${configured}`;
  if (
    configured.length < 32
    || supplied.length !== expected.length
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) throw new Error("OPERATOR_AUTHORIZATION_REQUIRED");
}

function authenticated(request: Request): SessionRecord {
  const session = (request as AuthenticatedRequest).session;
  if (!session) throw new Error("AUTHENTICATION_REQUIRED");
  return session;
}

function idempotencyKey(request: Request): string {
  const key = request.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw new TypeError("A valid Idempotency-Key header is required");
  return key;
}

function errorResponse(response: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : "request_failed";
  if (error instanceof FundsActionDeniedError) {
    response.status(403).json({ error: "action_not_allowed", reasonCodes: error.reasonCodes });
    return;
  }
  if (code === "OPERATOR_AUTHORIZATION_REQUIRED") {
    response.status(403).json({ error: "operator_authorization_required" });
    return;
  }
  const clientErrors: Record<string, true> = {
    QUOTE_NOT_FOUND: true,
    QUOTE_HASH_MISMATCH: true,
    QUOTE_EXPIRED: true,
    QUOTE_STATE_CONFLICT: true,
    IDEMPOTENCY_PAYLOAD_MISMATCH: true,
    CHAIN_TRANSACTION_MISMATCH: true,
    CHAIN_TRANSACTION_NOT_FINAL: true,
    ESCROW_STATE_MISMATCH: true,
    INSUFFICIENT_AUTHORIZATION: true,
    INSUFFICIENT_BALANCE: true,
    CONCURRENT_COMMITMENT_LIMIT_REACHED: true,
  };
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
    response.status(400).json({ error: "invalid_request" });
  } else if (code === "QUOTE_NOT_FOUND") {
    response.status(404).json({ error: "quote_not_found" });
  } else if (code === "IDEMPOTENCY_PAYLOAD_MISMATCH" || code === "QUOTE_STATE_CONFLICT") {
    response.status(409).json({ error: code.toLowerCase() });
  } else if (clientErrors[code]) {
    response.status(422).json({ error: code.toLowerCase() });
  } else {
    response.status(503).json({ error: "cash_games_temporarily_unavailable" });
  }
}

function cashTermsVersion(): string {
  return process.env.CASH_GAME_TERMS_VERSION ?? (fundsGate.config.mode === "verusd_testnet" ? "testnet-cash-v1" : "");
}

function responsiblePlayVersion(): string {
  return process.env.RESPONSIBLE_PLAY_POLICY_VERSION ?? (fundsGate.config.mode === "verusd_testnet" ? "testnet-responsible-play-v1" : "");
}

export async function publicCashGameConfig() {
  const state = fundsGate.publicState();
  const legacyBlockers = await legacyCashReconciliationBlockers();
  if (legacyBlockers.length === 0) {
    return {
      ...state,
      rules: fundsGate.config.rulesJson,
      cashTermsVersion: cashTermsVersion() || null,
      responsiblePlayVersion: responsiblePlayVersion() || null,
    };
  }
  const actionBlockers = {
    ...state.actionBlockers,
    wager: [...new Set([...state.actionBlockers.wager, ...legacyBlockers])],
  };
  return {
    ...state,
    actionBlockers,
    wagerEnabled: false,
    blockers: [...new Set([...state.blockers, ...legacyBlockers])],
    rules: fundsGate.config.rulesJson,
    cashTermsVersion: cashTermsVersion() || null,
    responsiblePlayVersion: responsiblePlayVersion() || null,
  };
}

async function assertExposureAllowed(session: SessionRecord, reserve: bigint): Promise<Record<string, unknown>> {
  const legacyBlockers = await legacyCashReconciliationBlockers();
  if (legacyBlockers.length > 0) throw new FundsActionDeniedError(legacyBlockers);
  const decision = await evaluateFundsAction(session.principal, "wager", reserve);
  if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
  const balance = await authoritativeBalance(session.principal);
  if (balance.status !== "fresh" || typeof balance.availableMicroUsd !== "string") throw new Error("BALANCE_UNAVAILABLE");
  if (BigInt(balance.availableMicroUsd) < reserve) {
    throw new Error("INSUFFICIENT_BALANCE");
  }
  if (!await paidEscrowGrantIsSufficient(session, reserve)) throw new Error("INSUFFICIENT_AUTHORIZATION");
  return {
    availableMicroUsd: balance.availableMicroUsd,
    committedMicroUsd: typeof balance.committedMicroUsd === "string" ? balance.committedMicroUsd : "0",
    observedAt: typeof balance.observedAt === "string" ? balance.observedAt : null,
    pendingMicroUsd: typeof balance.pendingMicroUsd === "string" ? balance.pendingMicroUsd : "0",
    status: "fresh",
  };
}

async function assertEscrowEntryStake(stake: bigint): Promise<Record<string, unknown>> {
  const snapshot = fundsGate.escrowRecoverySnapshot();
  if (!snapshot) throw new Error("ESCROW_ATTESTATION_UNAVAILABLE");
  const config = await queryEscrowConfig(snapshot);
  const configuredRules = JSON.parse(fundsGate.config.rulesJson) as Record<string, unknown>;
  const authorizer = fundsGate.config.settlementAuthorizer;
  if (
    config.paused ||
    config.admin !== snapshot.escrowAdmin ||
    config.wager_denom !== snapshot.denom ||
    config.settlement_authority !== snapshot.settlementAuthority ||
    config.rake_bps !== snapshot.rakeBps ||
    config.rake_recipient !== snapshot.rakeRecipient ||
    config.min_stake_per_point !== snapshot.minStakePerPoint ||
    config.max_stake_per_point !== snapshot.maxStakePerPoint ||
    config.funding_timeout_seconds !== snapshot.fundingTimeoutSeconds ||
    config.cube_cap !== snapshot.cubeCap ||
    config.rules_version !== snapshot.rulesVersion ||
    snapshot.rakeCapMicroUsd !== String(configuredRules.rakeCapMicroUsd) ||
    snapshot.rulesHash !== payloadHash(configuredRules) ||
    !authorizer ||
    authorizer.contract !== snapshot.authorizerContract ||
    authorizer.signingKeyId !== snapshot.authorizerSigningKeyId ||
    stake < BigInt(config.min_stake_per_point) ||
    stake > BigInt(config.max_stake_per_point)
  ) throw new Error("ESCROW_STAKE_NOT_ALLOWED");
  return { ...snapshot };
}
router.get("/config", async (_request, response) => {
  response.json(await publicCashGameConfig());
});

router.use(requireSession);

router.get("/quotes", async (request, response) => {
  try {
    response.json({ quotes: await listCashQuotes(authenticated(request).principal) });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.get("/quotes/:id/recovery", async (request, response) => {
  try {
    const quote = await getCashQuote(authenticated(request).principal, z.string().uuid().parse(request.params.id));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    response.json({ quote });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/quotes/:id/reality-check-ack", requireCsrf, async (request, response) => {
  try {
    response.json({
      quote: await acknowledgeCashRealityCheck(authenticated(request).principal, z.string().uuid().parse(request.params.id)),
    });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/quotes/:id/funded-start-ack", requireCsrf, async (request, response) => {
  try {
    response.json({
      quote: await acknowledgeCashGameStart(authenticated(request).principal, z.string().uuid().parse(request.params.id)),
    });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/quotes/:id/recovery/resume", requireCsrf, async (request, response) => {
  try {
    response.json({
      quote: await requestCashGameResume(authenticated(request).principal, z.string().uuid().parse(request.params.id)),
    });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/operator/quotes/:id/resolution", requireCsrf, async (request, response) => {
  try {
    const session = authenticated(request);
    requireCashRecoveryOperator(request);
    const quoteId = z.string().uuid().parse(request.params.id);
    const body = OperatorResolution.parse(request.body);
    const quote = body.action === "refund"
      ? await resolveCashQuoteRefund({ operatorId: session.principal, quoteId })
      : await resolveCashQuoteSettlement({
        operatorId: session.principal,
        quoteId,
        winner: body.winner,
        cubeValue: body.cubeValue,
        resultMultiplier: body.resultMultiplier,
        cubeWasTurned: body.cubeWasTurned,
      });
    response.json({ quote });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.get("/quotes/:id", async (request, response) => {
  try {
    const session = authenticated(request);
    const quote = await getCashQuote(session.principal, z.string().uuid().parse(request.params.id));
    if (!quote) {
      response.status(404).json({ error: "quote_not_found" });
      return;
    }
    response.json({ quote });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/quotes", requireCsrf, async (request, response) => {
  try {
    const session = authenticated(request);
    const body = CreateQuote.parse(request.body);
    if (await isBlockedEitherDirection(session.principal, body.opponent)) {
      throw new FundsActionDeniedError(["player_blocked"]);
    }
    const stake = parseUsdToMicroUsd(body.stakeUsd);
    if (stake <= 0n) throw new RangeError("Stake must be positive");
    const balanceSnapshot = await assertExposureAllowed(session, maximumReserve(stake));
    const escrowSnapshot = await assertEscrowEntryStake(stake);
    const quote = await createCashQuote({
      playerA: session.principal,
      playerB: body.opponent,
      stakeMicroUsd: stake,
      idempotencyKey: idempotencyKey(request),
      balanceSnapshot,
      legalSnapshot: fundsGate.publicState().legalVersions,
      termsSnapshot: {
        cashTermsVersion: cashTermsVersion(),
        cancellation: "Unaccepted offers expire. Funded interruptions pause for participant review; settlement occurs only from a verified result, otherwise the escrow is refunded or operator-resolved.",
        custody: "Verified reserves are held by the Xion verUSD escrow contract until settlement or refund.",
        expirySeconds: 900,
        recovery: "No-forfeit review; both participants may resume after an interruption. Funding timeout, no-show, disconnect, and proof failure are reconciled to refund or review.",
        responsiblePlayVersion: responsiblePlayVersion(),
        rules: JSON.parse(fundsGate.config.rulesJson) as Record<string, unknown>,
        timing: "Turn, response, disconnect, and proof-failure timing are fixed by the rules snapshot.",
      },
      escrowSnapshot,
    });
    response.status(201).json({ quote });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/quotes/:id/accept", requireCsrf, async (request, response) => {
  try {
    const session = authenticated(request);
    const body = AcceptQuote.parse(request.body);
    const quote = await getCashQuote(session.principal, z.string().uuid().parse(request.params.id));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    const opponent = quote.playerA === session.principal ? quote.playerB : quote.playerA;
    if (await isBlockedEitherDirection(session.principal, opponent)) {
      throw new FundsActionDeniedError(["player_blocked"]);
    }
    const acceptedAt = Date.parse(body.consent.acceptedAt);
    if (!Number.isFinite(acceptedAt) || Math.abs(Date.now() - acceptedAt) > 10 * 60_000) throw new TypeError("Stale consent");
    if (
      body.consent.cashTermsVersion !== quote.termsSnapshot.cashTermsVersion ||
      body.consent.responsiblePlayVersion !== quote.termsSnapshot.responsiblePlayVersion ||
      body.consent.testFundsAcknowledged !== quote.testFunds
    ) throw new TypeError("Consent version mismatch");
    const acceptanceBalanceSnapshot = await assertExposureAllowed(session, BigInt(quote.reservePerPlayerMicroUsd));
    const accepted = await acceptCashQuote({
      principal: session.principal,
      quoteId: quote.id,
      quoteHash: body.quoteHash,
      consentSnapshot: {
        ...body.consent,
        fundsMode: quote.fundsMode,
        reservePerPlayerMicroUsd: quote.reservePerPlayerMicroUsd,
      },
      evidenceSnapshot: {
        asset: quote.asset,
        balance: acceptanceBalanceSnapshot,
        legal: fundsGate.publicState().legalVersions,
        quoteHash: quote.quoteHash,
        rules: quote.rules,
        terms: quote.termsSnapshot,
      },
    });
    response.json({ quote: accepted });
  } catch (error) {
    errorResponse(response, error);
  }
});

router.post("/quotes/:id/reserve-confirmation", requireCsrf, async (request, response) => {
  try {
    const session = authenticated(request);
    const body = ConfirmReserve.parse(request.body);
    const quote = await getCashQuote(session.principal, z.string().uuid().parse(request.params.id));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    const snapshot = EscrowChainSnapshotSchema.parse(quote.escrowSnapshot);
    const verified = await verifyReserveTransaction({
      snapshot,
      txHash: body.txHash,
      principal: session.principal,
      signer: session.signer,
      gameId: quote.gameId,
      expectedAmountMicroUsd: quote.reservePerPlayerMicroUsd,
    });
    if (verified.escrow.quote_hash !== quote.quoteHash) throw new Error("ESCROW_STATE_MISMATCH");
    const updated = await confirmReserve({
      principal: session.principal,
      quoteId: quote.id,
      txHash: body.txHash.toUpperCase(),
      chainHeight: verified.height,
      finalityBlockHash: verified.blockHash,
    });
    response.json({ quote: updated });
  } catch (error) {
    errorResponse(response, error);
  }
});

export { router as cashGameRouter };
