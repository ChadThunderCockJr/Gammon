import { afterEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("../db.js", () => ({ getPool: databaseMock.getPool }));

import { getProfile, getStats, listModerationReports } from "../social-store-pg.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("durable social reads", () => {
  it("reports database outages instead of fabricating an empty profile or zero stats", async () => {
    databaseMock.getPool.mockReturnValue(null);

    await expect(getProfile("xion1player")).rejects.toThrow("SOCIAL_STORE_UNAVAILABLE");
    await expect(getStats("xion1player")).rejects.toThrow("SOCIAL_STORE_UNAVAILABLE");
  });

  it("keeps a real no-games record distinct from an outage", async () => {
    databaseMock.getPool.mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    await expect(getStats("xion1newplayer")).resolves.toEqual({
      wins: 0,
      losses: 0,
      totalGames: 0,
      currentStreak: 0,
      currentStreakType: "",
      bestStreak: 0,
      totalGammons: 0,
      totalBackgammons: 0,
    });
  });

  it("exposes immutable backup-restoration status to moderation operations without a narrative", async () => {
    databaseMock.getPool.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: "5eef3a29-304e-46cd-9ec5-08b84489cfbb",
          reporter: "xion1reporter",
          target: "xion1target",
          category: "harassment",
          descriptionEncrypted: null,
          narrativeReconciliationOutcome: "backup_restore_required",
          state: "open",
          claimedBy: null,
          claimedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionCode: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }],
      }),
    });

    await expect(listModerationReports({ limit: 1 })).resolves.toEqual([expect.objectContaining({
      description: null,
      narrativeStatus: "backup_restore_required",
    })]);
  });
});
