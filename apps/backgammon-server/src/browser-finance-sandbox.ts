import { createHash, createPrivateKey, sign } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import express, { type Express, type Request as ExpressRequest } from "express";
import cors from "cors";
import {
  createFinanceStepUpChallenge,
  createSessionChallenge,
  requireCsrf,
  requireSession,
  verifySessionChallenge,
} from "./session.js";
import { financeRouter } from "./finance-router.js";
import { fundsGate } from "./funds-config.js";
import { startFinanceReconciliationScheduler, startFinanceWorker } from "./finance-worker.js";
import { canonicalJson } from "./finance-crypto.js";
import { quoteForGame } from "./cash-game-store.js";
import { recoverBrowserSandboxCashQuoteRefund } from "./browser-sandbox-refund.js";
import { attachBrowserSandboxGameplay } from "./browser-sandbox-gameplay.js";
import { cashGameRouter, publicCashGameConfig } from "./cash-game-router.js";
import {
  installBrowserCashGameFixture,
  type BrowserCashGameFixture,
  type EscrowReserveVerification,
  type EscrowGame,
} from "./cash-game-chain.js";

const SANDBOX_ORIGIN = "http://127.0.0.1:3421";
const CHAIN_ORIGIN = "https://chain.browser-sandbox.invalid";
const BRALE_ORIGIN = "https://brale.browser-sandbox.invalid";
const AUTH_ORIGIN = "https://auth.browser-sandbox.invalid";
const CHAIN_ID = "xion-testnet-2";
const GENESIS_HASH = "a".repeat(64);
const ESCROW_CONTRACT = "xion1767l3dc579pfeegsy0mcgrjrpu5u8m4sh0cfyu";
const FINANCE_CONTRACT = "xion1vsrxv6uay8urlrx6ajhqqwg4xs52scx036c8kf";
const DENOM = `factory/${ESCROW_CONTRACT}/verusd`;
const INTERNAL_WALLET = "xion1an5dp8qdayxfs4wtflhzaesjlxp3mq38m5qezx";

interface ChainTransaction {
  readonly hash: string;
  readonly height: number;
  readonly messages: readonly Record<string, unknown>[];
}

interface ProviderAddress {
  readonly id: string;
  readonly address: string;
  readonly status: "active";
}

interface ProviderTransfer {
  readonly id: string;
  readonly accountId: string;
  readonly status: "complete";
  readonly amount: { readonly value: string; readonly currency: "USD" };
  readonly source: Record<string, unknown>;
  readonly destination: Record<string, unknown>;
  readonly transactionHash?: string;
}

function moneyMicro(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
}

function sandboxId(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(20 - prefix.length, "0")}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** External provider and chain fixture. It is available only through the browser sandbox launcher. */
class BrowserSandboxFixture {
  private sequence = 0;
  private height = 100;
  private readonly addresses = new Map<string, ProviderAddress>();
  private readonly transfers = new Map<string, ProviderTransfer>();
  private readonly transferKeys = new Map<string, ProviderTransfer>();
  private readonly cashOutOperations = new Set<string>();
  private readonly transactions = new Map<string, ChainTransaction>();

  private readonly balances = new Map<string, bigint>();

  private readonly authorizerResults = new Map<string, { hash: string; txHash: string }>();
  readonly escrowGames = new Map<string, EscrowGame>();
  private readonly lockedReserves = new Map<string, Map<string, { amount: bigint; txHash: string }>>();

  private nextId(prefix: string): string {
    this.sequence += 1;
    return sandboxId(prefix, this.sequence);
  }

  private transaction(messages: readonly Record<string, unknown>[]): string {
    const hash = createHash("sha256").update(`${this.sequence}:${JSON.stringify(messages)}`).digest("hex").toUpperCase();
    this.height += 1;
    this.transactions.set(hash, { hash, height: this.height, messages });
    return hash;
  }

  executeChain(sender: string, contract: string, message: unknown, funds: unknown): string {
    const msg = object(message);
    if (!sender || !contract || Object.keys(msg).length === 0 || !Array.isArray(funds)) throw new TypeError("Invalid sandbox chain execution");
    if (contract === ESCROW_CONTRACT && msg.deposit_reserve) {
      const gameId = String(object(msg.deposit_reserve).game_id);
      const game = this.escrowGames.get(gameId);
      const coin = object(funds[0]);
      if (!game || game.status !== "awaiting_reserves" || ![game.player_a, game.player_b].includes(sender) ||
          funds.length !== 1 || coin.denom !== DENOM || coin.amount !== game.reserve_per_player ||
          Date.now() >= game.funding_deadline * 1_000) throw new Error("Invalid sandbox reserve");
      const reserves = this.lockedReserves.get(gameId) ?? new Map();
      if (reserves.has(sender)) throw new Error("Sandbox reserve already funded");
      const amount = BigInt(game.reserve_per_player);
      const balance = this.balances.get(sender) ?? 0n;
      if (balance < amount) throw new Error("Insufficient sandbox funds");
      const txHash = this.transaction([{
        "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender, contract,
        msg: Buffer.from(JSON.stringify(msg)).toString("base64"), funds,
      }]);
      this.balances.set(sender, balance - amount);
      reserves.set(sender, { amount, txHash });
      this.lockedReserves.set(gameId, reserves);
      return txHash;
    }
    if (contract === FINANCE_CONTRACT && msg.authorize_finance_action) {
      const authorization = object(msg.authorize_finance_action);
      const operationId = authorization.operation_id;
      if (typeof operationId !== "string" || !operationId || this.cashOutOperations.has(operationId)) {
        throw new Error("Invalid or replayed sandbox cash-out");
      }
      const coin = object(funds[0]);
      if (authorization.destination !== INTERNAL_WALLET || funds.length !== 1 || coin.denom !== DENOM ||
          typeof coin.amount !== "string" || !/^[1-9]\d*$/.test(coin.amount)) throw new Error("Invalid sandbox cash-out");
      const amount = BigInt(coin.amount);
      const balance = this.balances.get(sender) ?? 0n;
      if (balance < amount) throw new Error("Insufficient sandbox funds");
      this.balances.set(sender, balance - amount);
      this.balances.set(INTERNAL_WALLET, (this.balances.get(INTERNAL_WALLET) ?? 0n) + amount);
      this.cashOutOperations.add(operationId);
    }
    return this.transaction([{
      "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
      sender,
      contract,
      msg: Buffer.from(JSON.stringify(msg)).toString("base64"),
      funds,
    }]);
  }

  async settleEscrow(input: {
    readonly terminal: "settlement" | "refund";
    readonly principal: string;
    readonly opponent: string;
    readonly winner?: string;
    readonly stakePerPointMicroUsd: string;
    readonly cubeCap: number;
    readonly rakeBps: number;
    readonly gameId?: string;
    readonly cubeValue?: number;
    readonly resultMultiplier?: number;
    readonly cubeWasTurned?: boolean;
  }): Promise<Record<string, unknown>> {
    // The bridge lives with the external cw-multi-test fixture and invokes the real escrow contract.
    const { runSandboxEscrow } = await import("./__tests__/sandbox-escrow.js");
    // MultiTest starts before funding; reconstruct opening balances on a copy.
    const reserves = input.gameId ? this.lockedReserves.get(input.gameId) : undefined;
    if (input.gameId && reserves?.size !== 2) throw new Error("Sandbox escrow reserves missing");
    const balances = new Map(this.balances);
    for (const [player, reserve] of reserves ?? []) {
      balances.set(player, (balances.get(player) ?? 0n) + reserve.amount);
    }
    const common = {
      balances,
      principal: input.principal,
      opponent: input.opponent,
      denom: DENOM,
      stakePerPointMicroUsd: BigInt(input.stakePerPointMicroUsd),
      cubeCap: input.cubeCap,
      rakeBps: input.rakeBps,
    };
    const outcome = input.terminal === "settlement"
      ? runSandboxEscrow({
        ...common,
        terminal: "settlement",
        winner: input.winner ?? input.principal,
        cubeValue: input.cubeValue ?? 1,
        resultMultiplier: input.resultMultiplier ?? 1,
        cubeWasTurned: input.cubeWasTurned ?? false,
      })
      : runSandboxEscrow({ ...common, terminal: "refund" });
    for (const [address, balance] of balances) this.balances.set(address, balance);
    if (input.gameId) this.lockedReserves.delete(input.gameId);
    return JSON.parse(JSON.stringify(outcome, (_key, value) => typeof value === "bigint" ? value.toString() : value)) as Record<string, unknown>;
  }

  async verifyReserve(input: Parameters<BrowserCashGameFixture["verifyReserve"]>[0]): Promise<EscrowReserveVerification> {
    const transaction = this.transactions.get(input.txHash.toUpperCase());
    const message = transaction?.messages[0];
    if (
      !transaction
      || !message
      || message["@type"] !== "/cosmwasm.wasm.v1.MsgExecuteContract"
      || message.sender !== input.principal
      || message.contract !== input.snapshot.escrowContract
      || !Array.isArray(message.funds)
      || message.funds.length !== 1
      || object(message.funds[0]).denom !== input.snapshot.denom
      || object(message.funds[0]).amount !== input.expectedAmountMicroUsd
    ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
    const encodedMessage = typeof message.msg === "string" ? message.msg : "";
    const decoded = object(JSON.parse(Buffer.from(encodedMessage, "base64").toString("utf8")));
    if (this.lockedReserves.get(input.gameId)?.get(input.principal)?.txHash !== input.txHash.toUpperCase()) {
      throw new Error("CHAIN_TRANSACTION_MISMATCH");
    }
    if (object(decoded.deposit_reserve).game_id !== input.gameId) throw new Error("CHAIN_TRANSACTION_MISMATCH");
    const { quoteForGame } = await import("./cash-game-store.js");
    const quote = await quoteForGame(input.gameId);
    if (!quote || (quote.playerA !== input.principal && quote.playerB !== input.principal)) {
      throw new Error("ESCROW_STATE_MISMATCH");
    }
    const game = this.escrowGames.get(input.gameId);
    if (!game || (game.status !== "active" && game.status !== "awaiting_reserves")) throw new Error("ESCROW_STATE_MISMATCH");
    const playerA = game.player_a_deposited || quote.playerA === input.principal;
    const playerB = game.player_b_deposited || quote.playerB === input.principal;
    const escrow: EscrowGame = {
      ...game, player_a_deposited: playerA, player_b_deposited: playerB,
      status: playerA && playerB ? "active" : "awaiting_reserves",
    };
    this.escrowGames.set(input.gameId, escrow);
    return { height: transaction.height, blockHash: transaction.hash.toLowerCase(), escrow };
  }

  private async provider(request: globalThis.Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/oauth2/token" && request.method === "POST") {
      return Response.json({ access_token: "sandbox-access-token-0001", expires_in: 3600 });
    }
    const body = request.method === "GET" ? {} : object(await request.json().catch(() => null));
    if (path === "/accounts" && request.method === "POST") {
      const id = this.nextId("sandboxaccount");
      return Response.json({ id, status: "complete" });
    }
    const accountMatch = path.match(/^\/accounts\/([A-Za-z0-9]{20,40})(.*)$/);
    if (!accountMatch) return Response.json({ code: "not_found" }, { status: 404 });
    const [, accountId, suffix] = accountMatch;
    if (suffix === "" && request.method === "GET") {
      return Response.json({ id: accountId, status: "complete", program_id: "sandbox-program", capabilities: ["sandbox-capability"] });
    }
    if (suffix === "/plaid/link_token" && request.method === "POST") {
      return Response.json({
        link_token: `sandbox-link-${this.nextId("token")}`,
        expiration: "2099-01-01T01:00:00.000Z",
        callback_url: `${SANDBOX_ORIGIN}/wallet`,
      });
    }
    if (suffix === "/plaid/register-account" && request.method === "POST") {
      const id = this.nextId("sandboxbank");
      this.addresses.set(id, { id, address: "sandbox-bank", status: "active" });
      const { queueProviderResourceReconciliation } = await import("./finance-store.js");
      await queueProviderResourceReconciliation({ resourceType: "address", resourceId: id, parentAccountId: accountId });
      return Response.json({ address_id: id });
    }
    if (suffix === "/addresses/external" && request.method === "POST") {
      const id = this.nextId("sandboxwallet");
      const address = typeof body.address === "string" ? body.address : "";
      this.addresses.set(id, { id, address, status: "active" });
      return Response.json({ id, address, account_id: accountId });
    }
    if (suffix === "/addresses/internal" && request.method === "POST") {
      const id = this.nextId("sandboxinternal");
      this.addresses.set(id, { id, address: INTERNAL_WALLET, status: "active" });
      return Response.json({ id, address: INTERNAL_WALLET });
    }
    const addressMatch = suffix.match(/^\/addresses\/([A-Za-z0-9]{20,40})$/);
    if (addressMatch && request.method === "GET") {
      const address = this.addresses.get(addressMatch[1]);
      return address ? Response.json({ id: address.id, status: address.status }) : Response.json({ code: "not_found" }, { status: 404 });
    }
    if (suffix === "/transfers" && request.method === "POST") {
      const key = request.headers.get("idempotency-key");
      if (!key) return Response.json({ code: "idempotency_required" }, { status: 400 });
      const previous = this.transferKeys.get(key);
      if (previous) return Response.json(this.providerTransfer(previous));
      const source = object(body.source);
      const destination = object(body.destination);
      const amount = object(body.amount);
      const amountUsd = typeof amount.value === "string" ? amount.value : "";
      const destinationId = typeof destination.address_id === "string" ? destination.address_id : "";
      const transfer = {
        id: this.nextId("sandboxtransfer"), accountId: typeof object(body.brand).account_id === "string" ? object(body.brand).account_id as string : accountId,
        status: "complete" as const,
        amount: { value: amountUsd, currency: "USD" as const }, source, destination,
      };
      if (destination.transfer_type === "verona_testnet") {
        const destinationWallet = this.addresses.get(destinationId)?.address;
        if (!destinationWallet || !amountUsd) return Response.json({ code: "invalid_transfer" }, { status: 400 });
        const transactionHash = this.transaction([{
          "@type": "/cosmos.bank.v1beta1.MsgSend", to_address: destinationWallet,
          amount: [{ denom: DENOM, amount: moneyMicro(amountUsd) }],
        }]);
        this.balances.set(destinationWallet, (this.balances.get(destinationWallet) ?? 0n) + BigInt(moneyMicro(amountUsd)));
        const completed = { ...transfer, transactionHash };
        this.transfers.set(completed.id, completed);
        this.transferKeys.set(key, completed);
        return Response.json(this.providerTransfer(completed));
      }
      if (destination.transfer_type === "ach_credit") {
        const amountMicro = BigInt(moneyMicro(amountUsd));
        const custody = this.balances.get(INTERNAL_WALLET) ?? 0n;
        if (amountMicro <= 0n || custody < amountMicro) return Response.json({ code: "unfunded_transfer" }, { status: 400 });
        this.balances.set(INTERNAL_WALLET, custody - amountMicro);
      }
      this.transfers.set(transfer.id, transfer);
      this.transferKeys.set(key, transfer);
      return Response.json(this.providerTransfer(transfer));
    }
    const transferMatch = suffix.match(/^\/transfers\/([A-Za-z0-9]{20,40})$/);
    if (transferMatch && request.method === "GET") {
      const transfer = this.transfers.get(transferMatch[1]);
      return transfer ? Response.json(this.providerTransfer(transfer)) : Response.json({ code: "not_found" }, { status: 404 });
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  private providerTransfer(transfer: ProviderTransfer): Record<string, unknown> {
    return {
      id: transfer.id, account_id: transfer.accountId, status: transfer.status, amount: transfer.amount,
      source: transfer.source, destination: transfer.destination,
      ...(transfer.transactionHash ? { transaction_hash: transfer.transactionHash } : {}),
    };
  }

  private chain(url: URL): Response {
    const path = url.pathname;
    if (path.endsWith("/node_info")) return Response.json({ default_node_info: { network: CHAIN_ID } });
    if (path === "/block" && url.searchParams.get("height") === "1") {
      return Response.json({ result: {
        block: { header: { height: "1", chain_id: CHAIN_ID } }, block_id: { hash: GENESIS_HASH },
      } });
    }
    const block = path.match(/\/blocks\/(latest|\d+)$/)?.[1];
    if (block) {
      const height = block === "latest" ? String(this.height + 10) : block;
      return Response.json({
        block: { header: { height, chain_id: CHAIN_ID } },
        block_id: { hash: height === "1" ? GENESIS_HASH : createHash("sha256").update(height).digest("hex") },
      });
    }
    const tx = path.match(/\/txs\/([0-9A-Fa-f]{64})$/)?.[1];
    if (tx) {
      const record = this.transactions.get(tx.toUpperCase());
      return record
        ? Response.json({ tx_response: { code: 0, height: String(record.height), txhash: record.hash }, tx: { body: { messages: record.messages } } })
        : Response.json({ code: "not_found" }, { status: 404 });
    }
    const balance = path.match(/\/balances\/([^/]+)\/by_denom$/)?.[1];
    if (balance) return Response.json({ balance: { denom: DENOM, amount: (this.balances.get(balance) ?? 0n).toString() } });
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  private async authorizeEscrow(request: globalThis.Request): Promise<Response> {
    const config = fundsGate.config.settlementAuthorizer;
    if (!config || request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${config.apiKey}`) {
      return new Response(null, { status: 401 });
    }
    const canonical = await request.text();
    const hash = createHash("sha256").update(canonical).digest("hex");
    const key = request.headers.get("idempotency-key");
    if (!key || request.headers.get("x-request-sha256") !== hash) return new Response(null, { status: 400 });
    const prior = this.authorizerResults.get(key);
    if (prior && prior.hash !== hash) return new Response(null, { status: 409 });
    const body = object(JSON.parse(canonical));
    const quote = typeof body.gameId === "string" ? await quoteForGame(body.gameId) : null;
    if (!quote || body.contract !== config.contract) return new Response(null, { status: 400 });
    let txHash = prior?.txHash;
    if (!txHash) {
      const existing = this.escrowGames.get(quote.gameId);
      let receipt: EscrowGame["receipt"] = null;
      const path = new URL(request.url).pathname;
      let message: Record<string, unknown>;
      if (path === "/v1/escrow/games") {
        if (body.quoteHash !== quote.quoteHash || body.playerA !== quote.playerA || body.playerB !== quote.playerB ||
            body.stakeMicroUsd !== quote.stakeMicroUsd) return new Response(null, { status: 400 });
        message = { create_game: { game_id: quote.gameId, player_a: quote.playerA, player_b: quote.playerB,
          stake_per_point: quote.stakeMicroUsd, quote_hash: quote.quoteHash } };
      } else if (path === "/v1/escrow/settlements" || path === "/v1/escrow/refunds") {
        const settle = path.endsWith("/settlements");
        if (!existing || existing.status !== "active") return new Response(null, { status: 409 });
        const outcome = await this.settleEscrow({
          terminal: settle ? "settlement" : "refund", principal: quote.playerA, opponent: quote.playerB,
          gameId: quote.gameId,
          stakePerPointMicroUsd: quote.stakeMicroUsd, cubeCap: quote.cubeCap, rakeBps: quote.rakeBps,
          winner: String(body.winner), cubeValue: Number(body.cubeValue),
          resultMultiplier: Number(body.resultMultiplier), cubeWasTurned: body.cubeWasTurned === true,
        });
        receipt = {
          terminal_id: String(settle ? body.settlementId : body.refundId),
          winner: settle ? String(body.winner) : null,
          cube_value: settle ? Number(body.cubeValue) : null,
          result_multiplier: settle ? (body.cubeWasTurned === true ? Number(body.resultMultiplier) : 1) : null,
          liability: String(outcome.liabilityMicroUsd ?? "0"),
          rake: String(outcome.rakeMicroUsd ?? "0"),
          winner_payout: String(outcome.winnerPayoutMicroUsd ?? existing.reserve_per_player),
          loser_payout: String(outcome.loserRefundMicroUsd ?? existing.reserve_per_player),
          reason: settle ? null : String(body.reason),
          terminal_height: this.height + 1,
        };
        message = settle ? { settle: { game_id: quote.gameId, winner: body.winner,
          cube_value: body.cubeValue, result_multiplier: body.resultMultiplier,
          cube_was_turned: body.cubeWasTurned, settlement_id: body.settlementId } }
          : { refund: { game_id: quote.gameId, refund_id: body.refundId, reason: body.reason } };
      } else return new Response(null, { status: 404 });
      txHash = this.executeChain(quote.escrowSnapshot.settlementAuthority as string, ESCROW_CONTRACT, message, []);
      if (receipt && existing) {
        this.escrowGames.set(quote.gameId, { ...existing, receipt, status: receipt.winner === null ? "refunded" : "settled" });
      } else {
        const now = Math.floor(Date.now() / 1_000);
        const snapshot = fundsGate.escrowRecoverySnapshot()!;
        this.escrowGames.set(quote.gameId, {
          game_id: quote.gameId, player_a: quote.playerA, player_b: quote.playerB, stake_per_point: quote.stakeMicroUsd,
          reserve_per_player: quote.reservePerPlayerMicroUsd, player_a_deposited: false, player_b_deposited: false,
          quote_hash: quote.quoteHash, wager_denom: snapshot.denom, rake_bps: snapshot.rakeBps,
          rake_recipient: snapshot.rakeRecipient, cube_cap: snapshot.cubeCap, rules_version: snapshot.rulesVersion,
          status: "awaiting_reserves", created_at: now, created_height: this.height,
          funding_deadline: now + snapshot.fundingTimeoutSeconds, receipt: null,
        });
      }
      this.authorizerResults.set(key, { hash, txHash });
    }
    const privateKey = createPrivateKey({
      key: Buffer.from(process.env.SANDBOX_SETTLEMENT_PRIVATE_KEY ?? "", "base64"), format: "der", type: "pkcs8",
    });
    const signed = canonicalJson({ contract: config.contract, requestHash: hash, signingKeyId: config.signingKeyId, txHash });
    return Response.json({ txHash }, { headers: {
      "x-signing-key-id": config.signingKeyId,
      "x-response-signature-ed25519": sign(null, Buffer.from(signed), privateKey).toString("base64url"),
    } });
  }

  installFetchFixture(): () => void {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
      const url = new URL(request.url);
      if (url.origin === BRALE_ORIGIN || url.origin === AUTH_ORIGIN) return this.provider(request);
      if (url.origin === CHAIN_ORIGIN) return this.chain(url);
      if (url.origin === "https://settlement.browser-sandbox.invalid") return this.authorizeEscrow(request);
      return nativeFetch(input, init);
    };
    return () => { globalThis.fetch = nativeFetch; };
  }
}

function sandboxEnabled(): boolean {
  return process.env.GAMMON_BROWSER_FINANCE_SANDBOX === "1" && process.env.NODE_ENV !== "production";
}

function appendSandboxRoutes(app: Express, fixture: BrowserSandboxFixture): void {
  app.post("/__sandbox/chain/execute", (request, response) => {
    try {
      const body = object(request.body);
      const sender = typeof body.sender === "string" ? body.sender : "";
      const contract = typeof body.contract === "string" ? body.contract : "";
      const transactionHash = fixture.executeChain(sender, contract, body.msg, body.funds);
      response.status(201).json({ transactionHash, code: 0, events: [] });
    } catch {
      response.status(400).json({ error: "invalid_sandbox_execution" });
    }
  });

  app.post("/__sandbox/escrow", async (request, response) => {
    try {
      const body = object(request.body);
      const cubeCap = body.cubeCap;
      const rakeBps = body.rakeBps;
      const cubeValue = body.cubeValue;
      const resultMultiplier = body.resultMultiplier;
      if (
        (body.terminal !== "settlement" && body.terminal !== "refund")
        || typeof body.principal !== "string"
        || typeof body.opponent !== "string"
        || typeof body.stakePerPointMicroUsd !== "string"
        || typeof cubeCap !== "number" || !Number.isSafeInteger(cubeCap)
        || typeof rakeBps !== "number" || !Number.isSafeInteger(rakeBps)
      ) throw new TypeError("Invalid sandbox escrow request");
      response.json(await fixture.settleEscrow({
        terminal: body.terminal,
        principal: body.principal,
        opponent: body.opponent,
        ...(typeof body.winner === "string" ? { winner: body.winner } : {}),
        stakePerPointMicroUsd: body.stakePerPointMicroUsd,
        cubeCap,
        rakeBps,
        ...(typeof cubeValue === "number" && Number.isSafeInteger(cubeValue) ? { cubeValue } : {}),
        ...(typeof resultMultiplier === "number" && Number.isSafeInteger(resultMultiplier) ? { resultMultiplier } : {}),
        ...(typeof body.cubeWasTurned === "boolean" ? { cubeWasTurned: body.cubeWasTurned } : {}),
      }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "sandbox_escrow_failed" });
    }
  });
  app.get("/__sandbox/config", (_request, response) => {
    response.json({ chainId: CHAIN_ID, denom: DENOM, escrowContract: ESCROW_CONTRACT, financeAuthorizationContract: FINANCE_CONTRACT });
  });
}

export async function startBrowserFinanceSandbox(port = 3422): Promise<Server> {
  if (!sandboxEnabled()) throw new Error("Browser finance sandbox is disabled outside explicit non-production fixture mode");
  const fixture = new BrowserSandboxFixture();
  fixture.installFetchFixture();
  const attestation = {
    infrastructure: [], asset: [], escrowIntegrity: [], escrowEntry: [], escrowRecovery: [], provider: [], financeRouter: [],
  };
  fundsGate.setAttestation(attestation);
  const attestationTimer = setInterval(() => fundsGate.setAttestation(attestation), 15_000);
  const escrowSnapshot = fundsGate.escrowRecoverySnapshot();
  if (!escrowSnapshot) throw new Error("Browser cash-game fixture requires a complete escrow snapshot");
  installBrowserCashGameFixture({
    config: {
      admin: escrowSnapshot.escrowAdmin,
      wager_denom: escrowSnapshot.denom,
      settlement_authority: escrowSnapshot.settlementAuthority,
      rake_bps: escrowSnapshot.rakeBps,
      rake_recipient: escrowSnapshot.rakeRecipient,
      min_stake_per_point: escrowSnapshot.minStakePerPoint,
      max_stake_per_point: escrowSnapshot.maxStakePerPoint,
      funding_timeout_seconds: escrowSnapshot.fundingTimeoutSeconds,
      cube_cap: escrowSnapshot.cubeCap,
      rules_version: escrowSnapshot.rulesVersion,
      paused: false,
    },
    verifyReserve: async (input) => fixture.verifyReserve(input),
    queryGame: (gameId) => fixture.escrowGames.get(gameId),
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: SANDBOX_ORIGIN, credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token"] }));
  app.use(express.json({ limit: "64kb" }));
  appendSandboxRoutes(app, fixture);
  app.post("/api/session/challenge", createSessionChallenge);
  app.post("/api/session/verify", verifySessionChallenge);
  app.post("/api/session/finance-step-up", requireSession, requireCsrf, createFinanceStepUpChallenge);
  app.get("/api/session/current", requireSession, (request, response) => {
    const session = (request as ExpressRequest & { session?: { principal: string; expiresAt: number } }).session;
    response.json({ principal: session?.principal, expiresAt: session ? new Date(session.expiresAt).toISOString() : null });
  });
  app.get("/api/cash-games/config", async (_request, response) => response.json(await publicCashGameConfig()));
  app.use("/api/cash-games", cashGameRouter);
  app.get("/api/funds/config", (_request, response) => response.json(fundsGate.publicState()));
  app.use("/api/funds", financeRouter);
  const worker = startFinanceWorker();
  app.post("/__sandbox/cash-games/quotes/:id/refund-recovery", requireSession, requireCsrf, async (request, response) => {
    const session = (request as ExpressRequest & { session?: { principal: string } }).session;
    if (!session || !worker) {
      response.status(503).json({ error: "sandbox_recovery_unavailable" });
      return;
    }
    try {
      response.json(await recoverBrowserSandboxCashQuoteRefund({
        quoteId: String(request.params.id), participant: session.principal, worker,
      }));
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "sandbox_recovery_failed" });
    }
  });
  const reconciler = startFinanceReconciliationScheduler();
  const reconciliationTimer = setInterval(() => { void reconciler?.runOnce(); }, 500);
  const server = app.listen(port, "127.0.0.1");
  attachBrowserSandboxGameplay(server);
  server.on("close", () => {
    clearInterval(attestationTimer);
    clearInterval(reconciliationTimer);
    worker?.stop();
    reconciler?.stop();
  });
  await once(server, "listening");
  return server;
}

export const browserFinanceSandbox = Object.freeze({
  chainId: CHAIN_ID,
  denom: DENOM,
  escrowContract: ESCROW_CONTRACT,
  financeAuthorizationContract: FINANCE_CONTRACT,
  origin: SANDBOX_ORIGIN,
});
