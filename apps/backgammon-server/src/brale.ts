/**
 * Brale API client for ACH on/off ramp.
 *
 * Onramp (ACH Debit): User links bank via Plaid → pull USD → mint stablecoins to XION wallet
 * Offramp (ACH Credit): Stablecoins in Brale custodial → send USD to user's bank
 *
 * Brale supports xion and xion_testnet as transfer types natively.
 * Docs: https://docs.brale.xyz
 */

import { logger } from "./logger.js";

const BRALE_BASE_URL = process.env.BRALE_API_URL || "https://api.brale.xyz";
const BRALE_API_KEY = process.env.BRALE_API_KEY || "";
const BRALE_ACCOUNT_ID = process.env.BRALE_ACCOUNT_ID || "";
const BRALE_NETWORK = process.env.BRALE_NETWORK || "xion_testnet"; // "xion" for mainnet

interface BraleHeaders {
  "Content-Type": string;
  Authorization: string;
  "Idempotency-Key"?: string;
}

function headers(idempotencyKey?: string): BraleHeaders {
  const h: BraleHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${BRALE_API_KEY}`,
  };
  if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
  return h;
}

async function braleRequest(method: string, path: string, body?: object, idempotencyKey?: string): Promise<any> {
  const url = `${BRALE_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(idempotencyKey),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error("Brale API error", { method, path, status: res.status, body: text });
    throw new Error(`Brale API ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Account ──────────────────────────────────────────────

export async function getAccountId(): Promise<string> {
  if (BRALE_ACCOUNT_ID) return BRALE_ACCOUNT_ID;
  const data = await braleRequest("GET", "/accounts");
  return data.data?.[0]?.id || "";
}

// ── Plaid Link (for ACH Debit onramp) ───────────────────

/** Create a Plaid link token for the user to connect their bank account */
export async function createPlaidLinkToken(accountId: string, redirectUri?: string): Promise<{ linkToken: string }> {
  const body: any = {};
  if (redirectUri) body.redirect_uri = redirectUri;

  const data = await braleRequest("POST", `/accounts/${accountId}/plaid/link_token`, body);
  return { linkToken: data.link_token };
}

/** Exchange Plaid public token after user completes Plaid Link */
export async function registerPlaidAccount(accountId: string, publicToken: string): Promise<{ addressId: string }> {
  const data = await braleRequest("POST", `/accounts/${accountId}/plaid/register-account`, {
    public_token: publicToken,
  });
  return { addressId: data.address_id || data.id };
}

// ── Addresses ───────────────────────────────────────────

/** Register an external XION wallet address for receiving stablecoins */
export async function registerWalletAddress(
  accountId: string,
  walletAddress: string,
  label?: string,
): Promise<{ addressId: string }> {
  const data = await braleRequest("POST", `/accounts/${accountId}/addresses/external`, {
    address: walletAddress,
    network: BRALE_NETWORK,
    transfer_types: [BRALE_NETWORK],
    label: label || `XION wallet ${walletAddress.slice(0, 10)}...`,
  });
  return { addressId: data.id };
}

/** Register a bank account for ACH credit (offramp) via direct entry */
export async function registerBankAccount(
  accountId: string,
  routingNumber: string,
  accountNumber: string,
  accountType: "checking" | "savings",
  holderName: string,
): Promise<{ addressId: string }> {
  const data = await braleRequest("POST", `/accounts/${accountId}/addresses/external`, {
    routing_number: routingNumber,
    account_number: accountNumber,
    account_type: accountType,
    holder_name: holderName,
    transfer_types: ["ach_credit", "same_day_ach_credit"],
  });
  return { addressId: data.id };
}

/** Get the Brale custodial (internal) address for holding stablecoins */
export async function getCustodialAddress(accountId: string): Promise<{ addressId: string; address: string } | null> {
  const data = await braleRequest("GET", `/accounts/${accountId}/addresses?type=internal`);
  const addr = data.data?.[0];
  if (!addr) return null;
  return { addressId: addr.id, address: addr.address };
}

// ── Transfers ───────────────────────────────────────────

export interface TransferResult {
  id: string;
  status: "pending" | "processing" | "complete" | "canceled" | "failed";
  amount: { value: string; currency: string };
}

/** ACH Debit: Pull USD from bank → mint stablecoins to XION wallet */
export async function createOnrampTransfer(
  accountId: string,
  bankAddressId: string,
  walletAddressId: string,
  amountUsd: string,
  idempotencyKey: string,
): Promise<TransferResult> {
  const data = await braleRequest(
    "POST",
    `/accounts/${accountId}/transfers`,
    {
      amount: { value: amountUsd, currency: "USD" },
      source: {
        address_id: bankAddressId,
        value_type: "USD",
        transfer_type: "ach_debit",
      },
      destination: {
        address_id: walletAddressId,
        value_type: "SBC",
        transfer_type: BRALE_NETWORK,
      },
      brand: { account_id: accountId },
    },
    idempotencyKey,
  );

  logger.info("Onramp transfer created", { id: data.id, amount: amountUsd, status: data.status });
  return { id: data.id, status: data.status, amount: data.amount };
}

/** ACH Credit: Redeem stablecoins → send USD to bank */
export async function createOfframpTransfer(
  accountId: string,
  custodialAddressId: string,
  bankAddressId: string,
  amountUsd: string,
  idempotencyKey: string,
  sameDay: boolean = false,
): Promise<TransferResult> {
  const data = await braleRequest(
    "POST",
    `/accounts/${accountId}/transfers`,
    {
      amount: { value: amountUsd, currency: "USD" },
      source: {
        address_id: custodialAddressId,
        value_type: "SBC",
        transfer_type: BRALE_NETWORK,
      },
      destination: {
        address_id: bankAddressId,
        value_type: "USD",
        transfer_type: sameDay ? "same_day_ach_credit" : "ach_credit",
      },
    },
    idempotencyKey,
  );

  logger.info("Offramp transfer created", { id: data.id, amount: amountUsd, status: data.status, sameDay });
  return { id: data.id, status: data.status, amount: data.amount };
}

/** Check transfer status */
export async function getTransferStatus(accountId: string, transferId: string): Promise<TransferResult> {
  const data = await braleRequest("GET", `/accounts/${accountId}/transfers/${transferId}`);
  return { id: data.id, status: data.status, amount: data.amount };
}

// ── Config check ─────────────────────────────────────────

export function isBraleConfigured(): boolean {
  return !!(BRALE_API_KEY && BRALE_ACCOUNT_ID);
}
