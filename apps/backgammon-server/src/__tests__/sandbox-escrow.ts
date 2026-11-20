import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type SandboxBalances = Map<string, bigint>;

export interface FundedEscrowInput {
  /** Shared test balance state, denominated exclusively in `denom`. */
  readonly balances: SandboxBalances;
  readonly principal: string;
  readonly opponent: string;
  readonly denom: string;
  readonly stakePerPointMicroUsd: bigint;
  readonly cubeCap: number;
  readonly rakeBps: number;
  /** Defaults to a denom-scoped sandbox account. */
  readonly escrowAddress?: string;
  /** Defaults to a denom-scoped sandbox rake account. */
  readonly rakeRecipient?: string;
}

export interface FundedSettlementInput extends FundedEscrowInput {
  readonly winner: string;
  readonly cubeValue: number;
  readonly resultMultiplier: number;
  readonly cubeWasTurned: boolean;
}

export interface FundedRefundInput extends FundedEscrowInput {}

export type SandboxEscrowInput =
  | (FundedSettlementInput & { readonly terminal: "settlement" })
  | (FundedRefundInput & { readonly terminal: "refund" });

export type SandboxEscrowOutcome = EscrowSettlementOutcome | EscrowRefundOutcome;

export interface EscrowSettlementOutcome {
  readonly denom: string;
  readonly reservePerPlayerMicroUsd: bigint;
  readonly liabilityMicroUsd: bigint;
  readonly rakeMicroUsd: bigint;
  readonly winnerPayoutMicroUsd: bigint;
  readonly loserRefundMicroUsd: bigint;
  readonly winnerBalanceMicroUsd: bigint;
  readonly opponentBalanceMicroUsd: bigint;
  readonly rakeRecipient: string;
  readonly rakeRecipientBalanceMicroUsd: bigint;
  readonly escrowAddress: string;
  readonly escrowBalanceMicroUsd: bigint;
  readonly totalBeforeMicroUsd: bigint;
  readonly totalAfterMicroUsd: bigint;
}

export interface EscrowRefundOutcome {
  readonly denom: string;
  readonly reservePerPlayerMicroUsd: bigint;
  readonly principalBalanceMicroUsd: bigint;
  readonly opponentBalanceMicroUsd: bigint;
  readonly rakeRecipient: string;
  readonly rakeRecipientBalanceMicroUsd: bigint;
  readonly escrowAddress: string;
  readonly escrowBalanceMicroUsd: bigint;
  readonly totalBeforeMicroUsd: bigint;
  readonly totalAfterMicroUsd: bigint;
}

interface BridgeResult {
  readonly principalBalanceMicroUsd: bigint;
  readonly opponentBalanceMicroUsd: bigint;
  readonly rakeBalanceMicroUsd: bigint;
  readonly escrowBalanceMicroUsd: bigint;
  readonly reservePerPlayerMicroUsd: bigint;
  readonly liabilityMicroUsd: bigint;
  readonly rakeMicroUsd: bigint;
  readonly winnerPayoutMicroUsd: bigint;
  readonly loserPayoutMicroUsd: bigint;
}

interface BridgeContext {
  readonly escrowAddress: string;
  readonly rakeRecipient: string;
  readonly totalBeforeMicroUsd: bigint;
}

const cargoWorkspace = fileURLToPath(new URL("../../../../contracts/wager-escrow/", import.meta.url));

function sandboxAddress(kind: "escrow" | "rake", denom: string): string {
  return `sandbox-${kind}:${denom}`;
}

function balanceOf(balances: SandboxBalances, address: string): bigint {
  return balances.get(address) ?? 0n;
}

function totalBalance(balances: SandboxBalances): bigint {
  let total = 0n;
  for (const [address, balance] of balances) {
    if (balance < 0n) throw new Error(`NEGATIVE_BALANCE:${address}`);
    total += balance;
  }
  return total;
}

function validateBridgeInput(input: FundedEscrowInput): BridgeContext {
  if (!input.principal) throw new Error("PRINCIPAL_REQUIRED");
  if (!input.opponent) throw new Error("OPPONENT_REQUIRED");
  if (!input.denom || /[|\r\n]/.test(input.denom)) throw new Error("INVALID_DENOM");
  if (input.principal === input.opponent) throw new Error("SAME_PLAYER");
  if (input.stakePerPointMicroUsd <= 0n) throw new Error("STAKE_PER_POINT_MUST_BE_POSITIVE");

  const escrowAddress = input.escrowAddress ?? sandboxAddress("escrow", input.denom);
  const rakeRecipient = input.rakeRecipient ?? sandboxAddress("rake", input.denom);
  if (
    !escrowAddress ||
    !rakeRecipient ||
    escrowAddress === input.principal ||
    escrowAddress === input.opponent ||
    escrowAddress === rakeRecipient ||
    rakeRecipient === input.principal ||
    rakeRecipient === input.opponent
  ) throw new Error("SANDBOX_ESCROW_ACCOUNTS_MUST_BE_DISTINCT");
  if (balanceOf(input.balances, escrowAddress) !== 0n) throw new Error("ESCROW_BALANCE_NOT_EMPTY");

  return { escrowAddress, rakeRecipient, totalBeforeMicroUsd: totalBalance(input.balances) };
}

function resultAmount(fields: ReadonlyMap<string, string>, name: string): bigint {
  const raw = fields.get(name);
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`SANDBOX_ESCROW_BRIDGE_INVALID_${name.toUpperCase()}`);
  return BigInt(raw);
}

function parseBridgeResult(output: string): BridgeResult {
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith("SANDBOX_ESCROW_RESULT|"));
  if (!resultLine) throw new Error("SANDBOX_ESCROW_BRIDGE_RESULT_MISSING");
  const fields = new Map<string, string>();
  for (const field of resultLine.split("|").slice(1)) {
    const separator = field.indexOf("=");
    if (separator < 1 || fields.has(field.slice(0, separator))) throw new Error("SANDBOX_ESCROW_BRIDGE_RESULT_INVALID");
    fields.set(field.slice(0, separator), field.slice(separator + 1));
  }
  return {
    principalBalanceMicroUsd: resultAmount(fields, "principal"),
    opponentBalanceMicroUsd: resultAmount(fields, "opponent"),
    rakeBalanceMicroUsd: resultAmount(fields, "rake"),
    escrowBalanceMicroUsd: resultAmount(fields, "escrow"),
    reservePerPlayerMicroUsd: resultAmount(fields, "reserve"),
    liabilityMicroUsd: resultAmount(fields, "liability"),
    rakeMicroUsd: resultAmount(fields, "rake_amount"),
    winnerPayoutMicroUsd: resultAmount(fields, "winner_payout"),
    loserPayoutMicroUsd: resultAmount(fields, "loser_payout"),
  };
}

function bridgeErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const output = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  const stderr = output.stderr?.toString().trim();
  const stdout = output.stdout?.toString().trim();
  return stderr || stdout || output.message || "unknown bridge failure";
}

function executeMultiTest(input: SandboxEscrowInput, context: BridgeContext): BridgeResult {
  let winner = "principal";
  if (input.terminal === "settlement") {
    if (input.winner === input.principal) winner = "principal";
    else if (input.winner === input.opponent) winner = "opponent";
    else throw new Error("INVALID_WINNER");
  }
  const fixture = [
    input.terminal,
    balanceOf(input.balances, input.principal),
    balanceOf(input.balances, input.opponent),
    balanceOf(input.balances, context.rakeRecipient),
    input.stakePerPointMicroUsd,
    input.cubeCap,
    input.rakeBps,
    input.terminal === "settlement" ? input.cubeValue : 1,
    input.terminal === "settlement" ? input.resultMultiplier : 1,
    input.terminal === "settlement" ? input.cubeWasTurned : false,
    winner,
    input.denom,
  ].join("|");
  try {
    return parseBridgeResult(execFileSync(
      "cargo",
      ["test", "--locked", "tests::multitest_bridge_from_environment", "--", "--exact", "--nocapture"],
      {
        cwd: cargoWorkspace,
        encoding: "utf8",
        env: { ...process.env, SANDBOX_ESCROW_BRIDGE_INPUT: fixture },
      },
    ));
  } catch (error) {
    throw new Error(`SANDBOX_ESCROW_MULTITEST_FAILED: ${bridgeErrorOutput(error)}`);
  }
}

function applyBridgeResult(input: FundedEscrowInput, context: BridgeContext, result: BridgeResult): bigint {
  const initialPrincipal = balanceOf(input.balances, input.principal);
  const initialOpponent = balanceOf(input.balances, input.opponent);
  const initialRake = balanceOf(input.balances, context.rakeRecipient);
  const projectedTotal = context.totalBeforeMicroUsd -
    initialPrincipal -
    initialOpponent -
    initialRake +
    result.principalBalanceMicroUsd +
    result.opponentBalanceMicroUsd +
    result.rakeBalanceMicroUsd +
    result.escrowBalanceMicroUsd;
  if (projectedTotal !== context.totalBeforeMicroUsd) throw new Error("ESCROW_CONSERVATION_FAILED");

  input.balances.set(input.principal, result.principalBalanceMicroUsd);
  input.balances.set(input.opponent, result.opponentBalanceMicroUsd);
  input.balances.set(context.rakeRecipient, result.rakeBalanceMicroUsd);
  input.balances.set(context.escrowAddress, result.escrowBalanceMicroUsd);
  return totalBalance(input.balances);
}

function bridgedSettlement(input: FundedSettlementInput): EscrowSettlementOutcome {
  const context = validateBridgeInput(input);
  const result = executeMultiTest({ ...input, terminal: "settlement" }, context);
  const totalAfterMicroUsd = applyBridgeResult(input, context, result);
  return {
    denom: input.denom,
    reservePerPlayerMicroUsd: result.reservePerPlayerMicroUsd,
    liabilityMicroUsd: result.liabilityMicroUsd,
    rakeMicroUsd: result.rakeMicroUsd,
    winnerPayoutMicroUsd: result.winnerPayoutMicroUsd,
    loserRefundMicroUsd: result.loserPayoutMicroUsd,
    winnerBalanceMicroUsd: input.winner === input.principal
      ? result.principalBalanceMicroUsd
      : result.opponentBalanceMicroUsd,
    opponentBalanceMicroUsd: result.opponentBalanceMicroUsd,
    rakeRecipient: context.rakeRecipient,
    rakeRecipientBalanceMicroUsd: result.rakeBalanceMicroUsd,
    escrowAddress: context.escrowAddress,
    escrowBalanceMicroUsd: result.escrowBalanceMicroUsd,
    totalBeforeMicroUsd: context.totalBeforeMicroUsd,
    totalAfterMicroUsd,
  };
}

function bridgedRefund(input: FundedRefundInput): EscrowRefundOutcome {
  const context = validateBridgeInput(input);
  const result = executeMultiTest({ ...input, terminal: "refund" }, context);
  const totalAfterMicroUsd = applyBridgeResult(input, context, result);
  return {
    denom: input.denom,
    reservePerPlayerMicroUsd: result.reservePerPlayerMicroUsd,
    principalBalanceMicroUsd: result.principalBalanceMicroUsd,
    opponentBalanceMicroUsd: result.opponentBalanceMicroUsd,
    rakeRecipient: context.rakeRecipient,
    rakeRecipientBalanceMicroUsd: result.rakeBalanceMicroUsd,
    escrowAddress: context.escrowAddress,
    escrowBalanceMicroUsd: result.escrowBalanceMicroUsd,
    totalBeforeMicroUsd: context.totalBeforeMicroUsd,
    totalAfterMicroUsd,
  };
}

/** Runs the real cw-multi-test escrow contract and applies its observed balances to the shared sandbox wallet state. */
export function runSandboxEscrow(input: SandboxEscrowInput): SandboxEscrowOutcome {
  return input.terminal === "settlement" ? bridgedSettlement(input) : bridgedRefund(input);
}

export function settleFundedEscrow(input: FundedSettlementInput): EscrowSettlementOutcome {
  return bridgedSettlement(input);
}

export function refundFundedEscrow(input: FundedRefundInput): EscrowRefundOutcome {
  return bridgedRefund(input);
}
