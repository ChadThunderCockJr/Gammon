import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { encodeSecp256k1Pubkey, pubkeyToAddress, serializeSignDoc } from "@cosmjs/amino";
import { Secp256k1, Secp256k1Signature, Sha256 } from "@cosmjs/crypto";
import { QueryClient, setupAuthzExtension } from "@cosmjs/stargate";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import {
  AcceptedMessageKeysFilter,
  AllowAllMessagesFilter,
  CombinedLimit,
  ContractExecutionAuthorization,
  MaxCallsLimit,
  MaxFundsLimit,
} from "cosmjs-types/cosmwasm/wasm/v1/authz.js";
import { getPool } from "./db.js";
import { logger } from "./logger.js";
import { payloadHash } from "./finance-crypto.js";

const SESSION_COOKIE = "gammon_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const FINANCE_STEP_UP_TTL_MS = 2 * 60 * 1_000;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const XION_ADDRESS = /^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/;
const localConsumedChallenges = new Set<string>();
const localSessions = new Map<string, SessionRecord>();
let nextAuthenticationPruneAt = 0;
let authenticationPrune: Promise<void> | null = null;

export interface SessionRecord {
  readonly idHash: string;
  readonly principal: string;
  readonly signer: string;
  readonly chainId: string;
  readonly csrfToken: string;
  readonly grantExpiresAt: number | null;
  readonly expiresAt: number;
}

interface ChallengePayload {
  readonly type: "gammon.session.v1";
  readonly challengeId: string;
  readonly nonce: string;
  readonly domain: string;
  readonly origin: string;
  readonly uri: string;
  readonly chainId: string;
  readonly principal: string;
  readonly signer: string;
  readonly purpose: "authenticate";
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export type FinanceStepUpPurpose =
  | "enroll"
  | "link_token"
  | "link_bank"
  | "deposit"
  | "cash_out"
  | "cash_out_confirm";

interface FinanceStepUpPayload {
  readonly type: "gammon.finance-step-up.v1";
  readonly challengeId: string;
  readonly sessionIdHash: string;
  readonly origin: string;
  readonly chainId: string;
  readonly principal: string;
  readonly signer: string;
  readonly purpose: FinanceStepUpPurpose;
  readonly bindingHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface AuthenticatedRequest extends Request {
  session?: SessionRecord;
}

function sessionSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET must contain at least 32 characters");
  return "local-development-session-secret-not-for-production";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function allowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (!configured) {
    return process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000"];
  }
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function requestOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return process.env.NODE_ENV !== "production";
  const parsed = parsedOrigin(origin);
  return parsed !== null && allowedOrigins().includes(parsed.origin);
}

function parsedOrigin(origin: string): URL | null {
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function configuredAuthChain(): string | null {
  const configured = process.env.AUTH_CHAIN_ID ?? process.env.VERUSD_CHAIN_ID;
  if (configured === undefined) {
    return process.env.NODE_ENV === "production" ? null : "xion-testnet-2";
  }
  return /^[A-Za-z0-9._-]{1,128}$/.test(configured) ? configured : null;

}
function browserFinanceSandboxEnabled(): boolean {
  return process.env.GAMMON_BROWSER_FINANCE_SANDBOX === "1" && process.env.NODE_ENV !== "production";
}

function canonicalPayload(payload: ChallengePayload): string {
  return JSON.stringify({
    challengeId: payload.challengeId,
    chainId: payload.chainId,
    domain: payload.domain,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
    nonce: payload.nonce,
    origin: payload.origin,
    principal: payload.principal,
    purpose: payload.purpose,
    signer: payload.signer,
    type: payload.type,
    uri: payload.uri,
  });
}

function challengeToken(payload: ChallengePayload): string {
  const encoded = Buffer.from(canonicalPayload(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeChallenge(token: string): ChallengePayload | null {
  const [encoded, receivedSignature, extra] = token.split(".");
  if (!encoded || !receivedSignature || extra) return null;
  const expectedSignature = createHmac("sha256", sessionSecret()).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(receivedSignature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expectedSignature.length || !timingSafeEqual(received, expectedSignature)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ChallengePayload;
  } catch {
    return null;
  }
}
function canonicalFinanceStepUp(payload: FinanceStepUpPayload): string {
  return JSON.stringify({
    bindingHash: payload.bindingHash,
    challengeId: payload.challengeId,
    chainId: payload.chainId,
    expiresAt: payload.expiresAt,
    issuedAt: payload.issuedAt,
    origin: payload.origin,
    principal: payload.principal,
    purpose: payload.purpose,
    sessionIdHash: payload.sessionIdHash,
    signer: payload.signer,
    type: payload.type,
  });
}

function financeStepUpToken(payload: FinanceStepUpPayload): string {
  const encoded = Buffer.from(canonicalFinanceStepUp(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function decodeFinanceStepUp(token: string): FinanceStepUpPayload | null {
  const [encoded, receivedSignature, extra] = token.split(".");
  if (!encoded || !receivedSignature || extra) return null;
  const expectedSignature = createHmac("sha256", sessionSecret()).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(receivedSignature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expectedSignature.length || !timingSafeEqual(received, expectedSignature)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as FinanceStepUpPayload;
  } catch {
    return null;
  }
}


function adr36SignDoc(signer: string, message: string) {
  return {
    chain_id: "",
    account_number: "0",
    sequence: "0",
    fee: { gas: "0", amount: [] },
    msgs: [{
      type: "sign/MsgSignData",
      value: { signer, data: Buffer.from(message).toString("base64") },
    }],
    memo: "",
  };
}

async function verifyAdr36(message: string, signer: string, signatureBase64: string, publicKeyBase64: string): Promise<boolean> {
  try {
    const publicKey = Buffer.from(publicKeyBase64, "base64");
    const signatureBytes = Buffer.from(signatureBase64, "base64");
    if (publicKey.length !== 33 || (signatureBytes.length !== 64 && signatureBytes.length !== 65)) return false;
    if (pubkeyToAddress(encodeSecp256k1Pubkey(publicKey), "xion") !== signer) return false;
    const signBytes = serializeSignDoc(adr36SignDoc(signer, message));
    const messageHash = new Sha256(signBytes).digest();
    const rawSignature = signatureBytes.length === 65 ? signatureBytes.subarray(0, 64) : signatureBytes;
    const signature = new Secp256k1Signature(rawSignature.subarray(0, 32), rawSignature.subarray(32, 64));
    return await Secp256k1.verifySignature(signature, messageHash, publicKey);
  } catch {
    return false;
  }
}

interface GrantBinding {
  readonly grantExpiresAt: number | null;
}

function configuredDelegation(): { contract: string; messageKey: string } | null {
  const contract = process.env.AUTH_DELEGATION_CONTRACT;
  const messageKey = process.env.AUTH_DELEGATION_MESSAGE_KEY;
  return contract && messageKey ? { contract, messageKey } : null;
}

function validAuthorizationRpcUrl(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (
      (process.env.NODE_ENV === "production" ? parsed.protocol !== "https:" : !["http:", "https:"].includes(parsed.protocol))
      || parsed.username
      || parsed.password
      || parsed.hash
    ) return null;
    return value;
  } catch {
    return null;
  }
}

export function trustedAuthorizationRpcUrl(): string | null {
  const mode = process.env.FUNDS_MODE?.trim() || "free";
  if (mode !== "free") {
    const assetRpc = validAuthorizationRpcUrl(process.env.VERUSD_RPC_URL);
    if (!assetRpc) return null;
    if (process.env.AUTH_RPC_URL !== undefined && process.env.AUTH_RPC_URL !== assetRpc) return null;
    if (
      mode === "verusd_production"
      && process.env.VERUSD_APPROVED_RPC_URL !== assetRpc
    ) return null;
    return assetRpc;
  }

  const configured = validAuthorizationRpcUrl(
    process.env.AUTH_RPC_URL ?? process.env.XION_RPC_URL ?? process.env.VERUSD_RPC_URL,
  );
  if (!configured) return null;
  if (
    process.env.NODE_ENV === "production"
    && process.env.AUTH_APPROVED_RPC_URL !== configured
  ) return null;
  return configured;
}

function grantExpiryMilliseconds(seconds: bigint | undefined): number | null {
  if (seconds === undefined || seconds < 0n) return null;
  const milliseconds = seconds * 1_000n;
  if (milliseconds > 8_640_000_000_000_000n) return null;
  return Number(milliseconds);
}

function isUsableDelegationLimit(limit: { typeUrl: string; value: Uint8Array } | undefined): boolean {
  if (!limit) return false;
  try {
    if (limit.typeUrl === MaxCallsLimit.typeUrl) return MaxCallsLimit.decode(limit.value).remaining > 0n;
    if (limit.typeUrl === CombinedLimit.typeUrl) return CombinedLimit.decode(limit.value).callsRemaining > 0n;
    return false;
  } catch {
    return false;
  }
}

function matchingDelegationGrant(
  authorization: { typeUrl: string; value: Uint8Array },
  contract: string,
  messageKey: string,
): boolean {
  if (authorization.typeUrl !== ContractExecutionAuthorization.typeUrl) return false;
  try {
    return ContractExecutionAuthorization.decode(authorization.value).grants.some((grant) => {
      if (grant.contract !== contract || !isUsableDelegationLimit(grant.limit)) return false;
      if (!grant.filter || grant.filter.typeUrl !== AcceptedMessageKeysFilter.typeUrl) return false;
      const keys = AcceptedMessageKeysFilter.decode(grant.filter.value).keys;
      return keys.length === 1 && keys[0] === messageKey;
    });
  } catch {
    return false;
  }
}

async function liveGrantBindsPrincipal(principal: string, signer: string, chainId: string): Promise<GrantBinding | null> {
  if (principal === signer) return { grantExpiresAt: null };
  const delegation = configuredDelegation();
  if (!delegation) return null;
  const rpcUrl = trustedAuthorizationRpcUrl();
  if (!rpcUrl) return null;

  const comet = await Comet38Client.connect(rpcUrl);
  try {
    const status = await comet.status();
    if (status.nodeInfo.network !== chainId) return null;
    const query = QueryClient.withExtensions(comet, setupAuthzExtension);
    const response = await query.authz.granteeGrants(signer);
    const now = Date.now();
    let latestGrantExpiry: number | null = null;
    for (const entry of response.grants) {
      if (entry.granter !== principal || entry.grantee !== signer || !entry.authorization) continue;
      const grantExpiresAt = grantExpiryMilliseconds(entry.expiration?.seconds);
      if (
        grantExpiresAt === null ||
        grantExpiresAt <= now ||
        !matchingDelegationGrant(entry.authorization, delegation.contract, delegation.messageKey)
      ) continue;
      if (latestGrantExpiry === null || grantExpiresAt > latestGrantExpiry) latestGrantExpiry = grantExpiresAt;
    }
    return latestGrantExpiry === null ? null : { grantExpiresAt: latestGrantExpiry };
  } catch (error) {
    logger.warn("Authz grant verification failed", { errorCode: error instanceof Error ? error.name : "unknown" });
    return null;
  } finally {
    comet.disconnect();
  }
}
export async function paidEscrowGrantIsSufficient(
  session: SessionRecord,
  requiredMicroUsd: bigint,
): Promise<boolean> {
  if (session.principal === session.signer) return true;
  const rpcUrl = trustedAuthorizationRpcUrl();
  const contract = process.env.VERUSD_ESCROW_CONTRACT;
  const denom = process.env.VERUSD_DENOM;
  if (!rpcUrl || !contract || !denom || requiredMicroUsd <= 0n) return false;
  const comet = await Comet38Client.connect(rpcUrl);
  try {
    const status = await comet.status();
    if (status.nodeInfo.network !== session.chainId) return false;
    const query = QueryClient.withExtensions(comet, setupAuthzExtension);
    const response = await query.authz.granteeGrants(session.signer);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    return response.grants.some((entry) => {
      if (
        entry.granter !== session.principal ||
        entry.grantee !== session.signer ||
        !entry.authorization ||
        entry.expiration?.seconds === undefined ||
        entry.expiration.seconds <= nowSeconds ||
        entry.authorization.typeUrl !== ContractExecutionAuthorization.typeUrl
      ) return false;
      const grants = ContractExecutionAuthorization.decode(entry.authorization.value).grants;
      return grants.some((grant) => {
        if (grant.contract !== contract || !grant.limit || !grant.filter) return false;
        let available = 0n;
        if (grant.limit.typeUrl === MaxFundsLimit.typeUrl) {
          const limit = MaxFundsLimit.decode(grant.limit.value);
          available = BigInt(limit.amounts.find((coin) => coin.denom === denom)?.amount ?? "0");
        } else if (grant.limit.typeUrl === CombinedLimit.typeUrl) {
          const limit = CombinedLimit.decode(grant.limit.value);
          if (limit.callsRemaining < 1n) return false;
          available = BigInt(limit.amounts.find((coin) => coin.denom === denom)?.amount ?? "0");
        } else {
          return false;
        }
        if (available < requiredMicroUsd || grant.filter.typeUrl !== AcceptedMessageKeysFilter.typeUrl) return false;
        const keys = AcceptedMessageKeysFilter.decode(grant.filter.value).keys;
        return keys.length === 1 && keys[0] === "deposit_reserve";
      });
    });
  } catch (error) {
    logger.warn("Paid authz grant verification failed", { errorCode: error instanceof Error ? error.name : "unknown" });
    return false;
  } finally {
    comet.disconnect();
  }
}
async function financeStepUpGrantIsSufficient(
  session: SessionRecord,
  requiredMicroUsd: bigint,
): Promise<boolean> {
  if (session.principal === session.signer) return true;
  const rpcUrl = trustedAuthorizationRpcUrl();
  const contract = process.env.FINANCE_AUTHORIZATION_CONTRACT;
  const messageKey = process.env.FINANCE_AUTHORIZATION_MESSAGE_KEY;
  const denom = process.env.VERUSD_DENOM;
  if (!rpcUrl || !contract || !messageKey || !denom || requiredMicroUsd < 0n) return false;
  const comet = await Comet38Client.connect(rpcUrl);
  try {
    const status = await comet.status();
    if (status.nodeInfo.network !== session.chainId) return false;
    const query = QueryClient.withExtensions(comet, setupAuthzExtension);
    const response = await query.authz.granteeGrants(session.signer);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    const minimum = requiredMicroUsd > 0n ? requiredMicroUsd : 1n;
    return response.grants.some((entry) => {
      if (
        entry.granter !== session.principal ||
        entry.grantee !== session.signer ||
        !entry.authorization ||
        entry.expiration?.seconds === undefined ||
        entry.expiration.seconds <= nowSeconds ||
        entry.authorization.typeUrl !== ContractExecutionAuthorization.typeUrl
      ) return false;
      return ContractExecutionAuthorization.decode(entry.authorization.value).grants.some((grant) => {
        if (grant.contract !== contract || !grant.limit || !grant.filter) return false;
        let filterAllowed = grant.filter.typeUrl === AllowAllMessagesFilter.typeUrl;
        if (grant.filter.typeUrl === AcceptedMessageKeysFilter.typeUrl) {
          const keys = AcceptedMessageKeysFilter.decode(grant.filter.value).keys;
          filterAllowed = keys.length === 1 && keys[0] === messageKey;
        }
        // The finance router's attested checksum exposes exactly one execute variant.
        if (!filterAllowed) return false;
        let available = 0n;
        if (grant.limit.typeUrl === MaxFundsLimit.typeUrl) {
          const limit = MaxFundsLimit.decode(grant.limit.value);
          available = BigInt(limit.amounts.find((coin) => coin.denom === denom)?.amount ?? "0");
        } else if (grant.limit.typeUrl === CombinedLimit.typeUrl) {
          const limit = CombinedLimit.decode(grant.limit.value);
          if (limit.callsRemaining < 1n) return false;
          available = BigInt(limit.amounts.find((coin) => coin.denom === denom)?.amount ?? "0");
        }
        return available >= minimum;
      });
    });
  } catch (error) {
    logger.warn("Finance step-up grant verification failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return false;
  } finally {
    comet.disconnect();
  }
}

export async function pruneAuthenticationRows(limit = 1_000): Promise<void> {
  const boundedLimit = Math.max(1, Math.min(limit, 10_000));
  const pool = getPool();
  if (!pool) {
    const now = Date.now();
    for (const [hash, session] of localSessions) {
      if (session.expiresAt <= now) localSessions.delete(hash);
    }
    return;
  }
  await pool.query(
    `DELETE FROM consumed_auth_challenges
      WHERE ctid IN (
        SELECT ctid FROM consumed_auth_challenges
         WHERE expires_at < NOW() - INTERVAL '24 hours'
         ORDER BY expires_at
         LIMIT $1
      )`,
    [boundedLimit],
  );
  await pool.query(
    `DELETE FROM auth_sessions
      WHERE ctid IN (
        SELECT ctid FROM auth_sessions
         WHERE expires_at < NOW() - INTERVAL '24 hours'
            OR revoked_at < NOW() - INTERVAL '24 hours'
         ORDER BY COALESCE(revoked_at, expires_at)
         LIMIT $1
      )`,
    [boundedLimit],
  );
}

async function maybePruneAuthenticationRows(): Promise<void> {
  if (Date.now() < nextAuthenticationPruneAt) return;
  if (!authenticationPrune) {
    nextAuthenticationPruneAt = Date.now() + 60_000;
    authenticationPrune = pruneAuthenticationRows()
      .catch((error) => {
        logger.warn("Authentication retention cleanup failed", {
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        authenticationPrune = null;
      });
  }
  await authenticationPrune;
}


async function consumeChallenge(challengeHash: string, expiresAt: Date): Promise<boolean> {
  const pool = getPool();
  if (!pool) {
    if (process.env.NODE_ENV === "production" || localConsumedChallenges.has(challengeHash)) return false;
    localConsumedChallenges.add(challengeHash);
    return true;
  }
  const result = await pool.query(
    `INSERT INTO consumed_auth_challenges (challenge_hash, expires_at)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [challengeHash, expiresAt],
  );
  await maybePruneAuthenticationRows();
  return result.rowCount === 1;
}

async function persistSession(token: string, session: SessionRecord): Promise<void> {
  const tokenHash = digest(token);
  if (session.idHash !== tokenHash) throw new Error("Session token hash does not match the session record");
  const csrfHash = digest(session.csrfToken);
  const pool = getPool();
  if (!pool) {
    if (process.env.NODE_ENV === "production") throw new Error("Durable session storage is unavailable");
    localSessions.set(tokenHash, session);
    return;
  }
  await pool.query(
    `INSERT INTO auth_sessions
      (id_hash, principal, signer, chain_id, csrf_hash, grant_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tokenHash,
      session.principal,
      session.signer,
      session.chainId,
      csrfHash,
      session.grantExpiresAt === null ? null : new Date(session.grantExpiresAt),
      new Date(session.expiresAt),
    ],
  );
  await maybePruneAuthenticationRows();
}

async function loadSessionByIdHash(idHash: string): Promise<SessionRecord | null> {
  const pool = getPool();
  if (!pool) {
    const session = localSessions.get(idHash);
    if (!session || session.expiresAt <= Date.now() || (session.grantExpiresAt !== null && session.grantExpiresAt <= Date.now())) return null;
    return session;
  }
  const result = await pool.query<{
    principal: string;
    signer: string;
    chain_id: string;
    csrf_hash: string;
    grant_expires_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT principal, signer, chain_id, csrf_hash, grant_expires_at, expires_at
       FROM auth_sessions
      WHERE id_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND (grant_expires_at IS NULL OR grant_expires_at > NOW())`,
    [idHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    idHash,
    principal: row.principal,
    signer: row.signer,
    chainId: row.chain_id,
    csrfToken: row.csrf_hash,
    grantExpiresAt: row.grant_expires_at?.getTime() ?? null,
    expiresAt: row.expires_at.getTime(),
  };
}

async function validateSessionAuthority(session: SessionRecord): Promise<SessionRecord | null> {
  const now = Date.now();
  if (session.expiresAt <= now || (session.grantExpiresAt !== null && session.grantExpiresAt <= now)) return null;
  const grant = await liveGrantBindsPrincipal(session.principal, session.signer, session.chainId);
  if (!grant) return null;
  if (session.principal !== session.signer && session.grantExpiresAt === null) return null;
  return session;
}

export async function revalidateSession(session: SessionRecord): Promise<SessionRecord | null> {
  const current = await loadSessionByIdHash(session.idHash);
  return current ? validateSessionAuthority(current) : null;
}

async function revokeSessionByIdHash(idHash: string): Promise<void> {
  const pool = getPool();
  if (!pool) {
    localSessions.delete(idHash);
    return;
  }
  await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id_hash = $1`,
    [idHash],
  );
}

export async function revokeSession(session: SessionRecord): Promise<void> {
  await revokeSessionByIdHash(session.idHash);
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.cookie;
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function setSessionCookie(response: Response, token: string, expiresAt: number): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
    maxAge: Math.max(0, expiresAt - Date.now()),
  });
}

function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
  });
}

export async function sessionFromRequest(request: Request): Promise<SessionRecord | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await loadSessionByIdHash(digest(token));
  return session ? validateSessionAuthority(session) : null;
}

export async function logoutSession(request: Request, response: Response): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await revokeSessionByIdHash(digest(token));
  clearSessionCookie(response);
}

export async function rotateSession(request: Request, response: Response): Promise<SessionRecord | null> {
  const current = await sessionFromRequest(request);
  if (!current) {
    clearSessionCookie(response);
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  const session: SessionRecord = {
    ...current,
    idHash: digest(token),
    csrfToken: randomBytes(24).toString("base64url"),
  };
  await persistSession(token, session);
  await revokeSession(current);
  setSessionCookie(response, token, session.expiresAt);
  return session;
}

const FINANCE_STEP_UP_PURPOSES = new Set<FinanceStepUpPurpose>([
  "enroll",
  "link_token",
  "link_bank",
  "deposit",
  "cash_out",
  "cash_out_confirm",
]);

function actionBinding(request: Request): Record<string, unknown> | null {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return null;
  const { stepUp: _stepUp, ...body } = request.body as Record<string, unknown>;
  const path = request.originalUrl.split("?")[0];
  const idempotencyKey = request.get("idempotency-key") ?? "";
  if (!path.startsWith("/api/funds/") || !idempotencyKey) return null;
  return { body, idempotencyKey, path };
}

function validSubmittedActionBinding(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (
    Object.keys(binding).sort().join(",") !== "body,idempotencyKey,path" ||
    typeof binding.path !== "string" ||
    !binding.path.startsWith("/api/funds/") ||
    typeof binding.idempotencyKey !== "string" ||
    binding.idempotencyKey.length < 1 ||
    binding.idempotencyKey.length > 200 ||
    !binding.body ||
    typeof binding.body !== "object" ||
    Array.isArray(binding.body) ||
    "stepUp" in (binding.body as Record<string, unknown>)
  ) return false;
  return JSON.stringify(binding).length <= 32_000;
}

export function createFinanceStepUpChallenge(request: Request, response: Response): void {
  const session = (request as AuthenticatedRequest).session;
  const purpose = typeof request.body?.purpose === "string"
    ? request.body.purpose as FinanceStepUpPurpose
    : null;
  const binding = request.body?.binding;
  const origin = request.get("origin") ?? "";
  if (
    !session ||
    !purpose ||
    !validSubmittedActionBinding(binding) ||
    !requestOriginAllowed(origin)
  ) {
    response.status(400).json({ error: "invalid_finance_step_up_request" });
    return;
  }
  const issuedAt = new Date();
  const payload: FinanceStepUpPayload = {
    type: "gammon.finance-step-up.v1",
    challengeId: randomBytes(16).toString("hex"),
    sessionIdHash: session.idHash,
    origin,
    chainId: session.chainId,
    principal: session.principal,
    signer: session.signer,
    purpose,
    bindingHash: payloadHash(binding),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + FINANCE_STEP_UP_TTL_MS).toISOString(),
  };
  response.json({
    challengeToken: financeStepUpToken(payload),
    message: canonicalFinanceStepUp(payload),
    expiresAt: payload.expiresAt,
  });
}

export async function requireFinanceStepUp(
  request: Request,
  purpose: FinanceStepUpPurpose,
  requiredMicroUsd = 0n,
  options: { readonly requireFinanceGrant?: boolean } = {},
): Promise<void> {
  const session = (request as AuthenticatedRequest).session;
  const binding = actionBinding(request);
  const proof = request.body?.stepUp;
  const token = typeof proof?.challengeToken === "string" ? proof.challengeToken : "";
  const signature = typeof proof?.signature === "string" ? proof.signature : "";
  const publicKey = typeof proof?.publicKey === "string" ? proof.publicKey : "";
  const payload = decodeFinanceStepUp(token);
  const origin = request.get("origin") ?? "";
  const issuedAt = payload ? Date.parse(payload.issuedAt) : Number.NaN;
  const expiresAt = payload ? Date.parse(payload.expiresAt) : Number.NaN;
  if (
    !session ||
    !binding ||
    !payload ||
    payload.type !== "gammon.finance-step-up.v1" ||
    payload.purpose !== purpose ||
    payload.sessionIdHash !== session.idHash ||
    payload.principal !== session.principal ||
    payload.signer !== session.signer ||
    payload.chainId !== session.chainId ||
    payload.origin !== origin ||
    payload.bindingHash !== payloadHash(binding) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > Date.now() + 30_000 ||
    expiresAt <= Date.now() ||
    expiresAt - issuedAt !== FINANCE_STEP_UP_TTL_MS ||
    !requestOriginAllowed(origin)
  ) throw new Error("FINANCE_STEP_UP_REQUIRED");
  if (!(await verifyAdr36(canonicalFinanceStepUp(payload), session.signer, signature, publicKey))) {
    throw new Error("FINANCE_STEP_UP_REQUIRED");
  }
  if (
    !browserFinanceSandboxEnabled()
    && options.requireFinanceGrant !== false
    && !(await financeStepUpGrantIsSufficient(session, requiredMicroUsd))
  ) {
    throw new Error("FINANCE_STEP_UP_GRANT_REQUIRED");
  }
  if (!(await consumeChallenge(digest(token), new Date(payload.expiresAt)))) {
    throw new Error("FINANCE_STEP_UP_REPLAYED");
  }
}

export function createSessionChallenge(request: Request, response: Response): void {
  const principal = typeof request.body?.principal === "string" ? request.body.principal : "";
  const signer = typeof request.body?.signer === "string" ? request.body.signer : "";
  const origin = request.get("origin") ?? "";
  const parsed = parsedOrigin(origin);
  if (!XION_ADDRESS.test(principal) || !XION_ADDRESS.test(signer) || !parsed || !requestOriginAllowed(origin)) {
    response.status(400).json({ error: "invalid_challenge_request" });
    return;
  }
  const configuredChain = configuredAuthChain();
  if (!configuredChain) {
    response.status(503).json({ error: "authentication_not_configured" });
    return;
  }
  const domain = parsed.host;
  const issuedAt = new Date();
  const payload: ChallengePayload = {
    type: "gammon.session.v1",
    challengeId: randomBytes(16).toString("hex"),
    nonce: randomBytes(32).toString("base64url"),
    domain,
    origin,
    uri: `${origin}/api/session/verify`,
    chainId: configuredChain,
    principal,
    signer,
    purpose: "authenticate",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
  };
  response.json({ challengeToken: challengeToken(payload), message: canonicalPayload(payload), expiresAt: payload.expiresAt });
}

export async function verifySessionChallenge(request: Request, response: Response): Promise<void> {
  const token = typeof request.body?.challengeToken === "string" ? request.body.challengeToken : "";
  const signature = typeof request.body?.signature === "string" ? request.body.signature : "";
  const publicKey = typeof request.body?.publicKey === "string" ? request.body.publicKey : "";
  const payload = decodeChallenge(token);
  const origin = request.get("origin") ?? "";
  const parsed = parsedOrigin(origin);
  const configuredChain = configuredAuthChain();
  if (
    !payload ||
    !configuredChain ||
    payload.chainId !== configuredChain ||
    !parsed ||
    payload.type !== "gammon.session.v1" ||
    payload.purpose !== "authenticate" ||
    payload.origin !== origin ||
    payload.domain !== parsed.host ||
    Date.parse(payload.expiresAt) <= Date.now() ||
    Date.parse(payload.issuedAt) > Date.now() + 30_000 ||
    !requestOriginAllowed(origin)
  ) {
    response.status(401).json({ error: "invalid_or_expired_challenge" });
    return;
  }
  const message = canonicalPayload(payload);
  if (!(await verifyAdr36(message, payload.signer, signature, publicKey))) {
    response.status(401).json({ error: "invalid_signature" });
    return;
  }
  const grant = await liveGrantBindsPrincipal(payload.principal, payload.signer, payload.chainId);
  if (!grant) {
    response.status(401).json({ error: "wallet_grant_not_active" });
    return;
  }
  const now = Date.now();
  const expiresAt = Math.min(now + SESSION_TTL_MS, grant.grantExpiresAt ?? Number.POSITIVE_INFINITY);
  if (expiresAt <= now) {
    response.status(401).json({ error: "wallet_grant_not_active" });
    return;
  }
  const challengeHash = digest(token);
  if (!(await consumeChallenge(challengeHash, new Date(payload.expiresAt)))) {
    response.status(409).json({ error: "challenge_already_used" });
    return;
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const session: SessionRecord = {
    idHash: digest(sessionToken),
    principal: payload.principal,
    signer: payload.signer,
    chainId: payload.chainId,
    csrfToken,
    grantExpiresAt: grant.grantExpiresAt,
    expiresAt,
  };
  await persistSession(sessionToken, session);
  setSessionCookie(response, sessionToken, session.expiresAt);
  response.json({ principal: session.principal, csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
}

export async function requireSession(request: AuthenticatedRequest, response: Response, next: NextFunction): Promise<void> {
  try {
    const session = await sessionFromRequest(request);
    if (!session) {
      response.status(401).json({ error: "authentication_required" });
      return;
    }
    request.session = session;
    next();
  } catch {
    response.status(503).json({ error: "session_service_unavailable" });
  }
}

export function requireCsrf(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  const session = request.session;
  const supplied = request.get("x-csrf-token") ?? "";
  if (!session || !supplied) {
    response.status(403).json({ error: "csrf_check_failed" });
    return;
  }
  const expectedHash = session.csrfToken.length === 64 ? session.csrfToken : digest(session.csrfToken);
  const suppliedHash = digest(supplied);
  const expected = Buffer.from(expectedHash, "hex");
  const received = Buffer.from(suppliedHash, "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    response.status(403).json({ error: "csrf_check_failed" });
    return;
  }
  next();
}
