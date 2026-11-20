import { describe, expect, it } from "vitest";
import { generateAllMoveSequences } from "../moves";
import type { BoardState, Move, Player } from "../types";

function bearingBoard(player: Player, source: number, blocker: number | null): BoardState {
  const points = Array<number>(26).fill(0);
  points[source] = player === "white" ? 1 : -1;
  if (blocker !== null) points[blocker] = player === "white" ? 1 : -1;
  return {
    points,
    whiteOff: player === "white" ? 14 - (blocker === null ? 0 : 1) : 15,
    blackOff: player === "black" ? 14 - (blocker === null ? 0 : 1) : 15,
  };
}

function hasMove(moves: Move[][], from: number, to: number): boolean {
  return moves.some((sequence) => sequence.some((move) => move.from === from && move.to === to));
}

describe("mirrored over-bearing", () => {
  it("blocks an over-bear when a farther checker remains", () => {
    const white = bearingBoard("white", 2, 4);
    const black = bearingBoard("black", 23, 21);

    expect(hasMove(generateAllMoveSequences(white, "white", [6]), 2, 0)).toBe(false);
    expect(hasMove(generateAllMoveSequences(black, "black", [6]), 23, 25)).toBe(false);
  });

  it("allows an over-bear when only closer checkers remain", () => {
    const white = bearingBoard("white", 2, 1);
    const black = bearingBoard("black", 23, 24);

    expect(hasMove(generateAllMoveSequences(white, "white", [6]), 2, 0)).toBe(true);
    expect(hasMove(generateAllMoveSequences(black, "black", [6]), 23, 25)).toBe(true);
  });
});
