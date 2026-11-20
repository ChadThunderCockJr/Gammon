import { Secp256k1 } from "@cosmjs/crypto";

const sandboxAuthorizationPrivateKey = Buffer.alloc(32, 11);

export function sandboxCashOutAuthorizationEnvironment(): Record<string, string> {
  const publicKey = Buffer.from(
    Secp256k1.compressPubkey(Secp256k1.makeKeypair(sandboxAuthorizationPrivateKey).pubkey),
  ).toString("hex");
  return {
    FINANCE_AUTHORIZATION_CONTRACT: `xion1${"q".repeat(38)}`,
    FINANCE_AUTHORIZATION_MESSAGE_KEY: "authorize_finance_action",
    FINANCE_AUTHORIZATION_CODE_CHECKSUM: "c".repeat(64),
    FINANCE_AUTHORIZATION_ADMIN: `xion1${"r".repeat(38)}`,
    FINANCE_AUTHORIZATION_MAX_TRANSFER_MICRO_USD: "1000000000",
    CASH_OUT_AUTHORIZATION_PRIVATE_KEY: sandboxAuthorizationPrivateKey.toString("base64"),
    CASH_OUT_AUTHORIZATION_PUBLIC_KEY: publicKey,
  };
}

export interface SandboxCashOutOperation {
  readonly id: string;
  readonly kind: "cash_out";
  readonly state: "awaiting_user" | "queued" | "processing" | "pending" | "complete";
  readonly amountMicroUsd: string;
  readonly chainTxHash: string | null;
}

export interface SandboxCashOutFundingInstruction {
  readonly from: string;
  readonly to: string;
  readonly denom: string;
  readonly amountMicroUsd: string;
  readonly contract: string;
  readonly messageKey: "authorize_finance_action";
  readonly operationId: string;
  readonly destination: string;
  readonly expiresAt: number;
  readonly signature: string;
}

export interface SandboxCashOutConsentFactory {
  (purpose: "cash_out", reviewedContext: Record<string, unknown>): Record<string, unknown>;
}

export interface CreateSandboxCashOutInput {
  readonly baseUrl: string;
  readonly amount: string;
  readonly paymentMethodId: string;
  readonly destination: string;
  readonly headers: Record<string, string>;
  readonly consent: SandboxCashOutConsentFactory;
}

export interface ConfirmSandboxCashOutInput {
  readonly baseUrl: string;
  readonly operationId: string;
  readonly txHash: string;
  readonly headers: Record<string, string>;
}

export interface SandboxFinanceWorker {
  runOnce(): Promise<boolean>;
  stop(): void;
}

export interface CompleteSandboxCashOutInput {
  readonly baseUrl: string;
  readonly operationId: string;
  readonly headers: Record<string, string>;
  readonly startFinanceWorker: () => SandboxFinanceWorker | null;
}

export interface SandboxCashOutCreation {
  readonly operationId: string;
  readonly operation: SandboxCashOutOperation;
  readonly fundingInstruction: SandboxCashOutFundingInstruction;
}

function microUsd(amount: string): string {
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(amount)) {
    throw new TypeError("Sandbox cash-out amount must use whole-cent precision");
  }
  const [whole, cents = ""] = amount.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(cents.padEnd(2, "0")) * 10_000n).toString();
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function requestHeaders(headers: Record<string, string>): Headers {
  const result = new Headers(headers);
  if (!result.has("content-type")) result.set("content-type", "application/json");
  return result;
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function operation(value: unknown, expectedState: SandboxCashOutOperation["state"]): SandboxCashOutOperation {
  const parsed = record(value, "Sandbox cash-out response is malformed");
  if (
    typeof parsed.id !== "string" ||
    parsed.kind !== "cash_out" ||
    parsed.state !== expectedState ||
    typeof parsed.amountMicroUsd !== "string" ||
    (parsed.chainTxHash !== null && typeof parsed.chainTxHash !== "string")
  ) throw new Error("Sandbox cash-out operation is malformed");
  return parsed as unknown as SandboxCashOutOperation;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return record(await response.json(), "Sandbox cash-out response is not JSON");
}

export async function createSandboxCashOut(input: CreateSandboxCashOutInput): Promise<SandboxCashOutCreation> {
  const amountMicroUsd = microUsd(input.amount);
  const reviewedContext = {
    amountMicroUsd,
    paymentMethodId: input.paymentMethodId,
    destination: input.destination,
  };
  const response = await fetch(endpoint(input.baseUrl, "/api/funds/cash-outs"), {
    method: "POST",
    headers: requestHeaders(input.headers),
    body: JSON.stringify({
      amount: input.amount,
      paymentMethodId: input.paymentMethodId,
      consent: input.consent("cash_out", reviewedContext),
    }),
  });
  const body = await responseBody(response);
  if (response.status !== 201) throw new Error(`Sandbox cash-out creation HTTP ${response.status}: ${JSON.stringify(body)}`);
  const created = operation(body.operation, "awaiting_user");
  if (created.amountMicroUsd !== amountMicroUsd) throw new Error("Sandbox cash-out amount differs from requested amount");
  const instruction = record(body.fundingInstruction, "Sandbox cash-out funding instruction is missing");
  if (
    instruction.operationId !== created.id ||
    typeof instruction.from !== "string" ||
    typeof instruction.to !== "string" ||
    typeof instruction.denom !== "string" ||
    instruction.amountMicroUsd !== amountMicroUsd ||
    typeof instruction.contract !== "string" ||
    instruction.messageKey !== "authorize_finance_action" ||
    typeof instruction.destination !== "string" ||
    typeof instruction.expiresAt !== "number" ||
    typeof instruction.signature !== "string"
  ) throw new Error("Sandbox cash-out funding instruction is malformed");
  return {
    operationId: created.id,
    operation: created,
    fundingInstruction: instruction as unknown as SandboxCashOutFundingInstruction,
  };
}

export async function confirmSandboxCashOut(input: ConfirmSandboxCashOutInput): Promise<SandboxCashOutOperation> {
  if (!/^[0-9a-f]{64}$/i.test(input.txHash)) throw new TypeError("Sandbox cash-out transaction hash is invalid");
  const response = await fetch(endpoint(input.baseUrl, `/api/funds/cash-outs/${input.operationId}/confirm-transfer`), {
    method: "POST",
    headers: requestHeaders(input.headers),
    body: JSON.stringify({ txHash: input.txHash }),
  });
  const body = await responseBody(response);
  if (response.status !== 202) throw new Error(`Sandbox cash-out confirmation failed with HTTP ${response.status}`);
  const confirmed = operation(body.operation, "queued");
  if (confirmed.id !== input.operationId || confirmed.chainTxHash?.toLowerCase() !== input.txHash.toLowerCase()) {
    throw new Error("Sandbox cash-out confirmation does not match the submitted transaction");
  }
  return confirmed;
}

export async function completeSandboxCashOut(input: CompleteSandboxCashOutInput): Promise<SandboxCashOutOperation> {
  const worker = input.startFinanceWorker();
  if (!worker) throw new Error("Sandbox finance worker is unavailable");
  try {
    if (!await worker.runOnce()) throw new Error("Sandbox finance worker did not claim the cash-out");
  } finally {
    worker.stop();
  }
  const response = await fetch(endpoint(input.baseUrl, `/api/funds/operations/${input.operationId}`), {
    headers: input.headers,
  });
  const body = await responseBody(response);
  if (response.status !== 200) throw new Error(`Sandbox cash-out receipt failed with HTTP ${response.status}`);
  const completed = operation(body.operation, "complete");
  if (completed.id !== input.operationId) throw new Error("Sandbox cash-out receipt does not match the operation");
  return completed;
}

export interface SandboxCashOutChainAsset {
  readonly restUrl: string;
  readonly chainId: string;
  readonly genesisHash: string;
  readonly denom: string;
  readonly transactionHeight?: number;
  readonly latestHeight?: number;
}

export interface SandboxCashOutFundingTransaction {
  readonly fundingInstruction: SandboxCashOutFundingInstruction;
}

export interface SandboxCashOutChainHandlerInput {
  readonly asset: SandboxCashOutChainAsset;
  readonly balances: ReadonlyMap<string, bigint>;
  readonly transactions: ReadonlyMap<string, SandboxCashOutFundingTransaction>;
}

export type SandboxCashOutChainFetchHandler = (input: string | URL | Request) => Response | undefined;



export function createSandboxCashOutChainFetchHandler(
  input: SandboxCashOutChainHandlerInput,
): SandboxCashOutChainFetchHandler {
  const restUrl = new URL(input.asset.restUrl);
  const transactionHeight = input.asset.transactionHeight ?? 10;
  const latestHeight = input.asset.latestHeight ?? transactionHeight + 2;
  if (!Number.isSafeInteger(transactionHeight) || !Number.isSafeInteger(latestHeight) || latestHeight < transactionHeight) {
    throw new TypeError("Sandbox chain heights are invalid");
  }
  return (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    if (url.origin !== restUrl.origin) return undefined;
    const basePath = restUrl.pathname.replace(/\/$/, "");
    if (!url.pathname.startsWith(basePath)) return undefined;
    const path = url.pathname.slice(basePath.length) || "/";
    if (path === "/cosmos/base/tendermint/v1beta1/node_info") {
      return Response.json({ default_node_info: { network: input.asset.chainId } });
    }
    if (path === "/cosmos/base/tendermint/v1beta1/blocks/1") {
      return Response.json({ block_id: { hash: input.asset.genesisHash } });
    }
    if (path === "/cosmos/base/tendermint/v1beta1/blocks/latest") {
      return Response.json({ block: { header: { height: String(latestHeight) } } });
    }
    const balance = /^\/cosmos\/bank\/v1beta1\/balances\/([^/]+)\/by_denom$/.exec(path);
    if (balance) {
      const principal = decodeURIComponent(balance[1]);
      if (url.searchParams.get("denom") !== input.asset.denom) {
        return Response.json({ error: "unexpected denomination" }, { status: 400 });
      }
      return Response.json({ balance: { denom: input.asset.denom, amount: (input.balances.get(principal) ?? 0n).toString() } });
    }
    const transaction = /^\/cosmos\/tx\/v1beta1\/txs\/([0-9a-f]{64})$/i.exec(path);
    if (transaction) {
      const txHash = transaction[1].toUpperCase();
      const funding = input.transactions.get(txHash)?.fundingInstruction;
      if (!funding) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        tx_response: { code: 0, height: String(transactionHeight), txhash: txHash },
        tx: { body: { messages: [{
          "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
          sender: funding.from,
          contract: funding.contract,
          funds: [{ denom: funding.denom, amount: funding.amountMicroUsd }],
          msg: {
            [funding.messageKey]: {
              operation_id: funding.operationId,
              destination: funding.destination,
              expires_at: funding.expiresAt,
              signature: funding.signature,
            },
          },
        }] } },
      });
    }
    throw new Error(`Unexpected sandbox cash-out chain request: ${url}`);
  };
}

export function recordSandboxCashOutFundingTransaction(input: {
  readonly balances: Map<string, bigint>;
  readonly transactions: Map<string, SandboxCashOutFundingTransaction>;
  readonly txHash: string;
  readonly fundingInstruction: SandboxCashOutFundingInstruction;
}): void {
  if (!/^[0-9a-f]{64}$/i.test(input.txHash)) throw new TypeError("Sandbox cash-out transaction hash is invalid");
  const txHash = input.txHash.toUpperCase();
  if (input.transactions.has(txHash)) throw new Error("Sandbox cash-out transaction is already recorded");
  const amount = BigInt(input.fundingInstruction.amountMicroUsd);
  if (amount <= 0n) throw new TypeError("Sandbox cash-out amount is invalid");
  const available = input.balances.get(input.fundingInstruction.from) ?? 0n;
  if (available < amount) throw new RangeError("Sandbox cash-out funding exceeds observed balance");
  input.balances.set(input.fundingInstruction.from, available - amount);
  input.balances.set(
    input.fundingInstruction.to,
    (input.balances.get(input.fundingInstruction.to) ?? 0n) + amount,
  );
  input.transactions.set(txHash, { fundingInstruction: input.fundingInstruction });
}
