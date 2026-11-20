import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { closeDatabase, getPool } from "../db.js";
import { fundsGate } from "../funds-config.js";
import { encryptSensitiveJson } from "../finance-crypto.js";
import { createMoneyOperation, listOperations } from "../finance-store.js";
import { startFinanceWorker } from "../finance-worker.js";

const { transfer } = vi.hoisted(() => ({ transfer: vi.fn() }));
vi.mock("../brale.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, createConfiguredBraleClient: () => ({ createTransfer: transfer }) };
});

it.runIf(process.env.GAMMON_FINANCE_SANDBOX === "1")("posts synthetic bank movements once and isolates history", async () => {
  const principal = `sandbox-${randomUUID()}`;
  const assetDenom = "sandbox-verusd";
  const amountMicroUsd = "1000000";
  const requestHash = "a".repeat(64);
  const genesisHash = "a".repeat(64);
  const chainTxHash = "b".repeat(64);
  const payload = {
    paymentMethodId: "sandbox-bank", providerAccountId: "sandbox-account",
    providerAddressId: "sandbox-bank", externalWalletAddressId: "sandbox-external",
    internalAddressId: "sandbox-internal", destinationWalletAddress: principal,
    assetDenom, chainRestUrl: "https://sandbox-chain.invalid", chainId: "sandbox",
    genesisHash, finalityBlocks: 2, fundsMode: "verusd_testnet", transferType: "verona_testnet",
  };
  const blockersFor = fundsGate.blockersFor.bind(fundsGate);
  const gate = vi.spyOn(fundsGate, "blockersFor").mockImplementation((action) =>
    action === "deposit" || action === "cash_out" ? [] : blockersFor(action),
  );
  transfer.mockImplementation(({ source, destination, amountUsd, brandAccountId }) => ({
    id: `${principal}:${source.transferType}`, accountId: brandAccountId,
    amount: { value: amountUsd }, source, destination, status: "complete", chainTxHash,
  }));
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/node_info")) return Response.json({ default_node_info: { network: payload.chainId } });
    if (path.endsWith("/blocks/1")) return Response.json({ block_id: { hash: genesisHash } });
    if (path.endsWith("/blocks/latest")) return Response.json({ block: { header: { height: "12" } } });
    if (path.endsWith(`/txs/${chainTxHash}`)) {
      return Response.json({
        tx_response: { code: 0, height: "10", txhash: chainTxHash },
        tx: { body: { messages: [{
          "@type": "/cosmos.bank.v1beta1.MsgSend", to_address: principal,
          amount: [{ denom: assetDenom, amount: amountMicroUsd }],
        }] } },
      });
    }
    throw new Error(`Unexpected sandbox chain request: ${url}`);
  });
  const worker = startFinanceWorker()!;
  try {
    for (const kind of ["deposit", "cash_out"] as const) {
      const input = {
        principal, kind, initialState: "queued" as const, amountMicroUsd, assetDenom,
        clientIdempotencyKey: `sandbox-${kind}-00000001`, requestHash,
        effect: { type: `create_${kind}`, encryptedPayload: (id: string) => encryptSensitiveJson(payload, id), requestHash },
      };
      const { operation } = await createMoneyOperation(input);
      expect((await createMoneyOperation(input)).operation.id).toBe(operation.id);
      expect(await worker.runOnce()).toBe(true);
      expect((await listOperations(principal)).find(({ id }) => id === operation.id)?.state).toBe("complete");
    }
    expect((await listOperations(principal)).map(({ kind, state }) => [kind, state])).toEqual([
      ["cash_out", "complete"], ["deposit", "complete"],
    ]);
    expect(await listOperations(`${principal}-other`)).toEqual([]);
    expect(await worker.runOnce()).toBe(false);
    expect(transfer).toHaveBeenCalledTimes(2);
    const { rows } = await getPool()!.query(`
      SELECT account_code AS account, count(*)::int AS lines,
             sum(CASE direction WHEN 'debit' THEN amount_micro_usd ELSE -amount_micro_usd END)::text AS net
        FROM journal_lines WHERE principal = $1 GROUP BY account_code ORDER BY account_code`, [principal]);
    expect(rows).toEqual([
      { account: "player_chain_observed", lines: 1, net: "-1000000" },
      { account: "provider_cash_out_obligation", lines: 1, net: "-1000000" },
      { account: "provider_clearing", lines: 2, net: "2000000" },
    ]);
  } finally {
    worker.stop();
    vi.unstubAllGlobals();
    gate.mockRestore();
    await closeDatabase();
  }
});
