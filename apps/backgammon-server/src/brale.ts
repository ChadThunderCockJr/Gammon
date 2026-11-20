import { logger } from "./logger.js";
import { fundsGate } from "./funds-config.js";

export type BraleTransferStatus =
  | "pending"
  | "processing"
  | "complete"
  | "canceled"
  | "failed"
  | "refunding"
  | "refunded";

export type BraleAccountStatus = "complete" | "pending" | "documents_required" | "rejected" | "archived";
export interface BraleTransferEndpoint {
  readonly addressId: string;
  readonly valueType: "USD" | "verUSD";
  readonly transferType: TransferEndpoint["transferType"];
}

export interface BraleTransfer {
  readonly id: string;
  readonly accountId: string;
  readonly status: BraleTransferStatus;
  readonly amount: { readonly value: string; readonly currency: "USD" };
  readonly source: BraleTransferEndpoint;
  readonly destination: BraleTransferEndpoint;
  readonly chainTxHash?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface PlaidIdentity {
  readonly legalName: string;
  readonly emailAddress: string;
  readonly phoneNumber?: string;
  readonly dateOfBirth?: string;
}

export interface IndividualAccountInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly email: string;
  readonly phoneNumber: string;
  readonly country: string;
  readonly address: {
    readonly streetLine1: string;
    readonly streetLine2?: string;
    readonly city: string;
    readonly state?: string;
    readonly postalCode: string;
  };
  readonly identity: { readonly number: string; readonly type: string };
  readonly termsVersion: string;
  readonly acceptedAt: string;
  readonly ip: string;
  readonly userAgent: string;
}

export interface TransferEndpoint {
  readonly addressId: string;
  readonly valueType: "USD" | "verUSD";
  readonly transferType:
    | "ach_debit"
    | "ach_credit"
    | "same_day_ach_credit"
    | "fednow_credit"
    | "verona"
    | "verona_testnet";
}

export class BraleApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  readonly retryable: boolean;

  constructor(status: number, providerCode: string | null) {
    super("Payment provider request failed");
    this.name = "BraleApiError";
    this.status = status;
    this.providerCode = providerCode;
    this.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
}

interface BraleClientOptions {
  readonly accountId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly authUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const KSUID = /^[A-Za-z0-9]{20,40}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,200}$/;
const TRANSFER_STATUSES: Record<BraleTransferStatus, true> = {
  pending: true,
  processing: true,
  complete: true,
  canceled: true,
  failed: true,
  refunding: true,
  refunded: true,
};

const TRANSFER_TYPES: Record<TransferEndpoint["transferType"], true> = {
  ach_debit: true,
  ach_credit: true,
  same_day_ach_credit: true,
  fednow_credit: true,
  verona: true,
  verona_testnet: true,
};

function requireHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.pathname.includes("//") ||
    parsed.search
  ) throw new TypeError(`Invalid ${label}`);
  return value.replace(/\/$/, "");
}

function requireResourceId(value: string, label: string): string {
  if (!KSUID.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function requireIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY.test(value)) throw new TypeError("Invalid idempotency key");
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Unexpected payment provider response");
  return value as Record<string, unknown>;
}

function providerCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record.type ?? record.code;
  return typeof candidate === "string" && candidate.length <= 100 ? candidate : null;
}

export class BraleClient {
  private readonly accountId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly authUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: BraleClientOptions) {
    this.accountId = requireResourceId(options.accountId, "Brale account ID");
    if (!options.apiKey || options.apiKey.trim() !== options.apiKey) throw new TypeError("Brale API key is required");
    this.apiKey = options.apiKey;
    this.baseUrl = requireHttpsUrl(options.baseUrl ?? "https://api.brale.xyz", "Brale API URL");
    this.authUrl = requireHttpsUrl(options.authUrl ?? "https://auth.brale.xyz/oauth2/token", "Brale OAuth URL");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get masterAccountId(): string {
    return this.accountId;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) return this.cachedToken;

    const credentials = Buffer.from(`${this.accountId}:${this.apiKey}`).toString("base64");
    const response = await this.fetchImpl(this.authUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      logger.warn("Brale OAuth request failed", { status: response.status, code: providerCode(body) });
      throw new BraleApiError(response.status, providerCode(body));
    }
    const parsed = objectValue(body);
    if (typeof parsed.access_token !== "string" || parsed.access_token.length < 16) {
      throw new TypeError("Unexpected payment provider token response");
    }
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3_600;
    this.cachedToken = parsed.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1_000;
    return parsed.access_token;
  }

  private async request(method: "GET" | "POST", path: string, body?: object, idempotencyKey?: string): Promise<unknown> {
    if (method === "POST" && !idempotencyKey) throw new TypeError("Every provider POST requires a durable idempotency key");
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = requireIdempotencyKey(idempotencyKey);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const responseBody: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }
      const code = providerCode(responseBody);
      logger.warn("Brale API request failed", { method, path, status: response.status, code });
      throw new BraleApiError(response.status, code);
    }
    return responseBody;
  }

  async getAccount(accountId: string = this.accountId): Promise<{
    id: string;
    status: BraleAccountStatus;
    programId: string;
    capabilities: readonly string[];
  }> {
    const scopedAccountId = requireResourceId(accountId, "Brale account ID");
    const response = objectValue(await this.request("GET", `/accounts/${scopedAccountId}`));
    if (
      response.id !== scopedAccountId ||
      !["complete", "pending", "documents_required", "rejected", "archived"].includes(String(response.status)) ||
      typeof response.program_id !== "string" ||
      response.program_id.length === 0 ||
      !Array.isArray(response.capabilities) ||
      response.capabilities.length === 0 ||
      response.capabilities.some((capability) => typeof capability !== "string" || capability.length === 0) ||
      new Set(response.capabilities).size !== response.capabilities.length
    ) {
      throw new TypeError("Unexpected payment provider account response");
    }
    return {
      id: scopedAccountId,
      status: response.status as BraleAccountStatus,
      programId: response.program_id,
      capabilities: response.capabilities,
    };
  }

  async createIndividualTransactionalAccount(input: IndividualAccountInput, idempotencyKey: string): Promise<{
    id: string;
    status: BraleAccountStatus;
  }> {
    const response = objectValue(await this.request(
      "POST",
      "/accounts",
      {
        entity_type: "individual",
        account_type: "transactional",
        verification_mode: "standard",
        individual: {
          first_name: input.firstName,
          last_name: input.lastName,
          date_of_birth: input.dateOfBirth,
          email: input.email,
          phone_number: input.phoneNumber,
          country: input.country,
          address: {
            street_line_1: input.address.streetLine1,
            ...(input.address.streetLine2 ? { street_line_2: input.address.streetLine2 } : {}),
            city: input.address.city,
            ...(input.address.state ? { state: input.address.state } : {}),
            zip: input.address.postalCode,
          },
          identity: input.identity,
        },
        tos_attestation: {
          version: input.termsVersion,
          accepted_at: input.acceptedAt,
          ip: input.ip,
          user_agent: input.userAgent,
        },
      },
      idempotencyKey,
    ));
    if (typeof response.id !== "string" || !["complete", "pending", "documents_required", "rejected", "archived"].includes(String(response.status))) {
      throw new TypeError("Unexpected payment provider account response");
    }
    return {
      id: requireResourceId(response.id, "managed account ID"),
      status: response.status as BraleAccountStatus,
    };
  }

  async createPlaidLinkToken(accountId: string, identity: PlaidIdentity, idempotencyKey: string): Promise<{
    linkToken: string;
    expiration: string;
    callbackUrl: string;
  }> {
    const response = objectValue(await this.request(
      "POST",
      `/accounts/${requireResourceId(accountId, "managed account ID")}/plaid/link_token`,
      {
        legal_name: identity.legalName,
        email_address: identity.emailAddress,
        ...(identity.phoneNumber ? { phone_number: identity.phoneNumber } : {}),
        ...(identity.dateOfBirth ? { date_of_birth: identity.dateOfBirth } : {}),
        client_name: "Gammon",
      },
      idempotencyKey,
    ));
    if (typeof response.link_token !== "string" || typeof response.expiration !== "string" || typeof response.callback_url !== "string") {
      throw new TypeError("Unexpected payment provider link response");
    }
    return {
      linkToken: response.link_token,
      expiration: response.expiration,
      callbackUrl: response.callback_url,
    };
  }

  async registerPlaidAccount(input: {
    accountId: string;
    publicToken: string;
    customerWebhookUrl: string;
    accountHolderType: "individual" | "business";
    idempotencyKey: string;
  }): Promise<{ addressId: string }> {
    const response = objectValue(await this.request(
      "POST",
      `/accounts/${requireResourceId(input.accountId, "managed account ID")}/plaid/register-account`,
      {
        public_token: input.publicToken,
        customer_webhook_url: input.customerWebhookUrl,
        transfer_types: ["ach_debit", "ach_credit"],
        account_holder_type: input.accountHolderType,
      },
      input.idempotencyKey,
    ));
    if (typeof response.address_id !== "string") throw new TypeError("Unexpected payment provider address response");
    return { addressId: requireResourceId(response.address_id, "bank address ID") };
  }

  async registerExternalWallet(input: {
    accountId: string;
    walletAddress: string;
    transferType: "verona" | "verona_testnet";
    idempotencyKey: string;
  }): Promise<{ addressId: string }> {
    if (!/^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/.test(input.walletAddress)) {
      throw new TypeError("Invalid Verona wallet address");
    }
    const response = objectValue(await this.request(
      "POST",
      `/accounts/${requireResourceId(input.accountId, "managed account ID")}/addresses/external`,
      {
        name: `Gammon wallet ${input.walletAddress.slice(0, 10)}`,
        address: input.walletAddress,
        transfer_types: [input.transferType],
      },
      input.idempotencyKey,
    ));
    if (
      typeof response.id !== "string" ||
      (response.address !== undefined && response.address !== input.walletAddress) ||
      (response.account_id !== undefined && response.account_id !== input.accountId)
    ) throw new TypeError("Unexpected payment provider address response");
    return { addressId: requireResourceId(response.id, "wallet address ID") };
  }

  async createInternalAddress(input: {
    name: string;
    transferType: "verona" | "verona_testnet";
    idempotencyKey: string;
  }): Promise<{ addressId: string; address: string }> {
    const response = objectValue(await this.request(
      "POST",
      `/accounts/${this.accountId}/addresses/internal`,
      { name: input.name, transfer_types: [input.transferType] },
      input.idempotencyKey,
    ));
    if (
      typeof response.id !== "string" ||
      typeof response.address !== "string" ||
      !/^xion1[023456789acdefghjklmnpqrstuvwxyz]{38,64}$/.test(response.address)
    ) {
      throw new TypeError("Unexpected payment provider internal address response");
    }
    return {
      addressId: requireResourceId(response.id, "internal address ID"),
      address: response.address,
    };
  }

  async getAddress(accountId: string, addressId: string): Promise<{ id: string; status: "active" | "pending" | "documents_required" | "relink_required" | "disabled" | "rejected" | "archived" }> {
    const scopedAccountId = requireResourceId(accountId, "managed account ID");
    const scopedAddressId = requireResourceId(addressId, "provider address ID");
    const response = objectValue(await this.request("GET", `/accounts/${scopedAccountId}/addresses/${scopedAddressId}`));
    if (
      response.id !== scopedAddressId ||
      !["active", "pending", "documents_required", "relink_required", "disabled", "rejected", "archived"].includes(String(response.status))
    ) throw new TypeError("Unexpected payment provider address response");
    return {
      id: scopedAddressId,
      status: response.status as "active" | "pending" | "documents_required" | "relink_required" | "disabled" | "rejected" | "archived",
    };
  }

  async createTransfer(input: {
    amountUsd: string;
    source: TransferEndpoint;
    destination: TransferEndpoint;
    idempotencyKey: string;
    brandAccountId?: string;
  }): Promise<BraleTransfer> {
    const response = objectValue(await this.request(
      "POST",
      `/accounts/${this.accountId}/transfers`,
      {
        amount: { value: input.amountUsd, currency: "USD" },
        source: {
          address_id: requireResourceId(input.source.addressId, "source address ID"),
          value_type: input.source.valueType,
          transfer_type: input.source.transferType,
        },
        destination: {
          address_id: requireResourceId(input.destination.addressId, "destination address ID"),
          value_type: input.destination.valueType,
          transfer_type: input.destination.transferType,
        },
        brand: { account_id: requireResourceId(input.brandAccountId ?? this.accountId, "brand account ID") },
      },
      input.idempotencyKey,
    ));
    return this.parseTransfer(response);
  }

  async getTransfer(transferId: string): Promise<BraleTransfer> {
    const response = objectValue(await this.request(
      "GET",
      `/accounts/${this.accountId}/transfers/${requireResourceId(transferId, "transfer ID")}`,
    ));
    return this.parseTransfer(response);
  }

  private parseTransferEndpoint(value: unknown, label: string): BraleTransferEndpoint {
    const endpoint = objectValue(value);
    if (
      typeof endpoint.address_id !== "string" ||
      (endpoint.value_type !== "USD" && endpoint.value_type !== "verUSD") ||
      typeof endpoint.transfer_type !== "string" ||
      !Object.hasOwn(TRANSFER_TYPES, endpoint.transfer_type)
    ) {
      throw new TypeError(`Unexpected payment provider ${label} transfer endpoint`);
    }
    return {
      addressId: requireResourceId(endpoint.address_id, `${label} address ID`),
      valueType: endpoint.value_type,
      transferType: endpoint.transfer_type as TransferEndpoint["transferType"],
    };
  }

  private parseTransfer(response: Record<string, unknown>): BraleTransfer {
    if (
      typeof response.id !== "string" ||
      typeof response.account_id !== "string" ||
      typeof response.status !== "string" ||
      !Object.hasOwn(TRANSFER_STATUSES, response.status)
    ) {
      throw new TypeError("Unexpected payment provider transfer response");
    }
    const amount = objectValue(response.amount);
    if (typeof amount.value !== "string" || amount.currency !== "USD") {
      throw new TypeError("Unexpected payment provider amount response");
    }
    const transactionHash = response.transaction_hash ?? response.tx_hash;
    if (
      (response.transaction_hash !== undefined && response.tx_hash !== undefined && response.transaction_hash !== response.tx_hash) ||
      (transactionHash !== undefined && (typeof transactionHash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(transactionHash)))
    ) {
      throw new TypeError("Unexpected payment provider chain transaction response");
    }
    return {
      id: requireResourceId(response.id, "transfer ID"),
      accountId: requireResourceId(response.account_id, "transfer account ID"),
      status: response.status as BraleTransferStatus,
      amount: { value: amount.value, currency: "USD" },
      source: this.parseTransferEndpoint(response.source, "source"),
      destination: this.parseTransferEndpoint(response.destination, "destination"),
      ...(transactionHash ? { chainTxHash: transactionHash.toUpperCase() } : {}),
      ...(typeof response.created_at === "string" ? { createdAt: response.created_at } : {}),
      ...(typeof response.updated_at === "string" ? { updatedAt: response.updated_at } : {}),
    };
  }
}

export function createConfiguredBraleClient(): BraleClient | null {
  const accountId = process.env.BRALE_ACCOUNT_ID;
  const apiKey = process.env.BRALE_API_KEY;
  if (!accountId || !apiKey || accountId.trim() !== accountId || apiKey.trim() !== apiKey) return null;
  if (fundsGate.config.mode === "verusd_production" && (fundsGate.config.providerIdentityBlockers?.length ?? 0) > 0) {
    return null;
  }
  return new BraleClient({
    accountId,
    apiKey,
    baseUrl: process.env.BRALE_API_URL,
    authUrl: process.env.BRALE_AUTH_URL,
  });
}
