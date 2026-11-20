import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Secp256k1 } from "@cosmjs/crypto";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { formatMicroUsd, parseMicroUsd, parseUsdToMicroUsd } from "@xion-beginner/backgammon-core";
import {
  applyImmediateRestriction,
  FundsActionDeniedError,
  evaluateFundsAction,
  getPlayRestrictions,
  requestRestrictionLimitChange,
  type RestrictionLimitType,
} from "./action-policy.js";
import { getPool } from "./db.js";
import {
  decryptSensitiveJson,
  encryptSensitiveJson,
  payloadHash,
  sensitivePayloadHash,
  type EncryptedPayload,
} from "./finance-crypto.js";
import {
  acceptWebhookEvent,
  authorizeDirectEffectDispatch,
  createMoneyOperation,
  createOrLeaseDirectEffect,
  enqueueEffectForOperation,
  failDirectEffect,
  finalizeDirectEffect,
  getOperation,
  getPaymentMethod,
  getOperationResult,
  getPaymentProfile,
  recordCashOutInboundChain,
  retryDirectAccountEffect,
  listOperations,
  listPaymentMethods,
  type DirectEffectLease,
  type MoneyOperation,
} from "./finance-store.js";
import { createConfiguredBraleClient, BraleApiError, type IndividualAccountInput } from "./brale.js";
import { fundsGate } from "./funds-config.js";
import {
  requireCsrf,
  requireSession,
  requireFinanceStepUp,
  type AuthenticatedRequest,
} from "./session.js";
import { logger } from "./logger.js";

const router = express.Router();
const XION_ADDRESS = /^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/;
const TX_HASH = /^[0-9A-Fa-f]{64}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERSON_NAME = /^\p{L}[\p{L} .'-]{0,79}$/u;
const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const POSTAL_CODE = /^[A-Z0-9](?:[A-Z0-9 -]{0,17}[A-Z0-9])?$/;
const DOCUMENT_NUMBER = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,78}[A-Za-z0-9])?$/;
const DOCUMENT_TYPES: Record<string, true> = { drivers_license: true, passport: true };

function bodyRecord(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new TypeError("Request body must be an object");
  }
  return request.body as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, max = 200): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`Invalid ${key}`);
  return value.trim();
}

function canonicalPersonName(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 80).replace(/\s+/g, " ");
  if (!PERSON_NAME.test(value)) throw new TypeError(`Invalid ${key}`);
  return value;
}

function canonicalDate(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 10);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function canonicalEmail(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 254).toLowerCase();
  if (!EMAIL.test(value)) throw new TypeError(`Invalid ${key}`);
  return value;
}

function canonicalCountry(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 2).toUpperCase();
  if (!COUNTRY_CODE.test(value)) throw new TypeError(`Invalid ${key}`);
  return value;
}

function canonicalPostalCode(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 20).toUpperCase().replace(/\s+/g, " ");
  if (!POSTAL_CODE.test(value)) throw new TypeError(`Invalid ${key}`);
  return value;
}
function requiredUsdAmount(record: Record<string, unknown>, key: string): bigint {
  const value = requiredString(record, key, 40);
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value)) {
    throw new TypeError(`${key} must use whole-cent precision`);
  }
  return parseUsdToMicroUsd(value);
}

function idempotencyKey(request: Request): string {
  const value = request.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(value)) throw new TypeError("A valid Idempotency-Key header is required");
  return value;
}

export function validatedConsentAcceptedAt(value: string, now = Date.now()): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError("Consent timestamp is invalid");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError("Consent timestamp is invalid");
  }
  if (Math.abs(now - timestamp) > 10 * 60 * 1_000) throw new TypeError("Consent timestamp is stale");
  return value;
}

function authenticated(request: Request): AuthenticatedRequest & { session: NonNullable<AuthenticatedRequest["session"]> } {
  const secured = request as AuthenticatedRequest;
  if (!secured.session) throw new Error("AUTHENTICATION_REQUIRED");
  return secured as AuthenticatedRequest & { session: NonNullable<AuthenticatedRequest["session"]> };
}

function consentSnapshot(
  record: Record<string, unknown>,
  purpose: "enroll" | "link_bank" | "deposit" | "cash_out",
  reviewedContext: Record<string, unknown>,
): Record<string, unknown> {
  const consent = record.consent;
  if (!consent || typeof consent !== "object" || Array.isArray(consent)) throw new TypeError("Consent is required");
  const values = consent as Record<string, unknown>;
  const acceptedAt = validatedConsentAcceptedAt(requiredString(values, "acceptedAt", 40));
  if (values.purpose !== purpose) throw new TypeError("Consent purpose mismatch");
  if (!values.reviewedContext || typeof values.reviewedContext !== "object" || Array.isArray(values.reviewedContext)) {
    throw new TypeError("Consent review context is required");
  }
  if (payloadHash(values.reviewedContext) !== payloadHash(reviewedContext)) {
    throw new TypeError("Consent review context mismatch");
  }
  const documents = fundsGate.config.legalDocuments;
  if (!documents) throw new TypeError("Required legal documents are unavailable");
  const legalDocuments = {
    braleEua: { url: documents.braleEua.url, version: documents.braleEua.version, sha256: documents.braleEua.sha256 },
    plaidPrivacy: { url: documents.plaidPrivacy.url, version: documents.plaidPrivacy.version, sha256: documents.plaidPrivacy.sha256 },
    achAuthorization: { url: documents.achAuthorization.url, version: documents.achAuthorization.version, sha256: documents.achAuthorization.sha256 },
  };
  if (!values.legalDocuments || typeof values.legalDocuments !== "object" || Array.isArray(values.legalDocuments)) {
    throw new TypeError("Legal document consent is required");
  }
  if (payloadHash(values.legalDocuments) !== payloadHash(legalDocuments)) {
    throw new TypeError("Legal document consent mismatch");
  }
  const expected = {
    termsVersion: process.env.TERMS_VERSION,
    privacyVersion: process.env.PRIVACY_VERSION,
    braleEuaVersion: documents.braleEua.version,
    plaidPrivacyVersion: documents.plaidPrivacy.version,
    achAuthorizationVersion: documents.achAuthorization.version,
  };
  for (const [key, version] of Object.entries(expected)) {
    if (!version || values[key] !== version) throw new TypeError(`Consent version mismatch: ${key}`);
  }
  return {
    ...expected,
    legalDocuments,
    acceptedAt,
    purpose,
    reviewedContext,
    reviewDigest: payloadHash({ purpose, reviewedContext, legalDocuments, ...expected }),
  };
}

function identityPayload(record: Record<string, unknown>, request: Request, consentAcceptedAt: string): IndividualAccountInput {
  const identity = record.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new TypeError("Identity is required");
  const source = identity as Record<string, unknown>;
  const addressValue = source.address;
  const identityValue = source.identity;
  if (!addressValue || typeof addressValue !== "object" || Array.isArray(addressValue)) throw new TypeError("Address is required");
  if (!identityValue || typeof identityValue !== "object" || Array.isArray(identityValue)) throw new TypeError("Identity document is required");
  const address = addressValue as Record<string, unknown>;
  const document = identityValue as Record<string, unknown>;
  const phoneNumber = requiredString(source, "phoneNumber", 32);
  const documentNumber = requiredString(document, "number", 80);
  const documentType = requiredString(document, "type", 30);
  if (!E164_PHONE.test(phoneNumber)) throw new TypeError("Invalid phoneNumber");
  if (!DOCUMENT_NUMBER.test(documentNumber)) throw new TypeError("Invalid identity document number");
  if (!DOCUMENT_TYPES[documentType]) throw new TypeError("Invalid identity document type");
  return {
    firstName: canonicalPersonName(source, "firstName"),
    lastName: canonicalPersonName(source, "lastName"),
    dateOfBirth: canonicalDate(source, "dateOfBirth"),
    email: canonicalEmail(source, "email"),
    phoneNumber,
    country: canonicalCountry(source, "country"),
    address: {
      streetLine1: requiredString(address, "streetLine1", 120).replace(/\s+/g, " "),
      ...(typeof address.streetLine2 === "string" && address.streetLine2.trim()
        ? { streetLine2: address.streetLine2.trim().replace(/\s+/g, " ").slice(0, 120) }
        : {}),
      city: requiredString(address, "city", 100).replace(/\s+/g, " "),
      state: requiredString(address, "state", 100).replace(/\s+/g, " "),
      postalCode: canonicalPostalCode(address, "postalCode"),
    },
    identity: {
      number: documentNumber,
      type: documentType,
    },
    termsVersion: fundsGate.config.legalDocuments?.braleEua.version ?? "",
    acceptedAt: consentAcceptedAt,
    ip: (request.ip ?? request.socket.remoteAddress ?? "unknown").slice(0, 64),
    userAgent: (request.get("user-agent") ?? "unknown").slice(0, 500),
  };
}

function safeError(response: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : "request_failed";
  if (error instanceof FundsActionDeniedError) {
    response.status(403).json({ error: "action_not_allowed", reasonCodes: error.reasonCodes });
    return;
  }
  if (code === "FINANCE_STEP_UP_REPLAYED") {
    response.status(409).json({ error: "finance_step_up_replayed" });
    return;
  }
  if (code === "FINANCE_STEP_UP_REQUIRED" || code === "FINANCE_STEP_UP_GRANT_REQUIRED") {
    response.status(403).json({ error: "finance_step_up_required" });
    return;
  }
  if (code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
    response.status(409).json({ error: "idempotency_payload_mismatch" });
    return;
  }
  if (code === "OPERATION_NOT_FOUND") {
    response.status(404).json({ error: "operation_not_found" });
    return;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    response.status(400).json({ error: "invalid_request", message: error.message });
    return;
  }
  response.status(503).json({ error: "service_temporarily_unavailable", reference: randomUUID() });
}

async function directProviderCall<T>(
  direct: DirectEffectLease,
  requireFreshClientCredentialOnAmbiguity: boolean,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    if (!direct.effectId || !direct.leaseToken) throw error;
    if (requireFreshClientCredentialOnAmbiguity) {
      await failDirectEffect({
        effectId: direct.effectId,
        operationId: direct.operation.id,
        leaseToken: direct.leaseToken,
        errorCode: "provider_response_ambiguous",
        requireFreshClientCredential: true,
      });
      throw new TypeError("A fresh client credential is required");
    }
    if (error instanceof BraleApiError && !error.retryable) {
      await failDirectEffect({
        effectId: direct.effectId,
        operationId: direct.operation.id,
        leaseToken: direct.leaseToken,
        errorCode: error.providerCode ?? `provider_http_${error.status}`,
      });
      throw new TypeError("Payment provider rejected the request");
    }
    await retryDirectAccountEffect({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      errorCode: "provider_response_ambiguous",
    });
    throw error;
  }
}

export async function authoritativeBalance(principal: string, action: "deposit" | "cash_out" | "history" = "history"): Promise<Record<string, unknown>> {
  const asset = fundsGate.config.asset;
  if (!asset) return { status: "unavailable", reason: "free_play_only" };
  const blockers = action === "history" ? fundsGate.balanceReadBlockers() : fundsGate.blockersFor(action);
  if (blockers.length > 0) return { status: "unavailable", reason: "chain_identity_untrusted" };
  const response = await fetch(
    `${asset.restUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/balances/${principal}/by_denom?denom=${encodeURIComponent(asset.denom)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) return { status: "unavailable", reason: "chain_query_failed" };
  const body = await response.json() as { balance?: { amount?: unknown; denom?: unknown } };
  const rawAmount = body.balance?.amount;
  if (typeof rawAmount !== "string" || !/^(0|[1-9]\d*)$/.test(rawAmount) || body.balance?.denom !== asset.denom) {
    return { status: "unavailable", reason: "invalid_chain_response" };
  }
  const pool = getPool();
  let finalEscrowReserved = 0n;
  let pendingReserveEvidence = 0n;
  let returnRiskHeld = 0n;
  let inWalletCommitments = 0n;
  if (pool) {
    const unresolvedCashOut = await pool.query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM late_cash_out_completion_reconstruction_requirements requirement
           JOIN money_operations operation ON operation.id = requirement.operation_id
          WHERE operation.principal = $1
       ) AS pending`,
      [principal],
    );
    if (unresolvedCashOut.rows[0]?.pending) {
      return { status: "unavailable", reason: "financial_reconciliation_required" };
    }
    const reserves = await pool.query<{ pending_evidence: string; final_escrow: string }>(
      `SELECT COALESCE(SUM(amount_micro_usd) FILTER (WHERE state = 'pending'), 0)::text AS pending_evidence,
              COALESCE(SUM(amount_micro_usd) FILTER (WHERE state = 'final'), 0)::text AS final_escrow
         FROM cash_game_reserves WHERE principal = $1`,
      [principal],
    );
    pendingReserveEvidence = BigInt(reserves.rows[0]?.pending_evidence ?? "0");
    finalEscrowReserved = BigInt(reserves.rows[0]?.final_escrow ?? "0");
    const pending = await pool.query<{ pending: string }>(
      `SELECT COALESCE(SUM(amount_micro_usd), 0)::text AS pending
         FROM cash_game_commitments WHERE principal = $1 AND state = 'pending'`,
      [principal],
    );
    inWalletCommitments = BigInt(pending.rows[0]?.pending ?? "0");
    const risk = await pool.query<{ held: string }>(
      `SELECT COALESCE(SUM(operation.amount_micro_usd), 0)::text AS held
         FROM money_operations operation
        WHERE operation.principal = $1
          AND operation.amount_micro_usd IS NOT NULL
          AND (
            (
              operation.kind = 'deposit'
              AND (
                operation.state IN ('queued', 'pending', 'processing', 'review')
                OR (
                  operation.state IN ('failed', 'canceled')
                  AND operation.provider_transfer_id IS NOT NULL
                  AND COALESCE(
                    (
                      SELECT MIN(history.observed_at)
                        FROM provider_state_history history
                       WHERE history.provider_transfer_id = operation.provider_transfer_id
                         AND history.state IN ('failed', 'canceled')
                    ),
                    operation.updated_at
                  ) + (
                    COALESCE(
                      NULLIF(operation.quote_snapshot->>'achReturnReconciliationHorizonSeconds', '')::integer,
                      31536000
                    ) * INTERVAL '1 second'
                  ) > NOW()
                )
                OR (
                  EXISTS (
                    SELECT 1 FROM journal_batches batch
                     WHERE batch.operation_id = operation.id AND batch.entry_key = 'complete'
                  )
                  AND (
                    operation.state IN ('refunding', 'refunded', 'failed', 'review')
                    OR (
                      operation.state = 'complete'
                      AND operation.updated_at + (
                        COALESCE(NULLIF(operation.quote_snapshot->>'achAvailabilityDelaySeconds', '')::integer, 31536000)
                        * INTERVAL '1 second'
                      ) > NOW()
                    )
                  )
                )
              )
            )
            OR (
              operation.kind = 'cash_out'
              AND (
                EXISTS (
                  SELECT 1 FROM late_cash_out_completion_reviews review
                   WHERE review.operation_id = operation.id
                     AND review.held_micro_usd = operation.amount_micro_usd
                )
                OR (
                  operation.state = 'review'
                  AND operation.failure_code IN (
                    'late_original_cash_out_complete_after_refund',
                    'late_original_cash_out_complete_after_refund_requires_compensation'
                  )
                )
              )
            )
          )`,
      [principal],
    );
    returnRiskHeld = BigInt(risk.rows[0]?.held ?? "0");
  }
  const total = BigInt(rawAmount);
  const unavailable = inWalletCommitments + returnRiskHeld;
  const available = total > unavailable ? total - unavailable : 0n;
  return {
    status: "fresh",
    asset: { symbol: "verUSD", denom: asset.denom, decimals: 6 },
    availableMicroUsd: available.toString(),
    totalMicroUsd: total.toString(),
    totalHoldingsMicroUsd: (total + finalEscrowReserved).toString(),
    committedMicroUsd: inWalletCommitments.toString(),
    reservedMicroUsd: inWalletCommitments.toString(),
    pendingReserveEvidenceMicroUsd: pendingReserveEvidence.toString(),
    finalEscrowReservedMicroUsd: finalEscrowReserved.toString(),
    pendingCommitmentMicroUsd: inWalletCommitments.toString(),
    returnRiskHeldMicroUsd: returnRiskHeld.toString(),
    pendingMicroUsd: returnRiskHeld.toString(),
    deficitMicroUsd: (unavailable > total ? unavailable - total : 0n).toString(),
    observedAt: new Date().toISOString(),
    sourceHeight: response.headers.get("x-cosmos-block-height"),
  };
}
interface CashOutChainAuthorization {
  readonly contract: string;
  readonly messageKey: "authorize_finance_action";
  readonly operationId: string;
  readonly destination: string;
  readonly expiresAt: number;
  readonly signature: string;
}

function createCashOutChainAuthorization(input: {
  principal: string;
  operationId: string;
  destination: string;
  denom: string;
  amountMicroUsd: string;
  chainId: string;
  expiresAt: number;
}): CashOutChainAuthorization {
  const contract = process.env.FINANCE_AUTHORIZATION_CONTRACT?.trim() ?? "";
  const messageKey = process.env.FINANCE_AUTHORIZATION_MESSAGE_KEY?.trim() ?? "";
  const encodedPrivateKey = process.env.CASH_OUT_AUTHORIZATION_PRIVATE_KEY?.trim() ?? "";
  const expectedPublicKey = process.env.CASH_OUT_AUTHORIZATION_PUBLIC_KEY?.trim().toLowerCase() ?? "";
  const privateKey = Buffer.from(encodedPrivateKey, "base64");
  if (
    !XION_ADDRESS.test(contract)
    || messageKey !== "authorize_finance_action"
    || privateKey.length !== 32
    || !/^(02|03)[0-9a-f]{64}$/.test(expectedPublicKey)
  ) throw new Error("CASH_OUT_AUTHORIZATION_UNAVAILABLE");
  const publicKey = Buffer.from(Secp256k1.compressPubkey(Secp256k1.makeKeypair(privateKey).pubkey));
  if (publicKey.toString("hex") !== expectedPublicKey) throw new Error("CASH_OUT_AUTHORIZATION_KEY_MISMATCH");
  const expiresAt = input.expiresAt;
  const payload = [
    "gammon.cash-out.v1",
    input.chainId,
    contract,
    input.principal,
    input.operationId,
    input.destination,
    input.denom,
    input.amountMicroUsd,
    String(expiresAt),
  ].join("|");
  const digest = createHash("sha256").update(payload, "utf8").digest();
  const extended = Secp256k1.createSignature(digest, privateKey);
  const signature = Buffer.concat([Buffer.from(extended.r(32)), Buffer.from(extended.s(32))]).toString("base64");
  return {
    contract,
    messageKey: "authorize_finance_action",
    operationId: input.operationId,
    destination: input.destination,
    expiresAt,
    signature,
  };
}

function decodedContractMessage(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function singleAuthorizedChainMessage(
  messages: Array<Record<string, unknown>>,
  signer: string,
): Record<string, unknown> {
  if (messages.length !== 1) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const outer = messages[0];
  if (outer["@type"] !== "/cosmos.authz.v1beta1.MsgExec") return outer;
  const delegated = Array.isArray(outer.msgs) ? outer.msgs as Array<Record<string, unknown>> : [];
  if (outer.grantee !== signer || delegated.length !== 1) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  return delegated[0];
}


interface CashOutDepositVerificationInput {
  principal: string;
  signer: string;
  destination: string;
  amountMicroUsd: string;
  assetDenom: string;
  authorizationContract: string;
  operationId: string;
  chainRestUrl: string;
  chainId: string;
  genesisHash: string;
  finalityBlocks: number;
}

async function verifyCashOutDeposit(
  input: CashOutDepositVerificationInput & { txHash: string },
): Promise<{ height: number }> {
  const rest = input.chainRestUrl.replace(/\/$/, "");
  const [nodeResponse, genesisResponse, txResponse] = await Promise.all([
    fetch(`${rest}/cosmos/base/tendermint/v1beta1/node_info`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/1`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${rest}/cosmos/tx/v1beta1/txs/${input.txHash}`, { signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!nodeResponse.ok || !genesisResponse.ok) throw new Error("CHAIN_IDENTITY_UNAVAILABLE");
  const node = await nodeResponse.json() as { default_node_info?: { network?: string } };
  const genesis = await genesisResponse.json() as { block_id?: { hash?: string }; block?: { header?: { app_hash?: string } } };
  const observedGenesis = (genesis.block_id?.hash ?? genesis.block?.header?.app_hash)?.toLowerCase();
  if (node.default_node_info?.network !== input.chainId || observedGenesis !== input.genesisHash) {
    throw new Error("CHAIN_IDENTITY_MISMATCH");
  }
  if (!txResponse.ok) throw new Error("CHAIN_TRANSACTION_NOT_FOUND");
  const txBody = await txResponse.json() as {
    tx?: { body?: { messages?: Array<Record<string, unknown>> } };
    tx_response?: { code?: number; height?: string; txhash?: string };
  };
  const transaction = txBody.tx_response;
  if (
    !transaction
    || transaction.code !== 0
    || transaction.txhash?.toLowerCase() !== input.txHash.toLowerCase()
  ) {
    throw new Error("CHAIN_TRANSACTION_MISMATCH");
  }
  const message = singleAuthorizedChainMessage(
    (txBody.tx?.body?.messages ?? []) as Array<Record<string, unknown>>,
    input.signer,
  );
  if (
    message["@type"] !== "/cosmwasm.wasm.v1.MsgExecuteContract"
    || message.sender !== input.principal
    || message.contract !== input.authorizationContract
  ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const funds = Array.isArray(message.funds) ? message.funds as Array<Record<string, unknown>> : [];
  const decoded = decodedContractMessage(message.msg);
  const authorization = decoded?.authorize_finance_action;
  const authorizationRecord = authorization && typeof authorization === "object" && !Array.isArray(authorization)
    ? authorization as Record<string, unknown>
    : null;
  const expiresAt = authorizationRecord?.expires_at;
  const signature = authorizationRecord?.signature;
  if (
    funds.length !== 1
    || funds[0].denom !== input.assetDenom
    || funds[0].amount !== input.amountMicroUsd
    || !authorizationRecord
    || !Number.isSafeInteger(expiresAt)
    || typeof signature !== "string"
    || !/^[A-Za-z0-9+/]{86}==$/.test(signature)
    || payloadHash(decoded) !== payloadHash({
      authorize_finance_action: {
        operation_id: input.operationId,
        destination: input.destination,
        expires_at: expiresAt,
        signature,
      },
    })
  ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const latestResponse = await fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!latestResponse.ok) throw new Error("CHAIN_FINALITY_UNAVAILABLE");
  const latest = await latestResponse.json() as { block?: { header?: { height?: string } } };
  const txHeight = Number(transaction.height);
  const latestHeight = Number(latest.block?.header?.height);
  if (!Number.isSafeInteger(txHeight) || !Number.isSafeInteger(latestHeight) || latestHeight - txHeight < input.finalityBlocks) {
    throw new Error("CHAIN_TRANSACTION_NOT_FINAL");
  }
  return { height: txHeight };
}

async function recoverCashOutDepositTransaction(
  input: CashOutDepositVerificationInput & { chainRpcUrl: string },
): Promise<string> {
  const client = await CosmWasmClient.connect(input.chainRpcUrl);
  try {
    if (await client.getChainId() !== input.chainId) throw new Error("CHAIN_IDENTITY_MISMATCH");
    const transactions = await client.searchTx([
      { key: "wasm._contract_address", value: input.authorizationContract },
      { key: "wasm.operation_id", value: input.operationId },
      { key: "wasm.principal", value: input.principal },
    ]);
    for (const transaction of transactions) {
      const txHash = transaction.hash.toUpperCase();
      if (transaction.code !== 0 || !TX_HASH.test(txHash)) continue;
      try {
        await verifyCashOutDeposit({ ...input, txHash });
        return txHash;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "CHAIN_TRANSACTION_MISMATCH" || code === "CHAIN_TRANSACTION_NOT_FOUND") continue;
        throw error;
      }
    }
    throw new Error("CHAIN_TRANSACTION_NOT_FOUND");
  } finally {
    client.disconnect();
  }
}
interface CashOutSnapshotRow {
  payment_method_id: string;
  provider_account_id: string;
  provider_address_id: string;
  internal_address_id: string;
  external_wallet_address_id: string;
  internal_wallet_address: string;
  originating_wallet_address: string;
  authorized_signer: string | null;
  asset_denom: string;
  chain_rpc_url: string | null;
  chain_rest_url: string;
  chain_id: string;
  genesis_hash: string;
  finality_blocks: string;
  funds_mode: "verusd_testnet" | "verusd_production";
  transfer_type: "verona_testnet" | "verona";
  finance_authorization_contract: string;
}

const CASH_OUT_AUTHORIZATION_SECONDS = 10 * 60;

async function loadCashOutSnapshot(operationId: string, principal: string): Promise<CashOutSnapshotRow | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query<CashOutSnapshotRow>(
    `SELECT quote_snapshot->>'paymentMethodId' AS payment_method_id,
            quote_snapshot->>'providerAccountId' AS provider_account_id,
            quote_snapshot->>'providerAddressId' AS provider_address_id,
            quote_snapshot->>'internalAddressId' AS internal_address_id,
            quote_snapshot->>'externalWalletAddressId' AS external_wallet_address_id,
            quote_snapshot->>'internalWalletAddress' AS internal_wallet_address,
            quote_snapshot->>'originatingWalletAddress' AS originating_wallet_address,
            quote_snapshot->>'authorizedSigner' AS authorized_signer,
            quote_snapshot->>'assetDenom' AS asset_denom,
            quote_snapshot->>'chainRpcUrl' AS chain_rpc_url,
            quote_snapshot->>'chainRestUrl' AS chain_rest_url,
            quote_snapshot->>'chainId' AS chain_id,
            quote_snapshot->>'genesisHash' AS genesis_hash,
            quote_snapshot->>'finalityBlocks' AS finality_blocks,
            quote_snapshot->>'fundsMode' AS funds_mode,
            quote_snapshot->>'transferType' AS transfer_type,
            quote_snapshot->>'financeAuthorizationContract' AS finance_authorization_contract
       FROM money_operations
      WHERE id = $1 AND principal = $2 AND kind = 'cash_out'`,
    [operationId, principal],
  );
  return result.rows[0] ?? null;
}

function assertCashOutSnapshot(
  snapshot: CashOutSnapshotRow | null,
  operation: MoneyOperation,
  requireRpc: boolean,
): asserts snapshot is CashOutSnapshotRow {
  if (
    !snapshot?.payment_method_id ||
    !snapshot.provider_account_id ||
    !snapshot.provider_address_id ||
    !snapshot.internal_address_id ||
    !snapshot.external_wallet_address_id ||
    !snapshot.internal_wallet_address ||
    !snapshot.asset_denom ||
    snapshot.asset_denom !== operation.assetDenom ||
    !snapshot.chain_rest_url ||
    !snapshot.chain_id ||
    (requireRpc && !snapshot.chain_rpc_url) ||
    !/^[0-9a-f]{64}$/.test(snapshot.genesis_hash ?? "") ||
    !/^[1-9]\d*$/.test(snapshot.finality_blocks ?? "") ||
    (snapshot.funds_mode !== "verusd_testnet" && snapshot.funds_mode !== "verusd_production") ||
    (snapshot.transfer_type !== "verona_testnet" && snapshot.transfer_type !== "verona") ||
    snapshot.originating_wallet_address !== operation.principal ||
    !XION_ADDRESS.test(snapshot.finance_authorization_contract ?? "") ||
    snapshot.finance_authorization_contract !== process.env.FINANCE_AUTHORIZATION_CONTRACT ||
    (snapshot.authorized_signer !== null && !XION_ADDRESS.test(snapshot.authorized_signer))
  ) {
    throw new Error("CASH_OUT_SNAPSHOT_UNAVAILABLE");
  }
}

function cashOutAuthorizationExpiresAt(operation: MoneyOperation): number {
  return Math.floor(new Date(operation.createdAt).getTime() / 1_000) + CASH_OUT_AUTHORIZATION_SECONDS;
}

function cashOutFundingInstruction(operation: MoneyOperation, snapshot: CashOutSnapshotRow) {
  if (!operation.amountMicroUsd) throw new Error("CASH_OUT_SNAPSHOT_UNAVAILABLE");
  const expiresAt = cashOutAuthorizationExpiresAt(operation);
  if (expiresAt <= Math.floor(Date.now() / 1_000)) throw new Error("CASH_OUT_AUTHORIZATION_EXPIRED");
  const authorization = createCashOutChainAuthorization({
    principal: operation.principal,
    operationId: operation.id,
    destination: snapshot.internal_wallet_address,
    denom: snapshot.asset_denom,
    expiresAt,
    amountMicroUsd: operation.amountMicroUsd,
    chainId: snapshot.chain_id,
  });
  return {
    from: operation.principal,
    to: snapshot.internal_wallet_address,
    denom: snapshot.asset_denom,
    amountMicroUsd: operation.amountMicroUsd,
    displayAmount: formatMicroUsd(BigInt(operation.amountMicroUsd)),
    contract: authorization.contract,
    messageKey: authorization.messageKey,
    operationId: authorization.operationId,
    destination: authorization.destination,
    expiresAt: authorization.expiresAt,
    signature: authorization.signature,
  };
}

async function findActiveCashOutIntent(
  principal: string,
  paymentMethodId: string,
): Promise<{ operation: MoneyOperation; snapshot: CashOutSnapshotRow } | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query<{ id: string }>(
    `SELECT id
       FROM money_operations
      WHERE principal = $1
        AND kind = 'cash_out'
        AND state = 'awaiting_user'
        AND COALESCE(quote_snapshot->>'paymentMethodId', '') = $2
      ORDER BY created_at
      LIMIT 1`,
    [principal, paymentMethodId],
  );
  const operationId = result.rows[0]?.id;
  if (!operationId) return null;
  const [operation, snapshot] = await Promise.all([
    getOperation(principal, operationId),
    loadCashOutSnapshot(operationId, principal),
  ]);
  if (!operation || !operation.amountMicroUsd) return null;
  assertCashOutSnapshot(snapshot, operation, false);
  return { operation, snapshot };
}

async function latestCashOutAfterConflict(
  principal: string,
  operationId: string,
  txHash: string,
): Promise<MoneyOperation | null> {
  const latest = await getOperation(principal, operationId);
  return latest?.chainTxHash === txHash && latest.state !== "awaiting_user" ? latest : null;
}

async function finalizeCashOutIntent(input: {
  operation: MoneyOperation;
  snapshot: CashOutSnapshotRow;
  submittedTxHash?: string | null;
  signerFallback?: string | null;
}): Promise<MoneyOperation> {
  const { operation, snapshot } = input;
  if (!operation.amountMicroUsd) throw new Error("CASH_OUT_SNAPSHOT_UNAVAILABLE");
  assertCashOutSnapshot(snapshot, operation, !input.submittedTxHash && !operation.chainTxHash);
  if (
    operation.chainTxHash &&
    input.submittedTxHash &&
    operation.chainTxHash !== input.submittedTxHash
  ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  if (operation.state !== "awaiting_user") {
    if (!operation.chainTxHash) throw new Error("OPERATION_STATE_CONFLICT");
    return operation;
  }
  const signer = snapshot.authorized_signer ?? input.signerFallback;
  if (!signer) throw new Error("CASH_OUT_SNAPSHOT_UNAVAILABLE");
  const verification: CashOutDepositVerificationInput = {
    principal: operation.principal,
    signer,
    destination: snapshot.internal_wallet_address,
    amountMicroUsd: operation.amountMicroUsd,
    assetDenom: snapshot.asset_denom,
    authorizationContract: snapshot.finance_authorization_contract,
    operationId: operation.id,
    chainRestUrl: snapshot.chain_rest_url,
    chainId: snapshot.chain_id,
    genesisHash: snapshot.genesis_hash,
    finalityBlocks: Number(snapshot.finality_blocks),
  };
  let txHash = input.submittedTxHash ?? operation.chainTxHash;
  if (!txHash) {
    txHash = await recoverCashOutDepositTransaction({
      ...verification,
      chainRpcUrl: snapshot.chain_rpc_url as string,
    });
  } else {
    await verifyCashOutDeposit({ ...verification, txHash });
  }
  try {
    await recordCashOutInboundChain({
      operationId: operation.id,
      principal: operation.principal,
      assetDenom: snapshot.asset_denom,
      amountMicroUsd: operation.amountMicroUsd,
      txHash,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "OPERATION_STATE_CONFLICT") {
      const latest = await latestCashOutAfterConflict(operation.principal, operation.id, txHash);
      if (latest) return latest;
    }
    throw error;
  }
  const transferEffect = {
    paymentMethodId: snapshot.payment_method_id,
    providerAccountId: snapshot.provider_account_id,
    providerAddressId: snapshot.provider_address_id,
    internalAddressId: snapshot.internal_address_id,
    externalWalletAddressId: snapshot.external_wallet_address_id,
    internalWalletAddress: snapshot.internal_wallet_address,
    originatingWalletAddress: snapshot.originating_wallet_address,
    financeAuthorizationContract: snapshot.finance_authorization_contract,
    assetDenom: snapshot.asset_denom,
    chainRpcUrl: snapshot.chain_rpc_url,
    chainRestUrl: snapshot.chain_rest_url,
    chainId: snapshot.chain_id,
    genesisHash: snapshot.genesis_hash,
    finalityBlocks: Number(snapshot.finality_blocks),
    fundsMode: snapshot.funds_mode,
    transferType: snapshot.transfer_type,
  };
  try {
    return await enqueueEffectForOperation({
      principal: operation.principal,
      operationId: operation.id,
      expectedState: "awaiting_user",
      effectType: "create_cash_out",
      encryptedPayload: encryptSensitiveJson(transferEffect, operation.id),
      requestHash: payloadHash({ transferEffect, txHash }),
      chainTxHash: txHash,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "OPERATION_STATE_CONFLICT") {
      const latest = await latestCashOutAfterConflict(operation.principal, operation.id, txHash);
      if (latest) return latest;
    }
    throw error;
  }
}

async function assertPinnedCashOutChain(snapshot: CashOutSnapshotRow): Promise<void> {
  const rest = snapshot.chain_rest_url.replace(/\/$/, "");
  const [nodeResponse, genesisResponse] = await Promise.all([
    fetch(`${rest}/cosmos/base/tendermint/v1beta1/node_info`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/1`, { signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!nodeResponse.ok || !genesisResponse.ok) throw new Error("CHAIN_IDENTITY_UNAVAILABLE");
  const node = await nodeResponse.json() as { default_node_info?: { network?: string } };
  const genesis = await genesisResponse.json() as { block_id?: { hash?: string }; block?: { header?: { app_hash?: string } } };
  const observedGenesis = (genesis.block_id?.hash ?? genesis.block?.header?.app_hash)?.toLowerCase();
  if (node.default_node_info?.network !== snapshot.chain_id || observedGenesis !== snapshot.genesis_hash) {
    throw new Error("CHAIN_IDENTITY_MISMATCH");
  }
}

async function reconcileExpiredCashOutIntent(
  operation: MoneyOperation,
  snapshot: CashOutSnapshotRow,
): Promise<"pending" | "canceled" | "funded"> {
  assertCashOutSnapshot(snapshot, operation, true);
  if (!snapshot.chain_rpc_url) return "pending";
  const client = await CosmWasmClient.connect(snapshot.chain_rpc_url);
  try {
    if (await client.getChainId() !== snapshot.chain_id) throw new Error("CHAIN_IDENTITY_MISMATCH");
    await assertPinnedCashOutChain(snapshot);
    const processed = await client.queryContractSmart(
      snapshot.finance_authorization_contract,
      { processed: { operation_id: operation.id } },
    ) as { sender?: unknown };
    if (processed.sender !== null && processed.sender !== undefined) {
      if (processed.sender !== operation.principal) throw new Error("CHAIN_TRANSACTION_MISMATCH");
      await finalizeCashOutIntent({ operation, snapshot });
      return "funded";
    }
    const latestHeight = await client.getHeight();
    const finalizedHeight = latestHeight - Number(snapshot.finality_blocks);
    if (finalizedHeight < 1) return "pending";
    const finalizedBlock = await client.getBlock(finalizedHeight);
    const finalizedAt = Date.parse(String(finalizedBlock.header.time));
    if (
      !Number.isFinite(finalizedAt) ||
      Math.floor(finalizedAt / 1_000) <= cashOutAuthorizationExpiresAt(operation)
    ) return "pending";
    const result = await getPool()?.query(
      `UPDATE money_operations
          SET state = 'canceled',
              failure_code = 'cash_out_authorization_expired_unfunded',
              updated_at = NOW(),
              version = version + 1
        WHERE id = $1
          AND principal = $2
          AND kind = 'cash_out'
          AND state = 'awaiting_user'
          AND chain_tx_hash IS NULL`,
      [operation.id, operation.principal],
    );
    return result?.rowCount === 1 ? "canceled" : "pending";
  } finally {
    client.disconnect();
  }
}

export async function reconcileExpiredCashOutIntents(limit = 50): Promise<number> {
  const pool = getPool();
  if (!pool || fundsGate.config.mode === "free") return 0;
  const due = await pool.query<{ id: string; principal: string }>(
    `SELECT id, principal
       FROM money_operations
      WHERE kind = 'cash_out'
        AND state = 'awaiting_user'
        AND created_at + ($1 * INTERVAL '1 second') <= NOW()
      ORDER BY created_at
      LIMIT $2`,
    [CASH_OUT_AUTHORIZATION_SECONDS, Math.min(Math.max(limit, 1), 200)],
  );
  let resolved = 0;
  for (const row of due.rows) {
    try {
      const [operation, snapshot] = await Promise.all([
        getOperation(row.principal, row.id),
        loadCashOutSnapshot(row.id, row.principal),
      ]);
      if (!operation || !snapshot) continue;
      const outcome = await reconcileExpiredCashOutIntent(operation, snapshot);
      if (outcome !== "pending") resolved += 1;
    } catch (error) {
      logger.warn("Cash-out intent reconciliation deferred", {
        operationId: row.id,
        errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown",
      });
    }
  }
  return resolved;
}



router.use(requireSession);

router.get("/wallet", async (request, response) => {
  try {
    const secured = authenticated(request);
    const [profile, paymentMethods, operations, balance, restrictions] = await Promise.all([
      getPaymentProfile(secured.session.principal),
      listPaymentMethods(secured.session.principal),
      listOperations(secured.session.principal),
      authoritativeBalance(secured.session.principal),
      getPlayRestrictions(secured.session.principal),
    ]);
    response.json({
      funds: fundsGate.publicState(),
      profile: profile
        ? {
            status: profile.status,
            ...(profile.internalWalletAddress ? { internalWalletAddress: profile.internalWalletAddress } : {}),
          }
        : null,
      paymentMethods,
      operations,
      balance,
      restrictions,
    });
  } catch (error) {
    safeError(response, error);
  }
});

router.get("/operations/:id", async (request, response) => {
  try {
    const secured = authenticated(request);
    const operation = await getOperation(secured.session.principal, request.params.id);
    if (!operation) {
      response.status(404).json({ error: "operation_not_found" });
      return;
    }
    const storedResult = await getOperationResult(secured.session.principal, operation.id);
    let result: unknown = null;
    if (storedResult && typeof storedResult === "object" && "ciphertext" in storedResult) {
      result = decryptSensitiveJson(storedResult as EncryptedPayload, operation.id);
    }
    response.json({ operation, result });
  } catch (error) {
    safeError(response, error);
  }
});

router.use(requireCsrf);

router.post("/wallet/enroll", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const walletAddress = requiredString(body, "walletAddress", 80);
    if (walletAddress !== secured.session.principal || !XION_ADDRESS.test(walletAddress)) throw new TypeError("Wallet mismatch");
    const consent = consentSnapshot(body, "enroll", { walletAddress });
    const identity = identityPayload(body, request, String(consent.acceptedAt));
    await requireFinanceStepUp(request, "enroll");
    const transferType = fundsGate.config.asset?.braleTransferType;
    if (!transferType) throw new Error("FINANCE_NOT_CONFIGURED");
    const existingEnrollment = await getPaymentProfile(secured.session.principal);
    if (existingEnrollment) {
      if (existingEnrollment.walletAddress !== walletAddress) throw new Error("ENROLLMENT_OWNERSHIP_MISMATCH");
      response.status(existingEnrollment.status === "active" ? 200 : 202).json({
        profile: { status: existingEnrollment.status },
      });
      return;
    }
    const requestHash = sensitivePayloadHash({ identity, walletAddress, transferType, consent });
    const direct = await createOrLeaseDirectEffect({
      principal: secured.session.principal,
      kind: "enroll",
      clientIdempotencyKey: idempotencyKey(request),
      requestHash,
      assetDenom: fundsGate.config.asset?.denom ?? null,
      quoteSnapshot: { walletAddress, transferType },
      consentSnapshot: consent,
      effectType: "direct_account",
      providerIdempotencyKey: `gammon:enroll:${createHash("sha256").update(`gammon:provider-account:${secured.session.principal}`).digest("hex")}`,
    });
    if (direct.status !== "claimed" || !direct.effectId || !direct.leaseToken || !direct.providerIdempotencyKey) {
      response.status(direct.status === "in_progress" ? 202 : 200).json({ operation: direct.operation });
      return;
    }
    const provider = createConfiguredBraleClient();
    if (!provider) throw new Error("FINANCE_NOT_CONFIGURED");
    await authorizeDirectEffectDispatch({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      principal: secured.session.principal,
      step: "direct_account",
      action: "provider_account_create",
    });
    const profile = await getPaymentProfile(secured.session.principal);
    const account = await directProviderCall(direct, false, async () => (
      profile
        ? provider.getAccount(profile.providerAccountId)
        : provider.createIndividualTransactionalAccount(identity, direct.providerIdempotencyKey as string)
    ));
    const operation = await finalizeDirectEffect({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      operationState: "queued",
      providerReference: account.id,
      continuation: {
        effectType: "enroll",
        encryptedPayload: encryptSensitiveJson({ providerAccountId: account.id, walletAddress, transferType }, direct.operation.id),
        requestHash,
      },
    });
    response.status(direct.created ? 202 : 200).json({ operation });
  } catch (error) {
    safeError(response, error);
  }
});

router.post("/wallet/link-token", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const identity = {
      legalName: canonicalPersonName(body, "legalName"),
      emailAddress: canonicalEmail(body, "emailAddress"),
      dateOfBirth: canonicalDate(body, "dateOfBirth"),
    };
    const consent = consentSnapshot(body, "link_bank", { identitySubmitted: true });
    await requireFinanceStepUp(request, "link_token");
    const profile = await getPaymentProfile(secured.session.principal);
    if (!profile || profile.status !== "active") throw new Error("PAYMENT_PROFILE_NOT_ACTIVE");
    const direct = await createOrLeaseDirectEffect({
      principal: secured.session.principal,
      kind: "link_bank",
      clientIdempotencyKey: idempotencyKey(request),
      requestHash: sensitivePayloadHash({ identity, consent }),
      assetDenom: fundsGate.config.asset?.denom ?? null,
      quoteSnapshot: { providerAccountId: profile.providerAccountId },
      consentSnapshot: consent,
      effectType: "direct_link_token",
    });
    if (direct.status !== "claimed" || !direct.effectId || !direct.leaseToken || !direct.providerIdempotencyKey) {
      response.status(direct.status === "in_progress" ? 202 : 200).json({ operation: direct.operation });
      return;
    }
    const provider = createConfiguredBraleClient();
    if (!provider) throw new Error("FINANCE_NOT_CONFIGURED");
    await authorizeDirectEffectDispatch({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      principal: secured.session.principal,
      step: "direct_link_token",
      action: "link_bank",
    });
    const link = await directProviderCall(
      direct,
      true,
      async () => provider.createPlaidLinkToken(profile.providerAccountId, identity, direct.providerIdempotencyKey as string),
    );
    const operation = await finalizeDirectEffect({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      operationState: "awaiting_user",
    });
    response.status(direct.created ? 201 : 200).json({
      operation,
      linkToken: link.linkToken,
      expiresAt: link.expiration,
      callbackUrl: link.callbackUrl,
    });
  } catch (error) {
    safeError(response, error);
  }
});

router.post("/wallet/link-bank/complete", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const publicToken = requiredString(body, "publicToken", 2_000);
    const consent = consentSnapshot(body, "link_bank", { providerLinkCompleted: true });
    const key = idempotencyKey(request);
    await requireFinanceStepUp(request, "link_bank");
    const profile = await getPaymentProfile(secured.session.principal);
    const plaidWebhookUrl = process.env.BRALE_PLAID_WEBHOOK_URL;
    if (!profile || profile.status !== "active" || !plaidWebhookUrl) throw new Error("PAYMENT_PROFILE_NOT_ACTIVE");
    const paymentMethodId = `pm:${createHash("sha256").update(`${secured.session.principal}:${key}`).digest("hex")}`;
    const direct = await createOrLeaseDirectEffect({
      principal: secured.session.principal,
      kind: "link_bank",
      clientIdempotencyKey: key,
      requestHash: sensitivePayloadHash({ publicToken, consent }),
      assetDenom: fundsGate.config.asset?.denom ?? null,
      quoteSnapshot: { paymentMethodId, providerAccountId: profile.providerAccountId },
      consentSnapshot: consent,
      effectType: "direct_register_bank",
    });
    if (direct.status !== "claimed" || !direct.effectId || !direct.leaseToken || !direct.providerIdempotencyKey) {
      response.status(direct.status === "in_progress" ? 202 : 200).json({ operation: direct.operation });
      return;
    }
    const provider = createConfiguredBraleClient();
    if (!provider) throw new Error("FINANCE_NOT_CONFIGURED");
    await authorizeDirectEffectDispatch({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      principal: secured.session.principal,
      step: "direct_register_bank",
      action: "link_bank",
    });
    const registered = await directProviderCall(
      direct,
      true,
      async () => provider.registerPlaidAccount({
        accountId: profile.providerAccountId,
        publicToken,
        customerWebhookUrl: plaidWebhookUrl,
        accountHolderType: "individual",
        idempotencyKey: direct.providerIdempotencyKey as string,
      }),
    );
    const operation = await finalizeDirectEffect({
      effectId: direct.effectId,
      operationId: direct.operation.id,
      leaseToken: direct.leaseToken,
      operationState: "complete",
      providerReference: registered.addressId,
      paymentMethod: {
        id: paymentMethodId,
        principal: secured.session.principal,
        providerAddressId: registered.addressId,
        displayLabel: "Linked bank account",
      },
    });
    response.status(direct.created ? 201 : 200).json({ operation });
  } catch (error) {
    safeError(response, error);
  }
});

router.post("/deposits", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const amount = requiredUsdAmount(body, "amount");
    if (amount <= 0n) throw new RangeError("Deposit amount must be positive");
    const decision = await evaluateFundsAction(secured.session.principal, "deposit", amount);
    if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
    const paymentMethodId = requiredString(body, "paymentMethodId", 80);
    const [paymentMethod, profile] = await Promise.all([
      getPaymentMethod(secured.session.principal, paymentMethodId),
      getPaymentProfile(secured.session.principal),
    ]);
    const asset = fundsGate.config.asset;
    const achPolicy = fundsGate.config.approvedAchPolicy;
    if (!paymentMethod || profile?.status !== "active" || !profile.externalWalletAddressId || !asset || !achPolicy) {
      throw new TypeError("Payment method is not active for this wallet");
    }
    const consent = consentSnapshot(body, "deposit", {
      amountMicroUsd: amount.toString(),
      paymentMethodId,
    });
    await requireFinanceStepUp(request, "deposit", amount);
    const transferTuple = {
      paymentMethodId,
      providerAccountId: profile.providerAccountId,
      providerAddressId: paymentMethod.providerAddressId,
      externalWalletAddressId: profile.externalWalletAddressId,
      destinationWalletAddress: profile.walletAddress,
      assetDenom: asset.denom,
      chainRestUrl: asset.restUrl,
      chainId: asset.chainId,
      genesisHash: asset.genesisHash,
      fundsMode: fundsGate.config.mode,
      transferType: asset.braleTransferType,
      achAvailabilityDelaySeconds: achPolicy.availabilityDelaySeconds,
      achReturnReconciliationHorizonSeconds: achPolicy.returnReconciliationHorizonSeconds,
      finalityBlocks: asset.finalityBlocks,
    };
    const requestValue = { amountMicroUsd: amount.toString(), consent, ...transferTuple };
    const requestHash = payloadHash(requestValue);
    const key = idempotencyKey(request);
    const result = await createMoneyOperation({
      principal: secured.session.principal,
      kind: "deposit",
      initialState: "queued",
      amountMicroUsd: amount.toString(),
      assetDenom: asset.denom,
      clientIdempotencyKey: key,
      requestHash,
      consentSnapshot: consent,
      quoteSnapshot: {
        grossMicroUsd: amount.toString(),
        feeMicroUsd: "0",
        netMicroUsd: amount.toString(),
        ...transferTuple,
      },
      effect: {
        type: "create_deposit",
        encryptedPayload: (operationId) => encryptSensitiveJson(transferTuple, operationId),
        requestHash,
      },
    });
    response.status(result.created ? 202 : 200).json({ operation: result.operation });
  } catch (error) {
    safeError(response, error);
  }
});

router.post("/cash-outs", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const amount = requiredUsdAmount(body, "amount");
    if (amount <= 0n) throw new RangeError("Cash-out amount must be positive");
    const decision = await evaluateFundsAction(secured.session.principal, "cash_out", amount);
    if (!decision.allowed) throw new FundsActionDeniedError(decision.reasonCodes);
    const balance = await authoritativeBalance(secured.session.principal, "cash_out");
    if (balance.status !== "fresh" || typeof balance.availableMicroUsd !== "string") {
      throw new Error("BALANCE_UNAVAILABLE");
    }
    if (BigInt(balance.availableMicroUsd) < amount) {
      throw new RangeError("Cash-out amount exceeds available funds");
    }
    const paymentMethodId = requiredString(body, "paymentMethodId", 80);
    const paymentMethod = await getPaymentMethod(secured.session.principal, paymentMethodId);
    if (!paymentMethod) throw new TypeError("Payment method is not active for this wallet");
    const profile = await getPaymentProfile(secured.session.principal);
    const asset = fundsGate.config.asset;
    if (
      !profile ||
      profile.status !== "active" ||
      !profile.internalWalletAddress ||
      !profile.internalAddressId ||
      !profile.externalWalletAddressId ||
      !asset
    ) {
      throw new Error("CASH_OUT_ADDRESS_UNAVAILABLE");
    }
    const reviewedContext = {
      amountMicroUsd: amount.toString(),
      paymentMethodId,
      destination: profile.internalWalletAddress,
    };
    const consent = consentSnapshot(body, "cash_out", reviewedContext);
    await requireFinanceStepUp(request, "cash_out", amount);
    const financeAuthorizationContract = process.env.FINANCE_AUTHORIZATION_CONTRACT?.trim() ?? "";
    if (
      !XION_ADDRESS.test(financeAuthorizationContract)
      || process.env.FINANCE_AUTHORIZATION_MESSAGE_KEY !== "authorize_finance_action"
    ) throw new Error("CASH_OUT_AUTHORIZATION_UNAVAILABLE");

    let activeIntent = await findActiveCashOutIntent(secured.session.principal, paymentMethodId);
    if (
      activeIntent &&
      cashOutAuthorizationExpiresAt(activeIntent.operation) <= Math.floor(Date.now() / 1_000)
    ) {
      const outcome = await reconcileExpiredCashOutIntent(activeIntent.operation, activeIntent.snapshot);
      if (outcome === "funded") {
        response.status(202).json({
          operation: await getOperation(secured.session.principal, activeIntent.operation.id),
          recovered: true,
        });
        return;
      }
      if (outcome === "canceled") {
        activeIntent = null;
      } else {
        response.status(409).json({
          error: "cash_out_intent_active",
          operation: activeIntent.operation,
          expiresAt: cashOutAuthorizationExpiresAt(activeIntent.operation),
        });
        return;
      }
    }
    if (activeIntent) {
      const signer = activeIntent.snapshot.authorized_signer ?? secured.session.signer;
      if (
        activeIntent.operation.amountMicroUsd !== amount.toString() ||
        signer !== secured.session.signer ||
        activeIntent.snapshot.internal_wallet_address !== profile.internalWalletAddress ||
        activeIntent.snapshot.asset_denom !== asset.denom ||
        activeIntent.snapshot.finance_authorization_contract !== financeAuthorizationContract
      ) {
        response.status(409).json({
          error: "cash_out_intent_active",
          operation: activeIntent.operation,
          expiresAt: cashOutAuthorizationExpiresAt(activeIntent.operation),
        });
        return;
      }
      response.status(200).json({
        operation: activeIntent.operation,
        fundingInstruction: cashOutFundingInstruction(activeIntent.operation, activeIntent.snapshot),
        resumed: true,
      });
      return;
    }

    const cashOutIntentKey = payloadHash({
      principal: secured.session.principal,
      paymentMethodId,
    });
    const transferTuple = {
      paymentMethodId,
      cashOutIntentKey,
      providerAccountId: profile.providerAccountId,
      providerAddressId: paymentMethod.providerAddressId,
      internalAddressId: profile.internalAddressId,
      externalWalletAddressId: profile.externalWalletAddressId,
      internalWalletAddress: profile.internalWalletAddress,
      originatingWalletAddress: secured.session.principal,
      assetDenom: asset.denom,
      chainRpcUrl: asset.rpcUrl,
      chainRestUrl: asset.restUrl,
      chainId: asset.chainId,
      authorizedSigner: secured.session.signer,
      genesisHash: asset.genesisHash,
      finalityBlocks: asset.finalityBlocks,
      fundsMode: fundsGate.config.mode,
      transferType: asset.braleTransferType,
      financeAuthorizationContract,
    };
    const requestValue = { ...reviewedContext, consent, ...transferTuple };
    const result = await createMoneyOperation({
      principal: secured.session.principal,
      kind: "cash_out",
      initialState: "awaiting_user",
      amountMicroUsd: amount.toString(),
      assetDenom: asset.denom,
      clientIdempotencyKey: idempotencyKey(request),
      requestHash: payloadHash(requestValue),
      unresolvedSingletonKey: cashOutIntentKey,
      consentSnapshot: consent,
      quoteSnapshot: {
        grossMicroUsd: amount.toString(),
        feeMicroUsd: "0",
        netMicroUsd: amount.toString(),
        ...transferTuple,
      },
    });
    const snapshot = await loadCashOutSnapshot(result.operation.id, secured.session.principal);
    assertCashOutSnapshot(snapshot, result.operation, false);
    if (
      result.operation.amountMicroUsd !== amount.toString() ||
      (snapshot.authorized_signer ?? secured.session.signer) !== secured.session.signer ||
      snapshot.internal_wallet_address !== profile.internalWalletAddress
    ) {
      response.status(409).json({
        error: "cash_out_intent_active",
        operation: result.operation,
        expiresAt: cashOutAuthorizationExpiresAt(result.operation),
      });
      return;
    }
    response.status(result.created ? 201 : 200).json({
      operation: result.operation,
      fundingInstruction: cashOutFundingInstruction(result.operation, snapshot),
      resumed: result.reusedSingleton || !result.created,
    });
  } catch (error) {
    safeError(response, error);
  }
});

router.post("/cash-outs/:id/confirm-transfer", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const submittedTxHash = body.txHash === undefined
      ? null
      : requiredString(body, "txHash", 64).toUpperCase();
    if (submittedTxHash !== null && !TX_HASH.test(submittedTxHash)) {
      throw new TypeError("Invalid transaction hash");
    }
    const operation = await getOperation(secured.session.principal, request.params.id);
    if (!operation || operation.kind !== "cash_out" || !operation.amountMicroUsd) {
      response.status(404).json({ error: "cash_out_not_found" });
      return;
    }
    await requireFinanceStepUp(
      request,
      "cash_out_confirm",
      BigInt(operation.amountMicroUsd),
      { requireFinanceGrant: false },
    );
    const snapshot = await loadCashOutSnapshot(operation.id, secured.session.principal);
    assertCashOutSnapshot(
      snapshot,
      operation,
      !submittedTxHash && !operation.chainTxHash,
    );
    const updated = await finalizeCashOutIntent({
      operation,
      snapshot,
      submittedTxHash,
      signerFallback: secured.session.signer,
    });
    response.status(operation.state === "awaiting_user" ? 202 : 200).json({ operation: updated });
  } catch (error) {
    safeError(response, error);
  }
});

router.get("/responsible-play", async (request, response) => {
  try {
    response.json(await getPlayRestrictions(authenticated(request).session.principal));
  } catch (error) {
    safeError(response, error);
  }
});

router.post("/responsible-play/restrict", async (request, response) => {
  try {
    const secured = authenticated(request);
    const body = bodyRecord(request);
    const type = requiredString(body, "type", 30);
    const durationDays = Number(body.durationDays);
    const now = Date.now();
    let limitChange: { appliedImmediately: boolean; effectiveAt: string | null } | null = null;
    if (type === "self_exclusion") {
      if (![30, 180, 365, 1825].includes(durationDays)) throw new TypeError("Invalid exclusion duration");
      await applyImmediateRestriction({
        principal: secured.session.principal,
        selfExcludedUntil: new Date(now + durationDays * 86_400_000),
      });
    } else if (type === "cooling_off") {
      if (![1, 7, 30].includes(durationDays)) throw new TypeError("Invalid cooling-off duration");
      await applyImmediateRestriction({
        principal: secured.session.principal,
        coolingOffUntil: new Date(now + durationDays * 86_400_000),
      });
    } else if (
      type === "deposit_limit"
      || type === "wager_limit"
      || type === "daily_wager_limit"
      || type === "daily_loss_limit"
    ) {
      const amount = requiredUsdAmount(body, "amount");
      limitChange = await requestRestrictionLimitChange({
        principal: secured.session.principal,
        type: type as RestrictionLimitType,
        amountMicroUsd: amount.toString(),
      });
    } else {
      throw new TypeError("Invalid restriction type");
    }
    response.json({
      ...await getPlayRestrictions(secured.session.principal),
      limitChange,
    });
  } catch (error) {
    safeError(response, error);
  }
});

export const financeRouter = router;

export function mountBraleWebhook(app: Express, rateLimit: RequestHandler): void {
  app.post("/api/webhooks/brale", rateLimit, express.raw({ type: "application/json", limit: "256kb" }), async (request, response) => {
    const raw = request.body;
    const signature = request.get("x-request-signature-sha-256") ?? "";
    const secret = process.env.BRALE_WEBHOOK_SECRET ?? "";
    if (!Buffer.isBuffer(raw) || !/^[0-9a-f]{64}$/.test(signature) || !secret) {
      response.status(401).json({ error: "invalid_signature" });
      return;
    }
    const expected = createHmac("sha256", Buffer.from(secret, "base64url")).update(raw).digest();
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      response.status(401).json({ error: "invalid_signature" });
      return;
    }
    try {
      const event = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const eventId = requiredString(event, "id", 100);
      const eventType = requiredString(event, "type", 100);
      const signedSubscriptionId = requiredString(event, "subscription_id", 100);
      const signedEnvironment = requiredString(event, "environment", 40);
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("Invalid webhook data");
      const eventData = data as Record<string, unknown>;
      const providerResourceId = typeof eventData.id === "string" ? eventData.id : null;
      const subscriptionId = process.env.BRALE_WEBHOOK_SUBSCRIPTION_ID;
      const environment = process.env.BRALE_WEBHOOK_ENVIRONMENT;
      const accountId = process.env.BRALE_ACCOUNT_ID;
      if (!subscriptionId || !environment || !accountId) throw new Error("WEBHOOK_NOT_CONFIGURED");
      if (
        signedSubscriptionId !== subscriptionId ||
        signedEnvironment !== environment ||
        (eventType.startsWith("transfer.") && eventData.account_id !== accountId)
      ) {
        throw new TypeError("Webhook scope mismatch");
      }
      const configuredProgram = process.env.BRALE_PROGRAM_ID;
      if (configuredProgram && eventData.program_id !== configuredProgram) throw new TypeError("Webhook program mismatch");
      const accepted = await acceptWebhookEvent({
        subscriptionId,
        environment,
        eventId,
        eventType,
        payload: {
          created: typeof event.created === "string" ? event.created : null,
          resourceId: providerResourceId,
          accountId,
          programId: configuredProgram ?? null,
          status: typeof eventData.status === "string" ? eventData.status : null,
          failureType: eventData.failure && typeof eventData.failure === "object"
            ? ((eventData.failure as Record<string, unknown>).type ?? null)
            : null,
        },
        providerResourceId,
        masterAccountId: accountId,
      });
      if (!accepted.bound) {
        response.status(409).json({ accepted: false, retry: true });
        return;
      }
      response.status(202).json({ accepted: true });
    } catch {
      response.status(400).json({ error: "invalid_webhook", reference: randomUUID() });
    }
  });
}
