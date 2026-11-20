import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import type { FundsConfig } from "../funds-config.js";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { runSandboxEscrow } from "./sandbox-escrow.js";
import {
  completeSandboxCashOut, confirmSandboxCashOut, createSandboxCashOut, createSandboxCashOutChainFetchHandler,
  recordSandboxCashOutFundingTransaction, sandboxCashOutAuthorizationEnvironment, type SandboxCashOutFundingTransaction,
} from "./sandbox-cashout.js";

const providerFixture = vi.hoisted(() => ({
  createPlaidLinkToken: vi.fn(),
  registerPlaidAccount: vi.fn(),
  createTransfer: vi.fn(),
}));
const financeStepUpFixture = vi.hoisted(() => vi.fn());

// Fixture boundary: the provider is outside this sandbox. The HTTP application, database,
// idempotency, dispatch authorization, and persistence paths remain real.
vi.mock("../brale.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  createConfiguredBraleClient: vi.fn(() => providerFixture),
}));

// Fixture boundary: wallet signatures are verified by the session integration suite.
// This test supplies only the authenticated, scoped step-up result required by these routes.
vi.mock("../session.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  requireFinanceStepUp: financeStepUpFixture,
}));

const sandboxEnabled = process.env.GAMMON_FINANCE_SANDBOX === "1";
const fixtureHash = "a".repeat(64);
const fixtureKey = Buffer.alloc(32, 7).toString("base64");

const depositAmount = 5_000_000n;
const fundingBank = "sandbox-funding-bank";
function configureSandboxFinance(): void {
  vi.stubEnv("FUNDS_MODE", "verusd_testnet");
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("BRALE_ACCOUNT_ID", "sandboxbraleaccount01");
  vi.stubEnv("BRALE_API_KEY", "sandbox-provider-key");
  vi.stubEnv("BRALE_API_URL", "https://brale.sandbox.invalid");
  vi.stubEnv("BRALE_AUTH_URL", "https://auth.sandbox.invalid");
  vi.stubEnv("BRALE_PLAID_WEBHOOK_URL", "https://wallet.sandbox.invalid/api/webhooks/plaid");
  vi.stubEnv("BRALE_END_USER_TOS_VERSION", "sandbox-brale-eua-v1");
  vi.stubEnv("BRALE_EUA_URL", "https://www.brale.xyz/sandbox-eua");
  vi.stubEnv("BRALE_EUA_SHA256", fixtureHash);
  vi.stubEnv("BRALE_EUA_EXPIRES_AT", "2099-01-01T00:00:00.000Z");
  vi.stubEnv("PLAID_PRIVACY_VERSION", "sandbox-plaid-privacy-v1");
  vi.stubEnv("PLAID_PRIVACY_URL", "https://plaid.com/sandbox-privacy");
  vi.stubEnv("PLAID_PRIVACY_SHA256", fixtureHash);
  vi.stubEnv("PLAID_PRIVACY_EXPIRES_AT", "2099-01-01T00:00:00.000Z");
  vi.stubEnv("ACH_AUTHORIZATION_VERSION", "sandbox-ach-v1");
  vi.stubEnv("ACH_AUTHORIZATION_URL", "https://wallet.sandbox.invalid/ach-authorization");
  vi.stubEnv("ACH_AUTHORIZATION_SHA256", fixtureHash);
  vi.stubEnv("ACH_AUTHORIZATION_EXPIRES_AT", "2099-01-01T00:00:00.000Z");
  vi.stubEnv("TERMS_VERSION", "sandbox-terms-v1");
  vi.stubEnv("PRIVACY_VERSION", "sandbox-privacy-v1");
  vi.stubEnv("FINANCE_DATA_KEY", fixtureKey);
  vi.stubEnv("ACH_AVAILABILITY_DELAY_SECONDS", "1");
  vi.stubEnv("FINANCE_HASH_KEY", fixtureKey);
  const escrow = `xion1${"q".repeat(38)}`;
  for (const [key, value] of Object.entries({
    ...sandboxCashOutAuthorizationEnvironment(),
    VERUSD_CHAIN_ID: "xion-testnet-2",
    VERUSD_GENESIS_BLOCK_HASH: fixtureHash,
    VERUSD_RPC_URL: "https://rpc.sandbox.invalid",
    VERUSD_REST_URL: "https://chain.sandbox.invalid",
    VERUSD_DENOM: `factory/${escrow}/verusd`,
    VERUSD_ESCROW_CONTRACT: escrow,
    VERUSD_ESCROW_CODE_CHECKSUM: fixtureHash,
    VERUSD_FINALITY_BLOCKS: "2",
    VERUSD_SYMBOL: "verUSD",
    VERUSD_DECIMALS: "6",
    BRALE_TRANSFER_TYPE: "verona_testnet",
  })) vi.stubEnv(key, value);
}

function consent(
  legalDocuments: NonNullable<FundsConfig["legalDocuments"]>,
  reviewedContext: Record<string, unknown>,
) {
  return {
    acceptedAt: new Date().toISOString(),
    purpose: "link_bank",
    reviewedContext,
    legalDocuments: {
      braleEua: {
        url: legalDocuments.braleEua.url,
        version: legalDocuments.braleEua.version,
        sha256: legalDocuments.braleEua.sha256,
      },
      plaidPrivacy: {
        url: legalDocuments.plaidPrivacy.url,
        version: legalDocuments.plaidPrivacy.version,
        sha256: legalDocuments.plaidPrivacy.sha256,
      },
      achAuthorization: {
        url: legalDocuments.achAuthorization.url,
        version: legalDocuments.achAuthorization.version,
        sha256: legalDocuments.achAuthorization.sha256,
      },
    },
    termsVersion: "sandbox-terms-v1",
    privacyVersion: "sandbox-privacy-v1",
    braleEuaVersion: legalDocuments.braleEua.version,
    plaidPrivacyVersion: legalDocuments.plaidPrivacy.version,
    achAuthorizationVersion: legalDocuments.achAuthorization.version,
  };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sandbox HTTP server has no TCP address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

it.runIf(sandboxEnabled)("links a bank, deposits, settles and refunds wagers, then cashes out the resulting balance", async () => {
  configureSandboxFinance();
  vi.resetModules();
  financeStepUpFixture.mockResolvedValue(undefined);
  providerFixture.createPlaidLinkToken.mockResolvedValue({
    linkToken: "link-sandbox-token",
    expiration: "2099-01-01T01:00:00.000Z",
    callbackUrl: "https://wallet.sandbox.invalid/plaid/callback",
  });
  providerFixture.registerPlaidAccount.mockResolvedValue({ addressId: "sandbox-bank-address-01" });

  // Modules must load after the per-test environment fixtures so their runtime configuration is isolated.
  const { financeRouter } = await import("../finance-router.js");
  const { fundsGate } = await import("../funds-config.js");
  const { getPool, closeDatabase } = await import("../db.js");
  const { listPaymentMethods, reconcileProviderResourceState, upsertPaymentProfile } = await import("../finance-store.js");
  const { startFinanceWorker } = await import("../finance-worker.js");
  const legalDocuments = fundsGate.config.legalDocuments;
  if (!legalDocuments) throw new Error("Sandbox legal-document fixture is unavailable");
  const originalBlockersFor = fundsGate.blockersFor.bind(fundsGate);
  // Fixture boundary: no provider or chain attestation is available in an offline sandbox.
  // Scope the fixture to the simulated rails; mutation policy and journal processing remain real.
  const gate = vi.spyOn(fundsGate, "blockersFor").mockImplementation((action) =>
    action === "link_bank" || action === "deposit" || action === "cash_out" ? [] : originalBlockersFor(action),
  );
  const balanceGate = vi.spyOn(fundsGate, "balanceReadBlockers").mockReturnValue([]);
  const principal = `xion1${randomUUID().replaceAll("-", "").replaceAll("1", "2").replaceAll("b", "a")}${"q".repeat(6)}`;
  const internalWallet = `xion1${"z".repeat(38)}`;
  const opponent = `xion1${"p".repeat(38)}`;
  const balances = new Map([[fundingBank, depositAmount], [principal, 0n], [opponent, depositAmount]]);
  const sessionToken = `sandbox-session-${randomUUID()}`;
  const csrfToken = `sandbox-csrf-${randomUUID()}`;
  const app = express();
  app.use(express.json());
  app.use("/api/funds", financeRouter);

  const { server, baseUrl } = await listen(app);
  try {
    await getPool()!.query(
      `INSERT INTO auth_sessions
        (id_hash, principal, signer, chain_id, csrf_hash, grant_expires_at, expires_at)
       VALUES ($1, $2, $2, 'xion-testnet-2', $3, NULL, NOW() + INTERVAL '5 minutes')`,
      [
        createHash("sha256").update(sessionToken).digest("hex"),
        principal,
        createHash("sha256").update(csrfToken).digest("hex"),
      ],
    );
    // Start from the durable result of customer enrollment.
    await upsertPaymentProfile({
      principal, walletAddress: principal, status: "active", providerAccountId: "sandboxprovideracct01",
      externalWalletAddressId: "sandbox-external", internalAddressId: "sandbox-internal",
      internalWalletAddress: internalWallet,
    });

    const linkTokenResponse = await fetch(`${baseUrl}/api/funds/wallet/link-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `sandbox-link-token-${randomUUID()}`,
        cookie: `gammon_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        legalName: "Jane Sandbox",
        emailAddress: "jane.sandbox@example.test",
        dateOfBirth: "1990-01-01",
        consent: consent(legalDocuments, { identitySubmitted: true }),
      }),
    });
    const linkBody = await linkTokenResponse.json();
    expect(linkTokenResponse.status, JSON.stringify(linkBody)).toBe(201);
    expect(linkBody).toMatchObject({
      operation: { kind: "link_bank", state: "awaiting_user", principal },
      linkToken: "link-sandbox-token",
      expiresAt: "2099-01-01T01:00:00.000Z",
      callbackUrl: "https://wallet.sandbox.invalid/plaid/callback",
    });
    expect(providerFixture.createPlaidLinkToken).toHaveBeenCalledWith(
      "sandboxprovideracct01",
      { legalName: "Jane Sandbox", emailAddress: "jane.sandbox@example.test", dateOfBirth: "1990-01-01" },
      expect.stringMatching(/^gammon:/),
    );

    const completionResponse = await fetch(`${baseUrl}/api/funds/wallet/link-bank/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `sandbox-link-complete-${randomUUID()}`,
        cookie: `gammon_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        publicToken: "sandbox-plaid-public-token",
        consent: consent(legalDocuments, { providerLinkCompleted: true }),
      }),
    });
    const completionBody = await completionResponse.json() as { operation: { id: string } };
    expect(completionResponse.status, JSON.stringify(completionBody)).toBe(201);
    expect(completionBody).toMatchObject({
      operation: { kind: "link_bank", state: "complete", principal },
    });
    expect(providerFixture.registerPlaidAccount).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "sandboxprovideracct01",
      publicToken: "sandbox-plaid-public-token",
      customerWebhookUrl: "https://wallet.sandbox.invalid/api/webhooks/plaid",
      accountHolderType: "individual",
      idempotencyKey: expect.stringMatching(/^gammon:/),
    }));
    expect(await listPaymentMethods(principal)).toEqual([
      expect.objectContaining({ principal, state: "pending", displayLabel: "Linked bank account" }),
    ]);
    const [method] = await listPaymentMethods(principal);
    await reconcileProviderResourceState({
      resourceType: "address", resourceId: "sandbox-bank-address-01", status: "active",
    });
    expect(await listPaymentMethods(principal)).toEqual([expect.objectContaining({ id: method.id, state: "active" })]);
    const asset = fundsGate.config.asset!;
    const transactions = new Map<string, SandboxCashOutFundingTransaction>();
    const cashOutChain = createSandboxCashOutChainFetchHandler({ asset, balances, transactions });
    const txHash = "b".repeat(64);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
      const { origin, pathname } = new URL(input);
      if (origin === baseUrl) return realFetch(input, options);
      if (origin !== asset.restUrl) throw new Error(`Unexpected sandbox origin: ${origin}`);
      if (pathname.endsWith(`/balances/${principal}/by_denom`)) {
        return Response.json({ balance: { denom: asset.denom, amount: balances.get(principal)!.toString() } });
      }
      if (pathname.endsWith("/node_info")) return Response.json({ default_node_info: { network: asset.chainId } });
      if (pathname.endsWith("/blocks/1")) return Response.json({ block_id: { hash: asset.genesisHash } });
      if (pathname.endsWith("/blocks/latest")) return Response.json({ block: { header: { height: "12" } } });
      if (pathname.endsWith(`/txs/${txHash}`)) return Response.json({
        tx_response: { code: 0, height: "10", txhash: txHash },
        tx: { body: { messages: [{
          "@type": "/cosmos.bank.v1beta1.MsgSend", to_address: principal,
          amount: [{ denom: asset.denom, amount: depositAmount.toString() }],
        }] } },
      });
      const cashOutResponse = cashOutChain(input);
      if (cashOutResponse) return cashOutResponse;
      throw new Error(`Unexpected sandbox path: ${pathname}`);
    });
    providerFixture.createTransfer.mockImplementation(({ source, destination, amountUsd, brandAccountId }) => {
      if (destination.transferType === "ach_credit") {
        const [whole, fraction = ""] = String(amountUsd).split(".");
        const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
        expect(balances.get(internalWallet)).toBe(amount);
        balances.set(internalWallet, 0n);
        balances.set(fundingBank, balances.get(fundingBank)! + amount);
        return {
          id: `sandbox-cash-out-${principal}`, accountId: brandAccountId, source, destination,
          amount: { value: amountUsd }, status: "complete",
        };
      }
      expect(balances.get(fundingBank)).toBe(depositAmount);
      balances.set(fundingBank, 0n);
      balances.set(principal, depositAmount);
      return {
        id: `sandbox-deposit-${principal}`, accountId: brandAccountId, source, destination,
        amount: { value: amountUsd }, status: "complete", chainTxHash: txHash,
      };
    });
    const deposit = await fetch(`${baseUrl}/api/funds/deposits`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "idempotency-key": `sandbox-deposit-${randomUUID()}`,
        cookie: `gammon_session=${sessionToken}`, "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        amount: "5.00", paymentMethodId: method.id,
        consent: { ...consent(legalDocuments, { amountMicroUsd: depositAmount.toString(), paymentMethodId: method.id }), purpose: "deposit" },
      }),
    });
    const depositBody = await deposit.json() as { operation: { id: string } };
    expect(deposit.status, JSON.stringify(depositBody)).toBe(202);
    const worker = startFinanceWorker()!;
    try {
      expect(await worker.runOnce()).toBe(true);
    } finally {
      worker.stop();
    }
    const depositReceipt = await fetch(`${baseUrl}/api/funds/operations/${depositBody.operation.id}`, {
      headers: { cookie: `gammon_session=${sessionToken}` },
    });
    const sessionHeaders = { cookie: `gammon_session=${sessionToken}` };
    const readWallet = async () => {
      const response = await fetch(`${baseUrl}/api/funds/wallet`, { headers: sessionHeaders });
      expect(response.status).toBe(200);
      return await response.json() as {
        balance: { status: string; availableMicroUsd: string };
        operations: Array<{ id: string; state: string }>;
      };
    };
    const availabilityDeadline = Date.now() + 5_000;
    while ((await readWallet()).balance.availableMicroUsd !== depositAmount.toString()) {
      if (Date.now() >= availabilityDeadline) throw new Error("Sandbox deposit did not become available");
      await delay(50);
    }
    expect(depositReceipt.status).toBe(200);
    expect(await depositReceipt.json()).toMatchObject({
      operation: { kind: "deposit", state: "complete", principal, amountMicroUsd: depositAmount.toString() },
    });
    const journal = await getPool()!.query(`
      SELECT line.account_code, line.direction, line.amount_micro_usd::text AS amount
        FROM journal_batches batch JOIN journal_lines line ON line.batch_id = batch.id
       WHERE batch.operation_id = $1 ORDER BY line.direction`, [depositBody.operation.id]);
    expect(journal.rows).toEqual([
      { account_code: "player_chain_observed", direction: "credit", amount: depositAmount.toString() },
      { account_code: "provider_clearing", direction: "debit", amount: depositAmount.toString() },
    ]);
    const wager = { balances, principal, opponent, denom: asset.denom, stakePerPointMicroUsd: 100_000n, cubeCap: 8, rakeBps: 250 };
    const settlement = runSandboxEscrow({
      ...wager, terminal: "settlement", winner: principal, cubeValue: 4, resultMultiplier: 2, cubeWasTurned: true,
    });
    expect(settlement.escrowBalanceMicroUsd).toBe(0n);
    expect(balances.get(principal)).toBe(5_780_000n);
    expect(balances.get(opponent)).toBe(4_200_000n);
    expect(balances.get(settlement.rakeRecipient)).toBe(20_000n);
    const beforeRefund = new Map(balances);
    const refund = runSandboxEscrow({ ...wager, terminal: "refund" });
    expect(refund.escrowBalanceMicroUsd).toBe(0n);
    expect(balances).toEqual(beforeRefund);
    const cashOutHeaders = { ...sessionHeaders, "x-csrf-token": csrfToken, "idempotency-key": `sandbox-cashout-${randomUUID()}` };
    const cashOut = await createSandboxCashOut({
      baseUrl, amount: "5.78", paymentMethodId: method.id, destination: internalWallet, headers: cashOutHeaders,
      consent: (purpose, context) => ({ ...consent(legalDocuments, context), purpose }),
    });
    const cashOutTx = "C".repeat(64);
    recordSandboxCashOutFundingTransaction({
      balances, transactions, txHash: cashOutTx, fundingInstruction: cashOut.fundingInstruction,
    });
    await confirmSandboxCashOut({ baseUrl, operationId: cashOut.operationId, txHash: cashOutTx, headers: cashOutHeaders });
    await completeSandboxCashOut({ baseUrl, operationId: cashOut.operationId, headers: sessionHeaders, startFinanceWorker });
    const wallet = await readWallet();
    expect(wallet.balance.availableMicroUsd).toBe("0");
    expect(wallet.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: completionBody.operation.id, state: "complete" }),
      expect.objectContaining({ id: depositBody.operation.id, state: "complete" }),
      expect.objectContaining({ id: cashOut.operationId, state: "complete" }),
    ]));
    expect(balances.get(fundingBank)).toBe(5_780_000n);
    expect(balances.get(principal)).toBe(0n);
    expect(balances.get(internalWallet)).toBe(0n);
    expect([...balances.values()].reduce((total, amount) => total + amount, 0n)).toBe(2n * depositAmount);
    const journalTotals = await getPool()!.query(`
      SELECT batch.operation_id, batch.entry_key,
             sum(CASE line.direction WHEN 'debit' THEN line.amount_micro_usd ELSE -line.amount_micro_usd END)::text AS net
        FROM journal_batches batch JOIN journal_lines line ON line.batch_id = batch.id
       WHERE batch.operation_id IN ($1, $2) GROUP BY batch.id`,
    [depositBody.operation.id, cashOut.operationId]);
    expect(journalTotals.rows).toEqual(expect.arrayContaining([
      { operation_id: depositBody.operation.id, entry_key: "complete", net: "0" },
      { operation_id: cashOut.operationId, entry_key: "complete", net: "0" },
    ]));
    expect(journalTotals.rows.every((row) => row.net === "0")).toBe(true);
    const receiptUrl = `${baseUrl}/api/funds/operations/${completionBody.operation.id}`;
    const receipt = await fetch(receiptUrl, { headers: { cookie: `gammon_session=${sessionToken}` } });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({
      operation: { id: completionBody.operation.id, kind: "link_bank", state: "complete", principal },
    });
    expect((await fetch(receiptUrl)).status).toBe(401);
    expect(financeStepUpFixture).toHaveBeenCalledWith(expect.anything(), "link_token");
    expect(financeStepUpFixture).toHaveBeenCalledWith(expect.anything(), "link_bank");
  } finally {
    vi.unstubAllGlobals();
    gate.mockRestore();
    balanceGate.mockRestore();
    const closed = once(server, "close");
    server.close();
    await closed;
    await closeDatabase();
  }
}, 120_000);
