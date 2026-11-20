import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { z } from "zod";
import { canonicalJson } from "./finance-crypto.js";
import { fundsGate, type EscrowRecoverySnapshot } from "./funds-config.js";

const CoinSchema = z.object({
  denom: z.string(),
  amount: z.string().regex(/^(0|[1-9]\d*)$/),
}).strict();

const ExecuteContractMessageSchema = z.object({
  "@type": z.string(),
  sender: z.string().optional(),
  contract: z.string().optional(),
  msg: z.string().optional(),
  funds: z.array(CoinSchema).optional(),
}).passthrough();

const TxSchema = z.object({
  tx: z.object({ body: z.object({ messages: z.array(ExecuteContractMessageSchema) }) }),
  tx_response: z.object({ code: z.number(), height: z.string(), txhash: z.string() }),
});

const BlockSchema = z.object({
  block: z.object({ header: z.object({ height: z.string(), chain_id: z.string() }) }),
  block_id: z.object({ hash: z.string().min(1) }),
});

const RpcBlockSchema = z.object({ result: BlockSchema });

const NodeInfoSchema = z.object({ default_node_info: z.object({ network: z.string() }) });

const EscrowReceiptSchema = z.object({
  terminal_id: z.string(),
  winner: z.string().nullable(),
  cube_value: z.number().int().nullable(),
  result_multiplier: z.number().int().nullable(),
  liability: z.string().regex(/^(0|[1-9]\d*)$/),
  rake: z.string().regex(/^(0|[1-9]\d*)$/),
  winner_payout: z.string().regex(/^(0|[1-9]\d*)$/),
  loser_payout: z.string().regex(/^(0|[1-9]\d*)$/),
  reason: z.string().nullable(),
  terminal_height: z.number().int().nonnegative(),
}).strict();

const EscrowGameSchema = z.object({
  game_id: z.string(),
  player_a: z.string(),
  player_b: z.string(),
  stake_per_point: z.string().regex(/^[1-9]\d*$/),
  reserve_per_player: z.string().regex(/^[1-9]\d*$/),
  player_a_deposited: z.boolean(),
  player_b_deposited: z.boolean(),
  quote_hash: z.string().regex(/^[0-9a-f]{64}$/),
  wager_denom: z.string(),
  rake_bps: z.number().int().min(0).max(10_000),
  rake_recipient: z.string(),
  cube_cap: z.number().int().positive(),
  rules_version: z.string(),
  status: z.enum(["awaiting_reserves", "active", "settled", "refunded"]),
  created_at: z.number().int().nonnegative(),
  created_height: z.number().int().nonnegative(),
  funding_deadline: z.number().int().nonnegative(),
  receipt: EscrowReceiptSchema.nullable(),
}).strict();

const EscrowConfigSchema = z.object({
  admin: z.string(),
  wager_denom: z.string(),
  settlement_authority: z.string(),
  rake_bps: z.number().int().min(0).max(10_000),
  rake_recipient: z.string(),
  min_stake_per_point: z.string().regex(/^[1-9]\d*$/),
  max_stake_per_point: z.string().regex(/^[1-9]\d*$/),
  funding_timeout_seconds: z.number().int().positive(),
  cube_cap: z.number().int().positive(),
  rules_version: z.string(),
  paused: z.boolean(),
}).strict();

export type EscrowGame = z.infer<typeof EscrowGameSchema>;
export type EscrowConfig = z.infer<typeof EscrowConfigSchema>;
export interface EscrowChainSnapshot extends EscrowRecoverySnapshot {
  readonly finalityBlocks: number;
}

export interface EscrowReserveVerification {
  readonly height: number;
  readonly blockHash: string;
  readonly escrow: EscrowGame;
}

export interface BrowserCashGameFixture {
  readonly config: EscrowConfig;
  queryGame(gameId: string): EscrowGame | undefined;
  verifyReserve(input: {
    readonly snapshot: EscrowChainSnapshot;
    readonly txHash: string;
    readonly principal: string;
    readonly signer: string | null;
    readonly gameId: string;
    readonly expectedAmountMicroUsd: string;
  }): Promise<EscrowReserveVerification>;
}

let browserCashGameFixture: BrowserCashGameFixture | null = null;

export function installBrowserCashGameFixture(fixture: BrowserCashGameFixture): void {
  if (process.env.NODE_ENV === "production" || process.env.GAMMON_BROWSER_FINANCE_SANDBOX !== "1") {
    throw new Error("Browser cash-game fixture is disabled");
  }
  browserCashGameFixture = fixture;
}

function configuredEndpoints(snapshot: EscrowChainSnapshot): { readonly rpc: string; readonly rest: string } {
  const asset = fundsGate.config.asset;
  if (!asset || !Number.isSafeInteger(snapshot.finalityBlocks) || snapshot.finalityBlocks < 1) {
    throw new Error("ESCROW_SNAPSHOT_INVALID");
  }
  return { rpc: asset.rpcUrl.replace(/\/$/, ""), rest: asset.restUrl.replace(/\/$/, "") };
}

async function json(response: Response, errorCode: string): Promise<unknown> {
  if (!response.ok) throw new Error(errorCode);
  return response.json();
}

async function attestSnapshot(snapshot: EscrowChainSnapshot): Promise<{ readonly rpc: string; readonly rest: string }> {
  const { rpc, rest } = configuredEndpoints(snapshot);
  if (browserCashGameFixture) {
    if (canonicalJson(snapshot) !== canonicalJson(fundsGate.escrowRecoverySnapshot())) {
      throw new Error("ESCROW_SNAPSHOT_MISMATCH");
    }
    return { rpc, rest };
  }
  let client: CosmWasmClient | null = null;
  try {
    client = await CosmWasmClient.connect(rpc);
    const [chainId, rpcGenesisResponse, nodeResponse, restGenesisResponse] = await Promise.all([
      client.getChainId(),
      fetch(`${rpc}/block?height=1`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${rest}/cosmos/base/tendermint/v1beta1/node_info`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/1`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    const [rpcGenesis, node, restGenesis] = await Promise.all([
      json(rpcGenesisResponse, "CHAIN_IDENTITY_UNAVAILABLE").then((value) => RpcBlockSchema.parse(value).result),
      json(nodeResponse, "CHAIN_IDENTITY_UNAVAILABLE").then((value) => NodeInfoSchema.parse(value)),
      json(restGenesisResponse, "CHAIN_IDENTITY_UNAVAILABLE").then((value) => BlockSchema.parse(value)),
    ]);
    if (
      chainId !== snapshot.chainId ||
      rpcGenesis.block.header.chain_id !== snapshot.chainId ||
      node.default_node_info.network !== snapshot.chainId ||
      restGenesis.block.header.chain_id !== snapshot.chainId ||
      rpcGenesis.block_id.hash.toLowerCase() !== snapshot.genesisHash.toLowerCase() ||
      restGenesis.block_id.hash.toLowerCase() !== snapshot.genesisHash.toLowerCase() ||
      rpcGenesis.block_id.hash.toLowerCase() !== restGenesis.block_id.hash.toLowerCase()
    ) throw new Error("CHAIN_IDENTITY_MISMATCH");
    const [contract, escrowConfig] = await Promise.all([
      client.getContract(snapshot.escrowContract),
      client.queryContractSmart(snapshot.escrowContract, { config: {} }).then((value) => EscrowConfigSchema.parse(value)),
    ]);
    const code = await client.getCodeDetails(contract.codeId);
    const authorizer = fundsGate.config.settlementAuthorizer;
    if (
      code.checksum.toLowerCase() !== snapshot.escrowCodeChecksum.toLowerCase() ||
      contract.admin !== snapshot.escrowAdmin ||
      escrowConfig.admin !== snapshot.escrowAdmin ||
      escrowConfig.wager_denom !== snapshot.denom ||
      escrowConfig.settlement_authority !== snapshot.settlementAuthority ||
      !authorizer ||
      snapshot.authorizerContract !== authorizer.contract ||
      snapshot.authorizerSigningKeyId !== authorizer.signingKeyId
    ) throw new Error("ESCROW_SNAPSHOT_MISMATCH");
    return { rpc, rest };
  } finally {
    client?.disconnect();
  }
}

async function queryTransaction(snapshot: EscrowChainSnapshot, txHash: string): Promise<{ readonly rest: string; readonly transaction: z.infer<typeof TxSchema> }> {
  if (!/^[0-9A-F]{64}$/.test(txHash)) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const { rest } = await attestSnapshot(snapshot);
  const response = await fetch(`${rest}/cosmos/tx/v1beta1/txs/${txHash}`, { signal: AbortSignal.timeout(10_000) });
  const transaction = TxSchema.parse(await json(response, "CHAIN_TRANSACTION_NOT_FOUND"));
  if (transaction.tx_response.code !== 0 || transaction.tx_response.txhash.toUpperCase() !== txHash) {
    throw new Error("CHAIN_TRANSACTION_MISMATCH");
  }
  return { rest, transaction };
}

function decodedMessage(message: Record<string, unknown>): unknown | null {
  if (typeof message.msg !== "string") return null;
  try {
    return JSON.parse(Buffer.from(message.msg, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function authorizedReserveExecutionMessage(
  messages: readonly z.infer<typeof ExecuteContractMessageSchema>[],
  principal: string,
  signer: string | null,
): z.infer<typeof ExecuteContractMessageSchema> {
  if (messages.length !== 1) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const outer = messages[0]!;
  let message: Record<string, unknown>;
  if (outer["@type"] === "/cosmos.authz.v1beta1.MsgExec") {
    const delegated = outer.msgs;
    if (
      signer === null ||
      outer.grantee !== signer ||
      !Array.isArray(delegated) ||
      delegated.length !== 1 ||
      !isMessage(delegated[0])
    ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
    message = delegated[0];
  } else {
    if (signer !== null && principal !== signer) throw new Error("CHAIN_TRANSACTION_MISMATCH");
    message = outer;
  }
  const execution = ExecuteContractMessageSchema.safeParse(message);
  if (!execution.success || execution.data["@type"] !== "/cosmwasm.wasm.v1.MsgExecuteContract") {
    throw new Error("CHAIN_TRANSACTION_MISMATCH");
  }
  return execution.data;
}

export async function queryEscrowGame(snapshot: EscrowChainSnapshot, gameId: string): Promise<EscrowGame> {
  if (browserCashGameFixture) {
    const game = browserCashGameFixture.queryGame(gameId);
    if (!game) throw new Error("ESCROW_GAME_NOT_FOUND");
    return EscrowGameSchema.parse(game);
  }
  const { rpc } = await attestSnapshot(snapshot);
  const client = await CosmWasmClient.connect(rpc);
  try {
    return EscrowGameSchema.parse(await client.queryContractSmart(snapshot.escrowContract, { game: { game_id: gameId } }));
  } finally {
    client.disconnect();
  }
}

export async function queryEscrowConfig(snapshot: EscrowChainSnapshot): Promise<EscrowConfig> {
  if (browserCashGameFixture) return browserCashGameFixture.config;
  const { rpc } = await attestSnapshot(snapshot);
  const client = await CosmWasmClient.connect(rpc);
  try {
    return EscrowConfigSchema.parse(await client.queryContractSmart(snapshot.escrowContract, { config: {} }));
  } finally {
    client.disconnect();
  }
}

export async function assertEscrowStateFinality(snapshot: EscrowChainSnapshot, height: number): Promise<{
  readonly height: number;
  readonly blockHash: string;
}> {
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("ESCROW_STATE_MISMATCH");
  const { rest } = await attestSnapshot(snapshot);
  const latest = BlockSchema.parse(await json(
    await fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/latest`, { signal: AbortSignal.timeout(10_000) }),
    "CHAIN_FINALITY_UNAVAILABLE",
  ));
  const latestHeight = Number(latest.block.header.height);
  if (!Number.isSafeInteger(latestHeight) || latestHeight - height < snapshot.finalityBlocks) {
    throw new Error("CHAIN_TRANSACTION_NOT_FINAL");
  }
  const block = BlockSchema.parse(await json(
    await fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/${height}`, { signal: AbortSignal.timeout(10_000) }),
    "CHAIN_FINALITY_UNAVAILABLE",
  ));
  if (Number(block.block.header.height) !== height || block.block.header.chain_id !== snapshot.chainId) {
    throw new Error("CHAIN_FINALITY_UNAVAILABLE");
  }
  return { height, blockHash: block.block_id.hash };
}

export async function verifyEscrowTransaction(input: {
  readonly snapshot: EscrowChainSnapshot;
  readonly txHash: string;
  readonly sender: string;
  readonly message: Record<string, unknown>;
}): Promise<{ readonly height: number; readonly blockHash: string }> {
  const { transaction } = await queryTransaction(input.snapshot, input.txHash);
  const messages = transaction.tx.body.messages;
  if (messages.length !== 1) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const message = messages[0];
  if (
    message["@type"] !== "/cosmwasm.wasm.v1.MsgExecuteContract" ||
    message.sender !== input.sender ||
    message.contract !== input.snapshot.escrowContract ||
    (message.funds?.length ?? 0) !== 0
  ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const decoded = decodedMessage(message);
  if (!decoded || canonicalJson(decoded) !== canonicalJson(input.message)) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const height = Number(transaction.tx_response.height);
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  return assertEscrowStateFinality(input.snapshot, height);
}

export async function verifyReserveTransaction(input: {
  readonly snapshot: EscrowChainSnapshot;
  readonly txHash: string;
  readonly principal: string;
  readonly signer: string | null;
  readonly gameId: string;
  readonly expectedAmountMicroUsd: string;
}): Promise<EscrowReserveVerification> {
  if (browserCashGameFixture) return browserCashGameFixture.verifyReserve(input);
  const { transaction } = await queryTransaction(input.snapshot, input.txHash);
  const messages = transaction.tx.body.messages;
  const expectedMessage = { deposit_reserve: { game_id: input.gameId } };
  const message = authorizedReserveExecutionMessage(messages, input.principal, input.signer);
  if (
    message["@type"] !== "/cosmwasm.wasm.v1.MsgExecuteContract" ||
    message.sender !== input.principal ||
    message.contract !== input.snapshot.escrowContract ||
    (message.funds?.length ?? 0) !== 1
  ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const decoded = decodedMessage(message);
  const funds = message.funds ?? [];
  if (
    decoded === null ||
    canonicalJson(decoded) !== canonicalJson(expectedMessage) ||
    funds[0].denom !== input.snapshot.denom ||
    funds[0].amount !== input.expectedAmountMicroUsd
  ) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const txHeight = Number(transaction.tx_response.height);
  const finality = await assertEscrowStateFinality(input.snapshot, txHeight);
  const escrow = await queryEscrowGame(input.snapshot, input.gameId);
  if (
    escrow.game_id !== input.gameId ||
    escrow.wager_denom !== input.snapshot.denom ||
    escrow.reserve_per_player !== input.expectedAmountMicroUsd ||
    (escrow.player_a !== input.principal && escrow.player_b !== input.principal) ||
    (escrow.player_a === input.principal && !escrow.player_a_deposited) ||
    (escrow.player_b === input.principal && !escrow.player_b_deposited)
  ) throw new Error("ESCROW_STATE_MISMATCH");
  return { ...finality, escrow };
}
