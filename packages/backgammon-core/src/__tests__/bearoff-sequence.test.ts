import { describe, it, expect } from "vitest";
import { generateAllMoveSequences } from "../moves";
import { createInitialBoard } from "../board";

describe("Black bearing off sequence ordering", () => {
  it("can bear off from 23 and 24 with dice [6,4] by choosing correct order", () => {
    const board = createInitialBoard();
    for (let i = 0; i <= 25; i++) board.points[i] = 0;
    board.whiteOff = 15;
    board.blackOff = 10;
    board.points[23] = -2;
    board.points[24] = -3;

    const seqs = generateAllMoveSequences(board, "black", [6, 4]);

    // Should find at least one sequence that bears off 2 checkers
    const bearOffTwo = seqs.filter(seq =>
      seq.length === 2 &&
      seq.every(m => m.to === 25)
    );
    expect(bearOffTwo.length).toBeGreaterThan(0);
  });

  it("can bear off from 23 with die 4 when 24 is empty", () => {
    const board = createInitialBoard();
    for (let i = 0; i <= 25; i++) board.points[i] = 0;
    board.whiteOff = 15;
    board.blackOff = 14;
    board.points[23] = -1;

    const seqs = generateAllMoveSequences(board, "black", [4]);
    // 23 + 4 = 27 > 25, over-bearing. No checker on 24. Should be legal.
    const bearOff = seqs.filter(seq => seq.some(m => m.from === 23 && m.to === 25));
    expect(bearOff.length).toBeGreaterThan(0);
  });

  it("can over-bear from 23 with die 4 when 24 has a checker", () => {
    const board = createInitialBoard();
    for (let i = 0; i <= 25; i++) board.points[i] = 0;
    board.whiteOff = 15;
    board.blackOff = 13;
    board.points[23] = -1;
    board.points[24] = -1;

    // Point 24 is closer to black's bearing-off edge, so point 23 remains the
    // farthest occupied point and may use the oversized die.
    const seqs = generateAllMoveSequences(board, "black", [4]);
    const bearOffFrom23 = seqs.filter(seq => seq.some(m => m.from === 23 && m.to === 25));
    expect(bearOffFrom23.length).toBeGreaterThan(0);
  });
});
