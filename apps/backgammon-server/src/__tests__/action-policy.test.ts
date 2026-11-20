import { afterEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("../db.js", () => ({ getPool: databaseMock.getPool }));

import { requestRestrictionLimitChange } from "../action-policy.js";

function restrictionRow(overrides: Record<string, unknown> = {}) {
  return {
    self_excluded_until: null,
    cooling_off_until: null,
    deposit_limit_micro_usd: null,
    wager_limit_micro_usd: null,
    daily_wager_limit_micro_usd: null,
    daily_loss_limit_micro_usd: null,
    pending_increase: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("responsible-play limit decisions", () => {

  it("applies a lower limit immediately and clears a pending increase of that type", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT *")) {
          return { rows: [restrictionRow({ daily_wager_limit_micro_usd: "1000" })] };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    databaseMock.getPool.mockReturnValue({ connect: async () => client });

    const result = await requestRestrictionLimitChange({
      principal: "xion1player",
      type: "daily_wager_limit",
      amountMicroUsd: "500",
    });

    expect(result).toEqual({ appliedImmediately: true, effectiveAt: null });
  });

  it("delays a higher limit for exactly 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-05-01T12:00:00.000Z"));
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT *")) {
          return { rows: [restrictionRow({ daily_loss_limit_micro_usd: "1000" })] };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    databaseMock.getPool.mockReturnValue({ connect: async () => client });

    const result = await requestRestrictionLimitChange({
      principal: "xion1player",
      type: "daily_loss_limit",
      amountMicroUsd: "1500",
    });

    expect(result).toEqual({
      appliedImmediately: false,
      effectiveAt: "2028-05-02T12:00:00.000Z",
    });
  });
});
