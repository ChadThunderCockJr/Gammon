import { describe, expect, it, vi } from "vitest";

vi.mock("../game-store.js", () => ({
  commitGameCommand: vi.fn(),
  expireOrphanWaitingGames: vi.fn(),
  finishGame: vi.fn(),
  loadActiveGames: vi.fn(),
  loadCurrentGameForParticipant: vi.fn(),
  loadGame: vi.fn(),
  loadGameForParticipant: vi.fn(),
  persistDiceRoll: vi.fn(),
  persistGame: vi.fn(),
  persistMove: vi.fn(),
  renewGameOwnership: vi.fn().mockResolvedValue(true),
  replayGameCommand: vi.fn().mockResolvedValue(null),
}));

vi.mock("../redis.js", () => ({ getRedis: vi.fn(() => null) }));

import { GameManager } from "../game-manager.js";

describe("GameManager move rejection", () => {
  it("does not retain an undo snapshot or mutate the revision for an illegal move", async () => {
    const manager = new GameManager();
    const game = manager.createGame(0);
    game.status = "playing";
    game.phase = "playing_moves";
    game.playerWhite = {
      address: "white",
      rating: 1500,
      connectedAt: Date.now(),
      ws: { readyState: 3 } as never,
    };
    game.gameState = {
      ...game.gameState,
      dice: [1, 2],
      movesRemaining: [1, 2],
    };
    const initialState = game.gameState;

    await expect(manager.applyMoveLocked(game.id, "white", 25, 25, {
      commandId: "bd805bc9-8ddc-4f2a-9584-b9d153b6478f",
      expectedRevision: 0,
      commandType: "move",
    })).resolves.toBeNull();

    expect(game.gameState).toBe(initialState);
    expect(game.revision).toBe(0);
    expect(game.turnMoveStack).toEqual([]);
    game.status = "finished";
    manager.releaseTerminalGame(game.id);
  });
});
