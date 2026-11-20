import { createPublicKey } from "node:crypto";
import { Secp256k1 } from "@cosmjs/crypto";
import { CASH_GAME_RULES_V1, serializeCashGameRules } from "@xion-beginner/backgammon-core";
import { payloadHash } from "./finance-crypto.js";

export type FundsMode = "free" | "verusd_testnet" | "verusd_production";
export type FundsAction =
  | "provider_account_create"
  | "link_bank"
  | "deposit"
  | "cash_out"
  | "wager"
  | "settle"
  | "refund"
  | "history";
export type AttestationScope = "infrastructure" | "asset" | "escrowIntegrity" | "escrowEntry" | "escrowRecovery" | "provider" | "financeRouter";

export interface VerUsdAssetManifest {
  readonly chainId: string;
  readonly genesisHash: string;
  readonly rpcUrl: string;
  readonly restUrl: string;
  readonly denom: string;
  readonly symbol: "verUSD";
  readonly decimals: 6;
  readonly finalityBlocks: number;
  readonly braleTransferType: "verona_testnet" | "verona";
  readonly escrowContract: string;
  readonly escrowCodeChecksum: string;
}

export interface ProductionApprovalExpiries {
  readonly entry: string | null;
  readonly recovery: string | null;
  readonly achAvailability: string | null;
}

export interface ApprovedAchPolicy {
  readonly availabilityDelaySeconds: number;
  readonly returnReconciliationHorizonSeconds: number;
}

export interface SettlementAuthorizerConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly contract: string;
  readonly publicKey: string;
  readonly signingKeyId: string;
}

export interface LegalDocumentTuple {
  readonly url: string;
  readonly version: string;
  readonly sha256: string;
  readonly expiresAt: string;
}

export interface LegalDocuments {
  readonly braleEua: LegalDocumentTuple;
  readonly plaidPrivacy: LegalDocumentTuple;
  readonly achAuthorization: LegalDocumentTuple;
}

export interface ResponsiblePlayHelp {
  readonly name: string;
  readonly url: string;
  readonly version: string;
  readonly sha256: string;
  readonly expiresAt: string;
}


export interface FundsConfig {
  readonly mode: FundsMode;
  readonly asset: VerUsdAssetManifest | null;
  readonly accountId: string | null;
  readonly staticBlockers: Readonly<Record<FundsAction, readonly string[]>>;
  readonly approvalExpiries: ProductionApprovalExpiries | null;
  readonly legalDocuments?: LegalDocuments | null;
  readonly responsiblePlayHelp: ResponsiblePlayHelp | null;
  readonly approvedAchPolicy: ApprovedAchPolicy | null;
  /** Validated under the same funds-mode approval policy as escrow entry. */
  readonly settlementAuthorizer: SettlementAuthorizerConfig | null;
  readonly rulesJson: string;
  /** Blocks provider requests before credentials or balances can be trusted. */
  readonly providerIdentityBlockers?: readonly string[];
  readonly escrowRecoverySnapshot?: EscrowRecoverySnapshot | null;
}

export interface EscrowRecoverySnapshot {
  readonly chainId: string;
  readonly genesisHash: string;
  readonly escrowContract: string;
  readonly escrowCodeChecksum: string;
  readonly denom: string;
  readonly finalityBlocks: number;
  readonly settlementAuthority: string;
  readonly escrowAdmin: string;
  readonly rakeBps: number;
  readonly rakeRecipient: string;
  readonly minStakePerPoint: string;
  readonly maxStakePerPoint: string;
  readonly fundingTimeoutSeconds: number;
  readonly cubeCap: number;
  readonly rulesVersion: string;
  readonly rakeCapMicroUsd: string;
  readonly rulesHash: string;
  readonly authorizerContract: string;
  readonly authorizerSigningKeyId: string;
}

export interface FundsAttestationResult {
  readonly infrastructure: readonly string[];
  readonly asset: readonly string[];
  readonly escrowIntegrity: readonly string[];
  readonly escrowEntry: readonly string[];
  readonly escrowRecovery: readonly string[];
  readonly provider: readonly string[];
  readonly financeRouter: readonly string[];
}

const VALID_MODES: Record<FundsMode, true> = {
  free: true,
  verusd_testnet: true,
  verusd_production: true,
};
const XION_ADDRESS = /^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ATTESTATION_MAX_AGE_MS = 60_000;
const MAX_FINALITY_BLOCKS = 1_000;

function requiredEnv(name: string, blockers: string[]): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) blockers.push(`missing_${name.toLowerCase()}`);
  return value;
}

function unique(...groups: readonly (readonly string[])[]): readonly string[] {
  return Object.freeze([...new Set(groups.flat())]);
}

function webhookSecretBlocker(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return "missing_brale_webhook_secret";
  if (value.trim() !== value || !/^[A-Za-z0-9_-]+$/.test(value)) return "invalid_brale_webhook_secret";
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) return "invalid_brale_webhook_secret";
  if (decoded.length < 32 || decoded.every((byte) => byte === decoded[0])) return "weak_brale_webhook_secret";
  return null;
}
function financeKeyRingBlocker(): string | null {
  const keyId = process.env.FINANCE_DATA_KEY_ID?.trim() || "primary";
  const encodedRing = process.env.FINANCE_DATA_KEYS;
  if (encodedRing) {
    try {
      const parsed = JSON.parse(encodedRing) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid_finance_data_keys";
      const encoded = (parsed as Record<string, unknown>)[keyId];
      if (typeof encoded !== "string") return "missing_active_finance_data_key";
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== encoded) return "invalid_active_finance_data_key";
      return null;
    } catch {
      return "invalid_finance_data_keys";
    }
  }
  if (process.env.NODE_ENV === "production") return "missing_finance_data_keys";
  const legacy = process.env.FINANCE_DATA_KEY ?? "";
  try {
    return Buffer.from(legacy, "base64").length === 32 ? null : "missing_finance_data_key";
  } catch {
    return "missing_finance_data_key";
  }
}

function positiveIntegerEnv(name: string, blockers: string[]): void {
  const value = requiredEnv(name, blockers);
  if (!/^[1-9]\d*$/.test(value)) blockers.push(`invalid_${name.toLowerCase()}`);
}

function positiveBoundedIntegerEnv(name: string, maximum: number, blockers: string[]): number | null {
  const value = requiredEnv(name, blockers);
  if (!/^[1-9]\d*$/.test(value)) {
    blockers.push(`invalid_${name.toLowerCase()}`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    blockers.push(`invalid_${name.toLowerCase()}`);
    return null;
  }
  return parsed;
}

function httpsUrlEnv(name: string, blockers: string[]): string {
  const value = requiredEnv(name, blockers);
  if (process.env[name] !== value) blockers.push(`invalid_${name.toLowerCase()}`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      blockers.push(`invalid_${name.toLowerCase()}`);
    }
  } catch {
    blockers.push(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function approvedExactValue(actualName: string, approvedName: string, blockers: string[]): void {
  const actual = process.env[actualName];
  const approved = process.env[approvedName];
  if (!approved) {
    blockers.push(`missing_${approvedName.toLowerCase()}`);
  } else if (actual !== approved) {
    blockers.push(`${actualName.toLowerCase()}_approval_mismatch`);
  }
}

function configuredAuthorizerTuple(
  blockers: string[],
  requireApproval: boolean,
): SettlementAuthorizerConfig | null {
  const blockerCount = blockers.length;
  const baseUrl = httpsUrlEnv("SETTLEMENT_AUTHORIZER_URL", blockers);
  const apiKey = requiredEnv("SETTLEMENT_AUTHORIZER_API_KEY", blockers);
  const contract = requiredEnv("VERUSD_ESCROW_CONTRACT", blockers);
  const publicKey = requiredEnv("SETTLEMENT_AUTHORIZER_PUBLIC_KEY", blockers);
  const signingKeyId = requiredEnv("SETTLEMENT_AUTHORIZER_SIGNING_KEY_ID", blockers);
  let valid = blockers.length === blockerCount && Boolean(baseUrl && apiKey && contract && publicKey && signingKeyId);
  if (!/^[\x21-\x7e]{1,200}$/.test(signingKeyId)) {
    blockers.push("invalid_settlement_authorizer_signing_key_id");
    valid = false;
  }
  try {
    if (publicKey.includes("BEGIN PUBLIC KEY")) createPublicKey(publicKey);
    else createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  } catch {
    blockers.push("invalid_settlement_authorizer_public_key");
    valid = false;
  }
  if (requireApproval && baseUrl) {
    for (const [actual, approved] of [
      ["SETTLEMENT_AUTHORIZER_URL", "SETTLEMENT_AUTHORIZER_APPROVED_URL"],
      ["SETTLEMENT_AUTHORIZER_PUBLIC_KEY", "SETTLEMENT_AUTHORIZER_APPROVED_PUBLIC_KEY"],
      ["SETTLEMENT_AUTHORIZER_SIGNING_KEY_ID", "SETTLEMENT_AUTHORIZER_APPROVED_SIGNING_KEY_ID"],
    ] as const) {
      const before = blockers.length;
      approvedExactValue(actual, approved, blockers);
      if (blockers.length !== before) valid = false;
    }
  }
  return valid
    ? Object.freeze({ baseUrl, apiKey, contract, publicKey, signingKeyId })
    : null;
}

function expiryBlocker(value: string | null, reason: string, now: number): string | null {
  const expiresAt = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return reason;
  return null;
}

function configuredLegalDocument(
  name: string,
  urlEnv: string,
  versionEnv: string,
  hashEnv: string,
  expiryEnv: string,
  blockers: string[],
  allowedHost: string | null,
): LegalDocumentTuple | null {
  const url = requiredEnv(urlEnv, blockers);
  const version = requiredEnv(versionEnv, blockers);
  const sha256 = requiredEnv(hashEnv, blockers).toLowerCase();
  const expiresAt = requiredEnv(expiryEnv, blockers);
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (allowedHost !== null && parsed.hostname !== allowedHost && !parsed.hostname.endsWith(`.${allowedHost}`))
    ) blockers.push(`invalid_${name}_document_url`);
  } catch {
    blockers.push(`invalid_${name}_document_url`);
  }
  if (!/^[\x21-\x7e]{1,100}$/.test(version)) blockers.push(`invalid_${name}_document_version`);
  if (!HEX_64.test(sha256)) blockers.push(`invalid_${name}_document_sha256`);
  const expiryMatchesIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt);
  const expiryTime = Date.parse(expiresAt);
  const normalizedExpiry = expiryMatchesIso && Number.isFinite(expiryTime)
    ? new Date(expiryTime).toISOString()
    : "";
  const expectedExpiry = expiresAt.includes(".") ? expiresAt : expiresAt.replace("Z", ".000Z");
  if (normalizedExpiry !== expectedExpiry) {
    blockers.push(`invalid_${name}_document_expiry`);
  } else if (expiryBlocker(expiresAt, `${name}_document_expired`, Date.now())) {
    blockers.push(`${name}_document_expired`);
  }
  if (!url || !version || !HEX_64.test(sha256) || !expiresAt) return null;
  return Object.freeze({ url, version, sha256, expiresAt });
}

function configuredResponsiblePlayHelp(blockers: string[]): ResponsiblePlayHelp | null {
  const name = requiredEnv("RESPONSIBLE_PLAY_HELP_NAME", blockers);
  const url = requiredEnv("RESPONSIBLE_PLAY_HELP_URL", blockers);
  const version = requiredEnv("RESPONSIBLE_PLAY_HELP_VERSION", blockers);
  const sha256 = requiredEnv("RESPONSIBLE_PLAY_HELP_SHA256", blockers);
  const expiresAt = requiredEnv("RESPONSIBLE_PLAY_HELP_EXPIRES_AT", blockers);
  let valid = Boolean(name && url && version && sha256 && expiresAt);

  if (!/^[\x20-\x7e]{1,100}$/.test(name) || process.env.RESPONSIBLE_PLAY_HELP_NAME !== name) {
    blockers.push("invalid_responsible_play_help_name");
    valid = false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      blockers.push("invalid_responsible_play_help_url");
      valid = false;
    }
  } catch {
    blockers.push("invalid_responsible_play_help_url");
    valid = false;
  }
  if (!/^[\x21-\x7e]{1,100}$/.test(version) || process.env.RESPONSIBLE_PLAY_HELP_VERSION !== version) {
    blockers.push("invalid_responsible_play_help_version");
    valid = false;
  }
  if (!HEX_64.test(sha256)) {
    blockers.push("invalid_responsible_play_help_sha256");
    valid = false;
  }
  const expiryMatchesIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt);
  const expiryTime = Date.parse(expiresAt);
  const normalizedExpiry = expiryMatchesIso && Number.isFinite(expiryTime)
    ? new Date(expiryTime).toISOString()
    : "";
  const expectedExpiry = expiresAt.includes(".") ? expiresAt : expiresAt.replace("Z", ".000Z");
  if (normalizedExpiry !== expectedExpiry) {
    blockers.push("invalid_responsible_play_help_expiry");
    valid = false;
  } else if (expiryBlocker(expiresAt, "responsible_play_help_expired", Date.now())) {
    blockers.push("responsible_play_help_expired");
    valid = false;
  }
  return valid ? Object.freeze({ name, url, version, sha256, expiresAt }) : null;
}


function assetManifest(mode: FundsMode, blockers: string[]): VerUsdAssetManifest | null {
  if (mode === "free") return null;
  const chainId = requiredEnv("VERUSD_CHAIN_ID", blockers);
  const genesisHash = requiredEnv("VERUSD_GENESIS_BLOCK_HASH", blockers).toLowerCase();
  const rpcUrl = httpsUrlEnv("VERUSD_RPC_URL", blockers);
  const restUrl = httpsUrlEnv("VERUSD_REST_URL", blockers);
  const denom = requiredEnv("VERUSD_DENOM", blockers);
  const escrowContract = requiredEnv("VERUSD_ESCROW_CONTRACT", blockers);
  const escrowCodeChecksum = requiredEnv("VERUSD_ESCROW_CODE_CHECKSUM", blockers).toLowerCase();
  const finalityBlocks = positiveBoundedIntegerEnv("VERUSD_FINALITY_BLOCKS", MAX_FINALITY_BLOCKS, blockers);
  const transferType = mode === "verusd_testnet" ? "verona_testnet" : "verona";
  if (process.env.AUTH_CHAIN_ID !== undefined && process.env.AUTH_CHAIN_ID !== chainId) {
    blockers.push("auth_chain_id_mismatch");
  }

  if (process.env.VERUSD_SYMBOL !== "verUSD") blockers.push("invalid_verusd_symbol");
  if (process.env.VERUSD_DECIMALS !== "6") blockers.push("invalid_verusd_decimals");
  if (process.env.BRALE_TRANSFER_TYPE !== transferType) blockers.push("invalid_brale_transfer_type");
  if (!HEX_64.test(genesisHash)) blockers.push("invalid_verusd_genesis_block_hash");
  if (!denom.startsWith("factory/xion1") || !denom.endsWith("/verusd")) blockers.push("invalid_verusd_denom");
  if (!XION_ADDRESS.test(escrowContract)) blockers.push("invalid_escrow_contract");
  if (!HEX_64.test(escrowCodeChecksum)) blockers.push("invalid_escrow_checksum");
  if (mode === "verusd_production") {
    for (const [actual, approved] of [
      ["VERUSD_CHAIN_ID", "VERUSD_APPROVED_CHAIN_ID"],
      ["VERUSD_GENESIS_BLOCK_HASH", "VERUSD_APPROVED_GENESIS_BLOCK_HASH"],
      ["VERUSD_RPC_URL", "VERUSD_APPROVED_RPC_URL"],
      ["VERUSD_REST_URL", "VERUSD_APPROVED_REST_URL"],
      ["VERUSD_DENOM", "VERUSD_APPROVED_DENOM"],
      ["VERUSD_ESCROW_CONTRACT", "VERUSD_APPROVED_ESCROW_CONTRACT"],
      ["VERUSD_ESCROW_CODE_CHECKSUM", "VERUSD_APPROVED_ESCROW_CODE_CHECKSUM"],
      ["VERUSD_FINALITY_BLOCKS", "VERUSD_APPROVED_FINALITY_BLOCKS"],
    ] as const) approvedExactValue(actual, approved, blockers);
  }
  if (blockers.length > 0 || finalityBlocks === null) return null;
  return Object.freeze({
    chainId,
    genesisHash,
    rpcUrl,
    restUrl,
    denom,
    symbol: "verUSD",
    decimals: 6,
    finalityBlocks,
    braleTransferType: transferType,
    escrowContract,
    escrowCodeChecksum,
  });
}

export function loadFundsConfig(): FundsConfig {
  const rawMode = (process.env.FUNDS_MODE?.trim() || "free") as FundsMode;
  if (!Object.hasOwn(VALID_MODES, rawMode)) throw new Error("Invalid FUNDS_MODE");

  const assetBlockers: string[] = [];
  const infrastructureBlockers: string[] = [];
  const sessionBlockers: string[] = [];
  const providerBlockers: string[] = [];
  const providerIdentityBlockers: string[] = [];
  const plaidBlockers: string[] = [];
  const escrowEntryBlockers: string[] = [];
  const escrowIntegrityBlockers: string[] = [];
  const paymentLegalBlockers: string[] = [];
  const wagerLegalBlockers: string[] = [];
  const entryApprovalBlockers: string[] = [];
  const recoveryApprovalBlockers: string[] = [];
  const asset = assetManifest(rawMode, assetBlockers);
  if (
    rawMode !== "free"
    && process.env.AUTH_RPC_URL !== undefined
    && process.env.AUTH_RPC_URL !== process.env.VERUSD_RPC_URL
  ) {
    sessionBlockers.push("unapproved_auth_rpc_url");
  }
  const accountId = rawMode === "free" ? "" : requiredEnv("BRALE_ACCOUNT_ID", providerBlockers);
  if (rawMode !== "free" && !accountId) providerIdentityBlockers.push("missing_brale_account_id");
  let responsiblePlayHelp: ResponsiblePlayHelp | null = null;
  let legalDocuments: LegalDocuments | null = null;
  let approvedAchPolicy: ApprovedAchPolicy | null = null;
  let settlementAuthorizer: SettlementAuthorizerConfig | null = null;

  if (rawMode !== "free") {
    if (!process.env.DATABASE_URL) infrastructureBlockers.push("missing_database_url");
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      sessionBlockers.push("missing_session_secret");
    }
    const braleApiUrl = httpsUrlEnv("BRALE_API_URL", providerIdentityBlockers);
    const braleAuthUrl = httpsUrlEnv("BRALE_AUTH_URL", providerIdentityBlockers);
    if (!braleApiUrl) providerIdentityBlockers.push("missing_brale_api_url");
    if (!braleAuthUrl) providerIdentityBlockers.push("missing_brale_auth_url");
    if (!process.env.BRALE_API_KEY) providerBlockers.push("missing_brale_api_key");
    const webhookSecretFailure = webhookSecretBlocker(process.env.BRALE_WEBHOOK_SECRET);
    if (webhookSecretFailure) providerBlockers.push(webhookSecretFailure);
    if (!process.env.BRALE_WEBHOOK_SUBSCRIPTION_ID) providerBlockers.push("missing_brale_webhook_subscription_id");
    if (!process.env.BRALE_WEBHOOK_ENVIRONMENT) providerIdentityBlockers.push("missing_brale_webhook_environment");
    for (const name of ["BRALE_PROGRAM_ID", "BRALE_REQUIRED_ACCOUNT_CAPABILITY"]) {
      requiredEnv(name, providerIdentityBlockers);
    }
    for (const name of [
      "FINANCE_AUTHORIZATION_CONTRACT",
      "FINANCE_AUTHORIZATION_MESSAGE_KEY",
      "FINANCE_AUTHORIZATION_CODE_CHECKSUM",
      "FINANCE_AUTHORIZATION_ADMIN",
      "FINANCE_AUTHORIZATION_MAX_TRANSFER_MICRO_USD",
      "CASH_OUT_AUTHORIZATION_PRIVATE_KEY",
      "CASH_OUT_AUTHORIZATION_PUBLIC_KEY",
    ]) requiredEnv(name, sessionBlockers);
    if (process.env.FINANCE_AUTHORIZATION_MESSAGE_KEY !== "authorize_finance_action") {
      sessionBlockers.push("invalid_finance_authorization_message_key");
    }
    if (!XION_ADDRESS.test(process.env.FINANCE_AUTHORIZATION_CONTRACT ?? "")) {
      sessionBlockers.push("invalid_finance_authorization_contract");
    }
    if (!XION_ADDRESS.test(process.env.FINANCE_AUTHORIZATION_ADMIN ?? "")) {
      sessionBlockers.push("invalid_finance_authorization_admin");
    }
    if (!HEX_64.test(process.env.FINANCE_AUTHORIZATION_CODE_CHECKSUM ?? "")) {
      sessionBlockers.push("invalid_finance_authorization_checksum");
    }
    const authorizationPublicKey = process.env.CASH_OUT_AUTHORIZATION_PUBLIC_KEY ?? "";
    const authorizationPrivateKeyEncoded = process.env.CASH_OUT_AUTHORIZATION_PRIVATE_KEY ?? "";
    const authorizationPrivateKey = Buffer.from(authorizationPrivateKeyEncoded, "base64");
    if (!/^(02|03)[0-9a-f]{64}$/.test(authorizationPublicKey)) {
      sessionBlockers.push("invalid_cash_out_authorization_public_key");
    }
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(authorizationPrivateKeyEncoded)
      || authorizationPrivateKey.length !== 32
    ) {
      sessionBlockers.push("invalid_cash_out_authorization_private_key");
    } else {
      try {
        const derived = Buffer.from(
          Secp256k1.compressPubkey(Secp256k1.makeKeypair(authorizationPrivateKey).pubkey),
        ).toString("hex");
        if (derived !== authorizationPublicKey) sessionBlockers.push("cash_out_authorization_key_mismatch");
      } catch {
        sessionBlockers.push("invalid_cash_out_authorization_private_key");
      }
    }
    if (!/^[1-9]\d*$/.test(process.env.FINANCE_AUTHORIZATION_MAX_TRANSFER_MICRO_USD ?? "")) {
      sessionBlockers.push("invalid_finance_authorization_max_transfer");
    }
    const plaidWebhookUrl = httpsUrlEnv("BRALE_PLAID_WEBHOOK_URL", plaidBlockers);
    if (!plaidWebhookUrl) plaidBlockers.push("missing_brale_plaid_webhook_url");

    const financeKeyFailure = financeKeyRingBlocker();
    if (financeKeyFailure) providerBlockers.push(financeKeyFailure);
    const financeHashKey = process.env.FINANCE_HASH_KEY ?? "";
    if (Buffer.from(financeHashKey, "base64").length !== 32) {
      providerBlockers.push("missing_finance_hash_key");
    }

    for (const name of ["SETTLEMENT_AUTHORITY_CONTRACT", "VERUSD_ESCROW_ADMIN"]) {
      requiredEnv(name, escrowIntegrityBlockers);
    }
    settlementAuthorizer = configuredAuthorizerTuple(escrowEntryBlockers, rawMode === "verusd_production");
    for (const name of [
      "VERUSD_MIN_STAKE_MICRO_USD",
      "VERUSD_MAX_STAKE_MICRO_USD",
      "VERUSD_FUNDING_TIMEOUT_SECONDS",
      "VERUSD_RAKE_RECIPIENT",
    ]) requiredEnv(name, escrowEntryBlockers);
    const availabilityDelaySeconds = positiveBoundedIntegerEnv(
      "ACH_AVAILABILITY_DELAY_SECONDS",
      365 * 24 * 60 * 60,
      providerBlockers,
    );
    const returnReconciliationHorizonSeconds = positiveBoundedIntegerEnv(
      "ACH_RETURN_RECONCILIATION_HORIZON_SECONDS",
      365 * 24 * 60 * 60,
      providerBlockers,
    );
    if (availabilityDelaySeconds !== null && returnReconciliationHorizonSeconds !== null) {
      approvedAchPolicy = Object.freeze({ availabilityDelaySeconds, returnReconciliationHorizonSeconds });
    } else {
      providerBlockers.push("approved_ach_policy_required");
    }

    const braleEua = configuredLegalDocument(
      "brale_eua",
      "BRALE_EUA_URL",
      "BRALE_END_USER_TOS_VERSION",
      "BRALE_EUA_SHA256",
      "BRALE_EUA_EXPIRES_AT",
      paymentLegalBlockers,
      "brale.xyz",
    );
    const plaidPrivacy = configuredLegalDocument(
      "plaid_privacy",
      "PLAID_PRIVACY_URL",
      "PLAID_PRIVACY_VERSION",
      "PLAID_PRIVACY_SHA256",
      "PLAID_PRIVACY_EXPIRES_AT",
      paymentLegalBlockers,
      "plaid.com",
    );
    const achAuthorization = configuredLegalDocument(
      "ach_authorization",
      "ACH_AUTHORIZATION_URL",
      "ACH_AUTHORIZATION_VERSION",
      "ACH_AUTHORIZATION_SHA256",
      "ACH_AUTHORIZATION_EXPIRES_AT",
      paymentLegalBlockers,
      null,
    );
    if (braleEua && plaidPrivacy && achAuthorization) {
      legalDocuments = Object.freeze({ braleEua, plaidPrivacy, achAuthorization });
    }
    for (const name of ["TERMS_VERSION", "PRIVACY_VERSION"]) requiredEnv(name, paymentLegalBlockers);
    for (const name of ["CASH_GAME_TERMS_VERSION", "RESPONSIBLE_PLAY_POLICY_VERSION"]) {
      requiredEnv(name, wagerLegalBlockers);
    }
  }

  let approvalExpiries: ProductionApprovalExpiries | null = null;
  if (rawMode === "verusd_production") {
    for (const name of [
      "BRALE_PROGRAM_APPROVAL_ID",
      "WAGERING_PROGRAM_APPROVAL_ID",
      "BRALE_PROGRAM_ID",
      "BRALE_REQUIRED_ACCOUNT_CAPABILITY",
      "LEGAL_APPROVAL_ID",
      "JURISDICTION_POLICY_VERSION",
      "AGE_AND_IDENTITY_POLICY_VERSION",
      "GEOLOCATION_POLICY_VERSION",
      "ELIGIBILITY_POLICY_VERSION",
      "TERMS_VERSION",
      "PRIVACY_VERSION",
      "BRALE_END_USER_TOS_VERSION",
      "ACH_AUTHORIZATION_VERSION",
      "ACH_AVAILABILITY_POLICY_ID",
      "CUSTODY_DISCLOSURE_VERSION",
      "FEE_SCHEDULE_VERSION",
      "PAYMENT_TIMING_POLICY_VERSION",
      "RESPONSIBLE_PLAY_POLICY_VERSION",
      "COMPLAINTS_POLICY_VERSION",
      "DATA_LIFECYCLE_POLICY_VERSION",
      "DATA_RETENTION_SCHEDULE_VERSION",
      "LEGACY_RECONCILIATION_ID",
    ]) requiredEnv(name, entryApprovalBlockers);
    responsiblePlayHelp = configuredResponsiblePlayHelp(entryApprovalBlockers);
    for (const [actual, approved] of [
      ["BRALE_WEBHOOK_ENVIRONMENT", "BRALE_APPROVED_ENVIRONMENT"],
      ["BRALE_API_URL", "BRALE_APPROVED_API_URL"],
      ["FINANCE_AUTHORIZATION_CONTRACT", "FINANCE_APPROVED_AUTHORIZATION_CONTRACT"],
      ["FINANCE_AUTHORIZATION_MESSAGE_KEY", "FINANCE_APPROVED_AUTHORIZATION_MESSAGE_KEY"],
      ["FINANCE_AUTHORIZATION_CODE_CHECKSUM", "FINANCE_APPROVED_AUTHORIZATION_CODE_CHECKSUM"],
      ["FINANCE_AUTHORIZATION_ADMIN", "FINANCE_APPROVED_AUTHORIZATION_ADMIN"],
      ["FINANCE_AUTHORIZATION_MAX_TRANSFER_MICRO_USD", "FINANCE_APPROVED_AUTHORIZATION_MAX_TRANSFER_MICRO_USD"],
      ["CASH_OUT_AUTHORIZATION_PUBLIC_KEY", "FINANCE_APPROVED_AUTHORIZATION_PUBLIC_KEY"],
      ["BRALE_AUTH_URL", "BRALE_APPROVED_AUTH_URL"],
      ["BRALE_ACCOUNT_ID", "BRALE_APPROVED_ACCOUNT_ID"],
      ["BRALE_PROGRAM_ID", "BRALE_APPROVED_PROGRAM_ID"],
      ["BRALE_REQUIRED_ACCOUNT_CAPABILITY", "BRALE_APPROVED_ACCOUNT_CAPABILITY"],
      ["BRALE_TRANSFER_TYPE", "BRALE_APPROVED_TRANSFER_TYPE"],
    ] as const) approvedExactValue(actual, approved, providerIdentityBlockers);
    for (const [actual, approved] of [
      ["SETTLEMENT_AUTHORITY_CONTRACT", "SETTLEMENT_AUTHORITY_APPROVED_CONTRACT"],
      ["VERUSD_ESCROW_ADMIN", "VERUSD_APPROVED_ESCROW_ADMIN"],
      ["VERUSD_RAKE_RECIPIENT", "VERUSD_APPROVED_RAKE_RECIPIENT"],
      ["VERUSD_MIN_STAKE_MICRO_USD", "VERUSD_APPROVED_MIN_STAKE_MICRO_USD"],
      ["VERUSD_MAX_STAKE_MICRO_USD", "VERUSD_APPROVED_MAX_STAKE_MICRO_USD"],
      ["VERUSD_FUNDING_TIMEOUT_SECONDS", "VERUSD_APPROVED_FUNDING_TIMEOUT_SECONDS"],
      ["ACH_AVAILABILITY_DELAY_SECONDS", "ACH_APPROVED_AVAILABILITY_DELAY_SECONDS"],
      ["ACH_RETURN_RECONCILIATION_HORIZON_SECONDS", "ACH_APPROVED_RETURN_RECONCILIATION_HORIZON_SECONDS"],
    ] as const) approvedExactValue(actual, approved, entryApprovalBlockers);
    approvedExactValue("BRALE_PLAID_WEBHOOK_URL", "BRALE_APPROVED_PLAID_WEBHOOK_URL", plaidBlockers);
    if (approvedAchPolicy === null) entryApprovalBlockers.push("approved_ach_policy_required");
    const entry = requiredEnv("PRODUCTION_APPROVAL_EXPIRES_AT", entryApprovalBlockers) || null;
    const recovery = requiredEnv("PRODUCTION_RECOVERY_APPROVAL_EXPIRES_AT", recoveryApprovalBlockers) || null;
    const achAvailability = requiredEnv("ACH_AVAILABILITY_POLICY_EXPIRES_AT", entryApprovalBlockers) || null;
    approvalExpiries = Object.freeze({ entry, recovery, achAvailability });
    if (process.env.PRODUCTION_FUNDS_APPROVED !== "true") entryApprovalBlockers.push("production_funds_not_approved");
    if (process.env.PRODUCTION_RECOVERY_APPROVED !== "true") recoveryApprovalBlockers.push("production_recovery_not_approved");
    if (process.env.FUNDS_ENTRY_KILL_SWITCH !== "false") {
      entryApprovalBlockers.push(
        process.env.FUNDS_ENTRY_KILL_SWITCH === "true" ? "funds_entry_kill_switch" : "invalid_funds_entry_kill_switch",
      );
    }
  }
  providerBlockers.push(...providerIdentityBlockers);

  const entryProviderBlockers = unique(
    assetBlockers,
    infrastructureBlockers,
    sessionBlockers,
    providerBlockers,
    paymentLegalBlockers,
    entryApprovalBlockers,
  );
  const staticBlockers: Record<FundsAction, readonly string[]> = {
    provider_account_create: entryProviderBlockers,
    link_bank: unique(entryProviderBlockers, plaidBlockers),
    deposit: unique(entryProviderBlockers, plaidBlockers),
    cash_out: unique(assetBlockers, infrastructureBlockers, sessionBlockers, providerBlockers, recoveryApprovalBlockers),
    wager: unique(
      assetBlockers,
      infrastructureBlockers,
      sessionBlockers,
      escrowIntegrityBlockers,
      escrowEntryBlockers,
      wagerLegalBlockers,
      rawMode === "verusd_production" ? paymentLegalBlockers : [],
      entryApprovalBlockers,
    ),
    settle: unique(assetBlockers, infrastructureBlockers, escrowIntegrityBlockers, recoveryApprovalBlockers),
    refund: unique(assetBlockers, infrastructureBlockers, escrowIntegrityBlockers, recoveryApprovalBlockers),
    history: unique(infrastructureBlockers, sessionBlockers),
  };
  const settlementAuthority = process.env.SETTLEMENT_AUTHORITY_CONTRACT ?? "";
  const rulesJson = serializeCashGameRules(CASH_GAME_RULES_V1);
  const escrowAdmin = process.env.VERUSD_ESCROW_ADMIN ?? "";
  const rakeRecipient = process.env.VERUSD_RAKE_RECIPIENT ?? "";
  const minStakePerPoint = process.env.VERUSD_MIN_STAKE_MICRO_USD ?? "";
  const maxStakePerPoint = process.env.VERUSD_MAX_STAKE_MICRO_USD ?? "";
  const fundingTimeoutSeconds = Number(process.env.VERUSD_FUNDING_TIMEOUT_SECONDS);
  const escrowRecoverySnapshot = asset && settlementAuthority && escrowAdmin && rakeRecipient &&
      minStakePerPoint && maxStakePerPoint && Number.isSafeInteger(fundingTimeoutSeconds) &&
      fundingTimeoutSeconds > 0 && settlementAuthorizer
    ? Object.freeze({
      chainId: asset.chainId,
      genesisHash: asset.genesisHash,
      escrowContract: asset.escrowContract,
      escrowCodeChecksum: asset.escrowCodeChecksum,
      denom: asset.denom,
      settlementAuthority,
      finalityBlocks: asset.finalityBlocks,
      escrowAdmin,
      rakeBps: CASH_GAME_RULES_V1.rakeBps,
      rakeRecipient,
      minStakePerPoint,
      maxStakePerPoint,
      fundingTimeoutSeconds,
      cubeCap: CASH_GAME_RULES_V1.cubeCap,
      rulesVersion: CASH_GAME_RULES_V1.version,
      rakeCapMicroUsd: CASH_GAME_RULES_V1.rakeCapMicroUsd.toString(),
      rulesHash: payloadHash(JSON.parse(rulesJson)),
      authorizerContract: settlementAuthorizer.contract,
      authorizerSigningKeyId: settlementAuthorizer.signingKeyId,
    })
    : null;
  return Object.freeze({
    mode: rawMode,
    asset,
    accountId: accountId || null,
    staticBlockers: Object.freeze(staticBlockers),
    approvalExpiries,
    legalDocuments,
    responsiblePlayHelp,
    approvedAchPolicy,
    settlementAuthorizer,
    rulesJson,
    providerIdentityBlockers: unique(providerIdentityBlockers),
    escrowRecoverySnapshot,
  });
}

interface ScopeStatus {
  readonly blockers: readonly string[];
  readonly checkedAt: number | null;
}

function publicBlockerCode(code: string): string {
  if (code === "free_play_only") return code;
  if (code.endsWith("_attestation_stale")) return "attestation_required";
  if (code.includes("recovery_approval")) return "recovery_approval_required";
  if (
    code.includes("approval") ||
    code.includes("document") ||
    code.includes("kill_switch") ||
    code.includes("responsible_play_help")
  ) {
    return "entry_approval_required";
  }
  if (
    code.includes("escrow") ||
    code.includes("chain") ||
    code.includes("asset") ||
    code.includes("integrity") ||
    code.includes("authorizer")
  ) {
    return "chain_integrity_unavailable";
  }
  return "funds_unavailable";
}


export class FundsGate {
  readonly config: FundsConfig;
  private scopes: Record<AttestationScope, ScopeStatus> = {
    infrastructure: { blockers: [], checkedAt: null },
    asset: { blockers: [], checkedAt: null },
    escrowIntegrity: { blockers: [], checkedAt: null },
    escrowEntry: { blockers: [], checkedAt: null },
    escrowRecovery: { blockers: [], checkedAt: null },
    provider: { blockers: [], checkedAt: null },
    financeRouter: { blockers: [], checkedAt: null },
  };

  constructor(config: FundsConfig = loadFundsConfig()) {
    this.config = config;
  }

  setAttestation(result: FundsAttestationResult): void {
    const checkedAt = Date.now();
    this.scopes = {
      infrastructure: { blockers: unique(result.infrastructure), checkedAt },
      asset: { blockers: unique(result.asset), checkedAt },
      escrowIntegrity: { blockers: unique(result.escrowIntegrity), checkedAt },
      escrowEntry: { blockers: unique(result.escrowEntry), checkedAt },
      escrowRecovery: { blockers: unique(result.escrowRecovery), checkedAt },
      provider: { blockers: unique(result.provider), checkedAt },
      financeRouter: { blockers: unique(result.financeRouter), checkedAt },
    };
  }

  private requiredScopes(action: FundsAction): readonly AttestationScope[] {
    if (action === "history") return ["infrastructure"];
    if (action === "provider_account_create" || action === "link_bank" || action === "deposit") {
      return ["infrastructure", "asset", "provider"];
    }
    if (action === "cash_out") return ["infrastructure", "asset", "provider", "financeRouter"];
    if (action === "wager") return ["infrastructure", "asset", "escrowIntegrity", "escrowEntry"];
    return ["infrastructure", "asset", "escrowIntegrity", "escrowRecovery"];
  }

  private liveApprovalBlockers(action: FundsAction, now: number): readonly string[] {
    if (this.config.mode !== "verusd_production") return [];
    const entryAction = action === "provider_account_create" || action === "link_bank" || action === "deposit" || action === "wager";
    if (!entryAction) {
      if (!this.config.approvalExpiries || (action !== "cash_out" && action !== "settle" && action !== "refund")) return [];
      const blocker = expiryBlocker(this.config.approvalExpiries.recovery, "production_recovery_approval_expired", now);
      return blocker ? [blocker] : [];
    }
    const responsiblePlayHelpBlockers = this.config.responsiblePlayHelp
      ? [expiryBlocker(this.config.responsiblePlayHelp.expiresAt, "responsible_play_help_expired", now)]
        .filter((blocker): blocker is string => blocker !== null)
      : ["responsible_play_help_required"];
    const legalDocumentBlockers = this.config.legalDocuments
      ? Object.entries(this.config.legalDocuments)
        .map(([name, document]) => expiryBlocker(document.expiresAt, `${name}_document_expired`, now))
        .filter((blocker): blocker is string => blocker !== null)
      : [];
    if (!this.config.approvalExpiries) return [...responsiblePlayHelpBlockers, ...legalDocumentBlockers];
    return [
      ...responsiblePlayHelpBlockers,
      ...legalDocumentBlockers,
      expiryBlocker(this.config.approvalExpiries.entry, "production_approval_expired", now),
      expiryBlocker(this.config.approvalExpiries.achAvailability, "ach_availability_policy_expired", now),
    ].filter((blocker): blocker is string => blocker !== null);
  }

  blockersFor(action: FundsAction): readonly string[] {
    if (this.config.mode === "free") return ["free_play_only"];
    const now = Date.now();
    const blockers = [...this.config.staticBlockers[action], ...this.liveApprovalBlockers(action, now)];
    for (const scope of this.requiredScopes(action)) {
      const status = this.scopes[scope];
      blockers.push(...status.blockers);
      if (status.checkedAt === null || now - status.checkedAt > ATTESTATION_MAX_AGE_MS) {
        blockers.push(`${scope}_attestation_stale`);
      }
    }
    return [...new Set(blockers)];
  }

  escrowRecoverySnapshot(): EscrowRecoverySnapshot | null {
    return this.config.escrowRecoverySnapshot ?? null;
  }

  /** Recovery consumes and re-attests the funded game's complete approved tuple. */
  escrowRecoveryBlockers(snapshot: EscrowRecoverySnapshot): readonly string[] {
    const blockers = [...this.blockersFor("settle")];
    const expected = this.escrowRecoverySnapshot();
    if (
      !expected ||
      snapshot.chainId !== expected.chainId ||
      snapshot.genesisHash !== expected.genesisHash ||
      snapshot.escrowContract !== expected.escrowContract ||
      snapshot.escrowCodeChecksum !== expected.escrowCodeChecksum ||
      snapshot.denom !== expected.denom ||
      snapshot.finalityBlocks !== expected.finalityBlocks ||
      snapshot.settlementAuthority !== expected.settlementAuthority ||
      snapshot.escrowAdmin !== expected.escrowAdmin ||
      snapshot.authorizerContract !== expected.authorizerContract ||
      snapshot.authorizerSigningKeyId !== expected.authorizerSigningKeyId
    ) {
      blockers.push("funded_escrow_integrity_mismatch");
    }
    return [...new Set(blockers)];
  }

  balanceReadBlockers(): readonly string[] {
    if (this.config.mode === "free") return [];
    const now = Date.now();
    const blockers: string[] = [];
    for (const scope of ["infrastructure", "asset"] as const) {
      const status = this.scopes[scope];
      blockers.push(...status.blockers);
      if (status.checkedAt === null || now - status.checkedAt > ATTESTATION_MAX_AGE_MS) {
        blockers.push(`${scope}_attestation_stale`);
      }
    }
    return [...new Set(blockers)];
  }

  allows(action: FundsAction): boolean {
    return this.blockersFor(action).length === 0;
  }

  publicState(): {
    mode: FundsMode;
    testFunds: boolean;
    entryEnabled: boolean;
    recoveryEnabled: boolean;
    providerAccountCreateEnabled: boolean;
    bankLinkEnabled: boolean;
    depositEnabled: boolean;
    cashOutEnabled: boolean;
    wagerEnabled: boolean;
    settlementEnabled: boolean;
    asset: { symbol: "verUSD"; decimals: 6 } | null;
    attestedAt: string | null;
    attestationCycleFresh: boolean;
    attestationCycleCompletedAt: string | null;
    blockers: readonly string[];
    actionBlockers: Readonly<Record<FundsAction, readonly string[]>>;
    legalVersions: {
      terms: string | null;
      privacy: string | null;
      braleEndUserTerms: string | null;
      achAuthorization: string | null;
      responsiblePlay: string | null;
    };
    legalDocuments: {
      braleEua: { url: string; version: string; sha256: string } | null;
      plaidPrivacy: { url: string; version: string; sha256: string } | null;
      achAuthorization: { url: string; version: string; sha256: string } | null;
    } | null;
    responsiblePlayHelp: {
      name: string;
      url: string;
      version: string;
      sha256: string;
      expiresAt: string;
    } | null;
  } {
    const internalActionBlockers: Readonly<Record<FundsAction, readonly string[]>> = Object.freeze({
      provider_account_create: this.blockersFor("provider_account_create"),
      link_bank: this.blockersFor("link_bank"),
      deposit: this.blockersFor("deposit"),
      cash_out: this.blockersFor("cash_out"),
      wager: this.blockersFor("wager"),
      settle: this.blockersFor("settle"),
      refund: this.blockersFor("refund"),
      history: this.blockersFor("history"),
    });
    const actionBlockers: Readonly<Record<FundsAction, readonly string[]>> = Object.freeze({
      provider_account_create: [...new Set(internalActionBlockers.provider_account_create.map(publicBlockerCode))],
      link_bank: [...new Set(internalActionBlockers.link_bank.map(publicBlockerCode))],
      deposit: [...new Set(internalActionBlockers.deposit.map(publicBlockerCode))],
      cash_out: [...new Set(internalActionBlockers.cash_out.map(publicBlockerCode))],
      wager: [...new Set(internalActionBlockers.wager.map(publicBlockerCode))],
      settle: [...new Set(internalActionBlockers.settle.map(publicBlockerCode))],
      refund: [...new Set(internalActionBlockers.refund.map(publicBlockerCode))],
      history: [...new Set(internalActionBlockers.history.map(publicBlockerCode))],
    });
    const providerAccountCreateEnabled = internalActionBlockers.provider_account_create.length === 0;
    const bankLinkEnabled = internalActionBlockers.link_bank.length === 0;
    const depositEnabled = internalActionBlockers.deposit.length === 0;
    const cashOutEnabled = internalActionBlockers.cash_out.length === 0;
    const wagerEnabled = internalActionBlockers.wager.length === 0;
    const settlementEnabled = internalActionBlockers.settle.length === 0 && internalActionBlockers.refund.length === 0;
    const relevantScopes: AttestationScope[] = [
      "infrastructure", "asset", "escrowIntegrity", "escrowEntry", "escrowRecovery", "provider", "financeRouter",
    ];
    const cycleCheckedAt = relevantScopes.map((scope) => this.scopes[scope].checkedAt);
    const attestationCycleFresh = cycleCheckedAt.every(
      (checkedAt) => checkedAt !== null && Date.now() - checkedAt <= ATTESTATION_MAX_AGE_MS,
    );
    const allFresh = relevantScopes.every((scope) => {
      const status = this.scopes[scope];
      return status.blockers.length === 0 && status.checkedAt !== null && Date.now() - status.checkedAt <= ATTESTATION_MAX_AGE_MS;
    });
    const oldestAttestation = allFresh
      ? Math.min(...relevantScopes.map((scope) => this.scopes[scope].checkedAt as number))
      : null;
    const completedAttestation = attestationCycleFresh
      ? Math.min(...cycleCheckedAt as number[])
      : null;
    return {
      mode: this.config.mode,
      testFunds: this.config.mode === "verusd_testnet",
      entryEnabled: providerAccountCreateEnabled || bankLinkEnabled || depositEnabled || wagerEnabled,
      recoveryEnabled: cashOutEnabled || settlementEnabled,
      providerAccountCreateEnabled,
      bankLinkEnabled,
      depositEnabled,
      cashOutEnabled,
      wagerEnabled,
      settlementEnabled,
      asset: this.config.asset ? { symbol: this.config.asset.symbol, decimals: this.config.asset.decimals } : null,
      attestationCycleFresh,
      attestationCycleCompletedAt: completedAttestation === null ? null : new Date(completedAttestation).toISOString(),
      blockers: actionBlockers.wager,
      actionBlockers,
      attestedAt: oldestAttestation === null ? null : new Date(oldestAttestation).toISOString(),
      legalVersions: {
        terms: process.env.TERMS_VERSION ?? null,
        privacy: process.env.PRIVACY_VERSION ?? null,
        braleEndUserTerms: process.env.BRALE_END_USER_TOS_VERSION ?? null,
        achAuthorization: process.env.ACH_AUTHORIZATION_VERSION ?? null,
        responsiblePlay: process.env.RESPONSIBLE_PLAY_POLICY_VERSION ?? null,
      },
      legalDocuments: this.config.legalDocuments
        ? {
            braleEua: {
              url: this.config.legalDocuments.braleEua.url,
              version: this.config.legalDocuments.braleEua.version,
              sha256: this.config.legalDocuments.braleEua.sha256,
            },
            plaidPrivacy: {
              url: this.config.legalDocuments.plaidPrivacy.url,
              version: this.config.legalDocuments.plaidPrivacy.version,
              sha256: this.config.legalDocuments.plaidPrivacy.sha256,
            },
            achAuthorization: {
              url: this.config.legalDocuments.achAuthorization.url,
              version: this.config.legalDocuments.achAuthorization.version,
              sha256: this.config.legalDocuments.achAuthorization.sha256,
            },
          }
        : null,
      responsiblePlayHelp: this.config.responsiblePlayHelp
        ? {
            name: this.config.responsiblePlayHelp.name,
            url: this.config.responsiblePlayHelp.url,
            version: this.config.responsiblePlayHelp.version,
            sha256: this.config.responsiblePlayHelp.sha256,
            expiresAt: this.config.responsiblePlayHelp.expiresAt,
          }
        : null,
    };
  }
}

export const fundsGate = new FundsGate();
