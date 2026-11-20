export const MICRO_USD_PER_DOLLAR = 1_000_000n;
export const MICRO_USD_PER_CENT = 10_000n;
export const DEFAULT_CUBE_CAP = 8 as const;
export const MAX_STAKE_MICRO_USD = 10_000n * MICRO_USD_PER_DOLLAR;

export type MicroUsd = bigint & { readonly __microUsd: unique symbol };
export type ResultMultiplier = 1 | 2 | 3;
export type CubeValue = 1 | 2 | 4 | 8;

export interface CashGameRules {
  readonly version: "cash-v1";
  readonly cubeCap: CubeValue;
  readonly jacoby: true;
  readonly beavers: false;
  readonly raccoons: false;
  readonly automaticDoubles: false;
  readonly doubleOfferPhase: "before_roll";
  readonly openingRollPolicy: "single_future_beacon_assigns_one_die_per_color";
  readonly turnTimeLimitSeconds: number;
  readonly doubleResponseSeconds: number;
  readonly resignationPolicy: "normal_immediate_higher_requires_acceptance";
  readonly resignationResponseSeconds: number;
  readonly turnTimeoutPolicy: "pause_then_review";
  readonly rakeBps: number;
  readonly rakeCapMicroUsd: MicroUsd;
  readonly disconnectGraceSeconds: number;
  readonly disconnectCheckIntervalMs: number;
  readonly disconnectPolicy: "pause_then_review";
  readonly proofFailurePolicy: "pause_then_refund_or_review";
  readonly rakeRounding: "floor_micro_usd";
}

export const CASH_GAME_RULES_V1: CashGameRules = Object.freeze({
  version: "cash-v1",
  cubeCap: DEFAULT_CUBE_CAP,
  jacoby: true,
  beavers: false,
  raccoons: false,
  automaticDoubles: false,
  doubleOfferPhase: "before_roll",
  openingRollPolicy: "single_future_beacon_assigns_one_die_per_color",
  turnTimeLimitSeconds: 60,
  doubleResponseSeconds: 30,
  resignationPolicy: "normal_immediate_higher_requires_acceptance",
  resignationResponseSeconds: 30,
  turnTimeoutPolicy: "pause_then_review",
  rakeBps: 0,
  rakeCapMicroUsd: 0n as MicroUsd,
  disconnectGraceSeconds: 30,
  disconnectCheckIntervalMs: 5_000,
  disconnectPolicy: "pause_then_review",
  proofFailurePolicy: "pause_then_refund_or_review",
  rakeRounding: "floor_micro_usd",
});

export interface CashSettlement {
  readonly stakeMicroUsd: MicroUsd;
  readonly reservePerPlayerMicroUsd: MicroUsd;
  readonly liabilityMicroUsd: MicroUsd;
  readonly rakeMicroUsd: MicroUsd;
  readonly winnerPayoutMicroUsd: MicroUsd;
  readonly loserRefundMicroUsd: MicroUsd;
  readonly totalDepositedMicroUsd: MicroUsd;
}

function asMicroUsd(value: bigint): MicroUsd {
  if (value < 0n) throw new RangeError("Money amount cannot be negative");
  return value as MicroUsd;
}

function checkedMultiply(left: bigint, right: bigint, label: string): bigint {
  if (left < 0n || right < 0n) throw new RangeError(`${label} cannot use negative values`);
  const result = left * right;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) * MICRO_USD_PER_DOLLAR) {
    throw new RangeError(`${label} exceeds the supported amount`);
  }
  return result;
}

/** Parse a dollar amount entered by a person. Cash-game stakes use whole cents. */
export function parseUsdToMicroUsd(input: string): MicroUsd {
  const normalized = input.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) {
    throw new RangeError("Enter a non-negative dollar amount with at most two decimal places");
  }

  const dollars = BigInt(match[1]);
  const cents = BigInt((match[2] ?? "").padEnd(2, "0"));
  const amount = dollars * MICRO_USD_PER_DOLLAR + cents * MICRO_USD_PER_CENT;
  if (amount > MAX_STAKE_MICRO_USD) throw new RangeError("Amount exceeds the supported maximum");
  return asMicroUsd(amount);
}

/** Parse an exact on-chain micro-verUSD integer. Fractions and exponents are rejected. */
export function parseMicroUsd(input: string): MicroUsd {
  if (!/^(0|[1-9]\d*)$/.test(input)) throw new RangeError("Amount must be an unsigned integer");
  return asMicroUsd(BigInt(input));
}

export function formatMicroUsd(amount: bigint, options: { symbol?: boolean } = {}): string {
  if (amount < 0n) return `-${formatMicroUsd(-amount, options)}`;
  const dollars = amount / MICRO_USD_PER_DOLLAR;
  const cents = (amount % MICRO_USD_PER_DOLLAR) / MICRO_USD_PER_CENT;
  return `${options.symbol === false ? "" : "$"}${dollars}.${cents.toString().padStart(2, "0")}`;
}

export function assertCashStake(stake: bigint): asserts stake is MicroUsd {
  if (stake <= 0n) throw new RangeError("Cash-game stake must be positive");
  if (stake % MICRO_USD_PER_CENT !== 0n) throw new RangeError("Cash-game stake must use whole cents");
  if (stake > MAX_STAKE_MICRO_USD) throw new RangeError("Cash-game stake exceeds the supported maximum");
}

export function assertCubeValue(cube: number, cubeCap: CubeValue = DEFAULT_CUBE_CAP): asserts cube is CubeValue {
  if (![1, 2, 4, 8].includes(cube) || cube > cubeCap) {
    throw new RangeError(`Cube must be a power of two no greater than ${cubeCap}`);
  }
}

export function maximumReserve(stake: bigint, rules: CashGameRules = CASH_GAME_RULES_V1): MicroUsd {
  assertCashStake(stake);
  return asMicroUsd(checkedMultiply(stake, BigInt(3 * rules.cubeCap), "Maximum reserve"));
}

export function effectiveResultMultiplier(
  result: ResultMultiplier,
  cube: CubeValue,
  cubeWasTurned: boolean,
  rules: CashGameRules = CASH_GAME_RULES_V1,
): ResultMultiplier {
  assertCubeValue(cube, rules.cubeCap);
  if (rules.jacoby && !cubeWasTurned && cube === 1) return 1;
  return result;
}

export function cashLiability(
  stake: bigint,
  cube: CubeValue,
  result: ResultMultiplier,
  cubeWasTurned: boolean,
  rules: CashGameRules = CASH_GAME_RULES_V1,
): MicroUsd {
  assertCashStake(stake);
  assertCubeValue(cube, rules.cubeCap);
  if (![1, 2, 3].includes(result)) throw new RangeError("Result multiplier must be normal, gammon, or backgammon");
  const effective = effectiveResultMultiplier(result, cube, cubeWasTurned, rules);
  return asMicroUsd(checkedMultiply(stake, BigInt(cube * effective), "Cash-game liability"));
}

/**
 * Settle two equal maximum reserves. The winner gets their reserve plus the
 * loser's liability less rake; the loser receives every unused microdollar.
 */
export function settleCashGame(
  stake: bigint,
  cube: CubeValue,
  result: ResultMultiplier,
  cubeWasTurned: boolean,
  rules: CashGameRules = CASH_GAME_RULES_V1,
): CashSettlement {
  const reserve = maximumReserve(stake, rules);
  const liability = cashLiability(stake, cube, result, cubeWasTurned, rules);
  if (liability > reserve) throw new RangeError("Liability exceeds the prefunded reserve");

  const uncappedRake = checkedMultiply(liability, BigInt(rules.rakeBps), "Rake") / 10_000n;
  const rake = asMicroUsd(
    rules.rakeCapMicroUsd > 0n && uncappedRake > rules.rakeCapMicroUsd
      ? rules.rakeCapMicroUsd
      : uncappedRake,
  );
  const winnerPayout = asMicroUsd(reserve + liability - rake);
  const loserRefund = asMicroUsd(reserve - liability);
  const totalDeposited = asMicroUsd(reserve * 2n);

  if (winnerPayout + loserRefund + rake !== totalDeposited) {
    throw new Error("Cash settlement does not conserve deposits");
  }

  return {
    stakeMicroUsd: asMicroUsd(stake),
    reservePerPlayerMicroUsd: reserve,
    liabilityMicroUsd: liability,
    rakeMicroUsd: rake,
    winnerPayoutMicroUsd: winnerPayout,
    loserRefundMicroUsd: loserRefund,
    totalDepositedMicroUsd: totalDeposited,
  };
}

export function parseCashGameRules(snapshot: unknown): CashGameRules {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Cash rules snapshot must be an object");
  }
  const rules = snapshot as Record<string, unknown>;
  const positiveInteger = (value: unknown, field: string, maximum: number): number => {
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
      throw new TypeError(`Invalid cash rule ${field}`);
    }
    return value as number;
  };
  if (
    rules.version !== "cash-v1" ||
    rules.cubeCap !== 8 ||
    rules.jacoby !== true ||
    rules.beavers !== false ||
    rules.raccoons !== false ||
    rules.automaticDoubles !== false ||
    rules.doubleOfferPhase !== "before_roll" ||
    rules.openingRollPolicy !== "single_future_beacon_assigns_one_die_per_color" ||
    rules.resignationPolicy !== "normal_immediate_higher_requires_acceptance" ||
    rules.turnTimeoutPolicy !== "pause_then_review" ||
    rules.disconnectPolicy !== "pause_then_review" ||
    rules.proofFailurePolicy !== "pause_then_refund_or_review" ||
    rules.rakeRounding !== "floor_micro_usd" ||
    !Number.isSafeInteger(rules.rakeBps) ||
    (rules.rakeBps as number) < 0 ||
    typeof rules.rakeCapMicroUsd !== "string" ||
    !/^\d+$/.test(rules.rakeCapMicroUsd)
  ) throw new TypeError("Invalid cash rules snapshot");

  return Object.freeze({
    version: "cash-v1",
    cubeCap: 8,
    jacoby: true,
    beavers: false,
    raccoons: false,
    automaticDoubles: false,
    doubleOfferPhase: "before_roll",
    openingRollPolicy: "single_future_beacon_assigns_one_die_per_color",
    turnTimeLimitSeconds: positiveInteger(rules.turnTimeLimitSeconds, "turnTimeLimitSeconds", 3_600),
    doubleResponseSeconds: positiveInteger(rules.doubleResponseSeconds, "doubleResponseSeconds", 600),
    resignationPolicy: "normal_immediate_higher_requires_acceptance",
    resignationResponseSeconds: positiveInteger(rules.resignationResponseSeconds, "resignationResponseSeconds", 600),
    turnTimeoutPolicy: "pause_then_review",
    rakeBps: rules.rakeBps as number,
    rakeCapMicroUsd: BigInt(rules.rakeCapMicroUsd) as MicroUsd,
    disconnectGraceSeconds: positiveInteger(rules.disconnectGraceSeconds, "disconnectGraceSeconds", 3_600),
    disconnectCheckIntervalMs: positiveInteger(rules.disconnectCheckIntervalMs, "disconnectCheckIntervalMs", 60_000),
    disconnectPolicy: "pause_then_review",
    proofFailurePolicy: "pause_then_refund_or_review",
    rakeRounding: "floor_micro_usd",
  });
}

export function serializeCashGameRules(rules: CashGameRules = CASH_GAME_RULES_V1): string {
  return JSON.stringify({
    automaticDoubles: rules.automaticDoubles,
    beavers: rules.beavers,
    cubeCap: rules.cubeCap,
    disconnectCheckIntervalMs: rules.disconnectCheckIntervalMs,
    disconnectGraceSeconds: rules.disconnectGraceSeconds,
    doubleOfferPhase: rules.doubleOfferPhase,
    doubleResponseSeconds: rules.doubleResponseSeconds,
    disconnectPolicy: rules.disconnectPolicy,
    jacoby: rules.jacoby,
    openingRollPolicy: rules.openingRollPolicy,
    proofFailurePolicy: rules.proofFailurePolicy,
    rakeRounding: rules.rakeRounding,
    raccoons: rules.raccoons,
    resignationPolicy: rules.resignationPolicy,
    resignationResponseSeconds: rules.resignationResponseSeconds,
    rakeBps: rules.rakeBps,
    rakeCapMicroUsd: rules.rakeCapMicroUsd.toString(),
    turnTimeLimitSeconds: rules.turnTimeLimitSeconds,
    turnTimeoutPolicy: rules.turnTimeoutPolicy,
    version: rules.version,
  });
}
