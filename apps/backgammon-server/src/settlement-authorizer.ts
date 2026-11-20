import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./finance-crypto.js";
import { fundsGate } from "./funds-config.js";

export interface AuthorizerResult {
  readonly txHash: string;
  readonly requestHash: string;
  readonly signingKeyId: string;
  readonly contract: string;
}

export class SettlementAuthorizerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly contract: string,
    private readonly publicKey: string,
    private readonly signingKeyId: string,
  ) {}

  private async submit(path: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<AuthorizerResult> {
    const canonicalPayload = canonicalJson(payload);
    const requestHash = createHash("sha256").update(canonicalPayload).digest("hex");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-request-sha256": requestHash,
      },
      body: canonicalPayload,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new SettlementAuthorizerError(response.status, retryable);
    }
    const result = await response.json() as unknown;
    if (!result || typeof result !== "object" || !("txHash" in result) || typeof result.txHash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(result.txHash)) {
      throw new SettlementAuthorizerError(502, false);
    }
    const txHash = result.txHash.toUpperCase();
    const signingKeyId = response.headers.get("x-signing-key-id") ?? "";
    if (signingKeyId !== this.signingKeyId) throw new SettlementAuthorizerError(502, false);
    const signature = response.headers.get("x-response-signature-ed25519") ?? "";
    const signedPayload = canonicalJson({ contract: this.contract, requestHash, signingKeyId, txHash });
    let signatureValid = false;
    try {
      const key = this.publicKey.includes("BEGIN PUBLIC KEY")
        ? createPublicKey(this.publicKey)
        : createPublicKey({ key: Buffer.from(this.publicKey, "base64"), format: "der", type: "spki" });
      signatureValid = verify(null, Buffer.from(signedPayload), key, Buffer.from(signature, "base64url"));
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) throw new SettlementAuthorizerError(502, false);
    return { txHash, requestHash, signingKeyId, contract: this.contract };
  }

  createGame(input: {
    readonly gameId: string;
    readonly playerA: string;
    readonly playerB: string;
    readonly stakeMicroUsd: string;
    readonly quoteHash: string;
  }, idempotencyKey: string): Promise<AuthorizerResult> {
    return this.submit("/v1/escrow/games", { contract: this.contract, ...input }, idempotencyKey);
  }

  settleGame(input: {
    readonly gameId: string;
    readonly winner: string;
    readonly resultMultiplier: 1 | 2 | 3;
    readonly cubeValue: 1 | 2 | 4 | 8;
    readonly cubeWasTurned: boolean;
    readonly settlementId: string;
  }, idempotencyKey: string): Promise<AuthorizerResult> {
    return this.submit("/v1/escrow/settlements", { contract: this.contract, ...input }, idempotencyKey);
  }

  refundGame(input: {
    readonly gameId: string;
    readonly refundId: string;
    readonly reason: string;
  }, idempotencyKey: string): Promise<AuthorizerResult> {
    return this.submit("/v1/escrow/refunds", { contract: this.contract, ...input }, idempotencyKey);
  }
}

export class SettlementAuthorizerError extends Error {
  constructor(readonly status: number, readonly retryable: boolean) {
    super(`settlement_authorizer_http_${status}`);
    this.name = "SettlementAuthorizerError";
  }
}

export function configuredSettlementAuthorizer(): SettlementAuthorizerClient | null {
  const tuple = fundsGate.config.settlementAuthorizer;
  if (!tuple) return null;
  return new SettlementAuthorizerClient(
    tuple.baseUrl,
    tuple.apiKey,
    tuple.contract,
    tuple.publicKey,
    tuple.signingKeyId,
  );
}
