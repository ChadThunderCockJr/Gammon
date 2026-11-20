import { describe, it, expect } from "vitest";
import {
  BoardState,
  GameState,
  Player,
  WHITE_BAR,
  BLACK_BAR,
  TOTAL_CHECKERS,
  createInitialBoard,
  cloneBoard,
  canBearOff,
  getCheckerCount,
  isPointBlocked,
  countCheckersOnBoard,
  createGameState,
  setDice,
  makeMove,
  endTurn,
  hasLegalMoves,
  checkGameOver,
  generateAllMoveSequences,
  getLegalFirstMoves,
  applySingleMove,
} from "../index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a custom BoardState from a sparse description.
 * Keys are point indices (0 = white bar, 25 = black bar, 1-24 = points).
 * Positive values = white checkers, negative = black checkers.
 * Points not listed default to 0.
 *
 * whiteOff / blackOff are computed so totals reach 15 unless explicitly
 * provided via the special keys "whiteOff" and "blackOff" in the setup.
 */
function makeBoard(
  setup: Record<number, number>,
  opts?: { whiteOff?: number; blackOff?: number }
): BoardState {
  const points = new Array(26).fill(0);
  for (const [key, count] of Object.entries(setup)) {
    const idx = Number(key);
    points[idx] = count;
  }

  // Count how many are on the board
  let whiteOnBoard = 0;
  let blackOnBoard = 0;
  for (let i = 0; i <= 25; i++) {
    if (points[i] > 0) whiteOnBoard += points[i];
    if (points[i] < 0) blackOnBoard += -points[i];
  }

  const whiteOff = opts?.whiteOff ?? TOTAL_CHECKERS - whiteOnBoard;
  const blackOff = opts?.blackOff ?? TOTAL_CHECKERS - blackOnBoard;

  return { points, whiteOff, blackOff };
}

/** Create a GameState with selective overrides. */
function makeState(overrides: Partial<GameState>): GameState {
  return {
    ...createGameState(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Board Setup Tests
// ---------------------------------------------------------------------------

describe("Board Setup", () => {
  it("createGameState returns valid initial state", () => {
    const state = createGameState();
    expect(state.currentPlayer).toBe("white");
    expect(state.dice).toBeNull();
    expect(state.movesRemaining).toEqual([]);
    expect(state.gameOver).toBe(false);
    expect(state.winner).toBeNull();
    expect(state.resultType).toBeNull();
    expect(state.turnNumber).toBe(0);
    expect(state.moveHistory).toEqual([]);
  });

  it("initial board has 15 white checkers in the correct positions", () => {
    const board = createInitialBoard();
    // White positions: 24(2), 13(5), 8(3), 6(5)
    expect(board.points[24]).toBe(2);
    expect(board.points[13]).toBe(5);
    expect(board.points[8]).toBe(3);
    expect(board.points[6]).toBe(5);

    const whiteCount = countCheckersOnBoard(board, "white");
    expect(whiteCount).toBe(15);
    expect(board.whiteOff).toBe(0);
  });

  it("initial board has 15 black checkers in the correct positions", () => {
    const board = createInitialBoard();
    // Black positions: 1(-2), 12(-5), 17(-3), 19(-5)
    expect(board.points[1]).toBe(-2);
    expect(board.points[12]).toBe(-5);
    expect(board.points[17]).toBe(-3);
    expect(board.points[19]).toBe(-5);

    const blackCount = countCheckersOnBoard(board, "black");
    expect(blackCount).toBe(15);
    expect(board.blackOff).toBe(0);
  });

  it("initial board has no game over", () => {
    const board = createInitialBoard();
    const result = checkGameOver(board);
    expect(result.over).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.resultType).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Move Validation Tests
// ---------------------------------------------------------------------------

describe("Move Validation", () => {
  it("white can move from point 24 with die 1 to point 23", () => {
    const state = createGameState();
    const withDice = setDice(state, 1, 2);
    const moves = getLegalFirstMoves(
      withDice.board,
      withDice.currentPlayer,
      withDice.movesRemaining
    );
    const move24to23 = moves.find((m) => m.from === 24 && m.to === 23);
    expect(move24to23).toBeDefined();
    expect(move24to23!.die).toBe(1);
  });

  it("black can move from point 1 with die 1 to point 2", () => {
    // Set up a state where it is black's turn
    const state = makeState({ currentPlayer: "black" });
    const withDice = setDice(state, 1, 2);
    const moves = getLegalFirstMoves(
      withDice.board,
      "black",
      withDice.movesRemaining
    );
    const move1to2 = moves.find((m) => m.from === 1 && m.to === 2);
    expect(move1to2).toBeDefined();
    expect(move1to2!.die).toBe(1);
  });

  it("cannot move to a point blocked by 2+ opponent checkers", () => {
    // White tries to move to a point with 2+ black checkers
    // Point 19 has -5 (five black checkers) in the initial setup
    // White on point 24, die 5 → to point 19 (blocked)
    const state = createGameState();
    const withDice = setDice(state, 5, 6);
    const moves = getLegalFirstMoves(
      withDice.board,
      "white",
      withDice.movesRemaining
    );
    const move24to19 = moves.find((m) => m.from === 24 && m.to === 19);
    expect(move24to19).toBeUndefined();
  });

  it("must enter from bar before making other moves", () => {
    // White has a checker on the bar + checkers on point 6
    const board = makeBoard({ 0: 1, 6: 5, 13: 5, 8: 3, 24: 1 });
    const sequences = generateAllMoveSequences(board, "white", [3, 5]);
    // Every sequence's first move must be from bar (point 0)
    for (const seq of sequences) {
      if (seq.length > 0) {
        expect(seq[0].from).toBe(WHITE_BAR);
      }
    }
  });

  it("white bar entry: from=0, die=3 enters to point 22", () => {
    const board = makeBoard({ 0: 1, 6: 5, 13: 5, 8: 3, 24: 1 });
    const sequences = generateAllMoveSequences(board, "white", [3, 5]);
    const barEntryWith3 = sequences.some(
      (seq) =>
        seq.length > 0 &&
        seq[0].from === WHITE_BAR &&
        seq[0].to === 22 &&
        seq[0].die === 3
    );
    expect(barEntryWith3).toBe(true);
  });

  it("black bar entry: from=25, die=3 enters to point 3", () => {
    const board = makeBoard({ 25: -1, 19: -5, 17: -3, 12: -5, 1: -1 });
    const sequences = generateAllMoveSequences(board, "black", [3, 5]);
    const barEntryWith3 = sequences.some(
      (seq) =>
        seq.length > 0 &&
        seq[0].from === BLACK_BAR &&
        seq[0].to === 3 &&
        seq[0].die === 3
    );
    expect(barEntryWith3).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bearing Off Tests
// ---------------------------------------------------------------------------

describe("Bearing Off", () => {
  it("cannot bear off until all checkers are in the home board", () => {
    // White has a checker outside home board (point 13) and one on point 1
    const board = makeBoard({ 1: 1, 13: 1 }, { whiteOff: 13 });
    expect(canBearOff(board, "white")).toBe(false);

    const sequences = generateAllMoveSequences(board, "white", [1, 2]);
    // No bearing off move should appear
    const hasBearOff = sequences.some((seq) =>
      seq.some((m) => m.to === 0)
    );
    expect(hasBearOff).toBe(false);
  });

  it("white bears off from point 1 with die 1 to point 0", () => {
    // White: all 2 remaining checkers on point 1
    const board = makeBoard({ 1: 2 }, { whiteOff: 13, blackOff: 0 });
    // Need black somewhere valid
    board.points[19] = -5;
    board.points[20] = -5;
    board.points[21] = -5;

    const sequences = generateAllMoveSequences(board, "white", [1, 2]);
    const hasBearOff = sequences.some((seq) =>
      seq.some((m) => m.from === 1 && m.to === 0 && m.die === 1)
    );
    expect(hasBearOff).toBe(true);
  });

  it("black bears off from point 24 with die 1 to point 25", () => {
    // Black: 2 remaining checkers on point 24
    const board = makeBoard({ 24: -2 }, { blackOff: 13, whiteOff: 0 });
    board.points[1] = 5;
    board.points[2] = 5;
    board.points[3] = 5;

    const sequences = generateAllMoveSequences(board, "black", [1, 2]);
    const hasBearOff = sequences.some((seq) =>
      seq.some((m) => m.from === 24 && m.to === 25 && m.die === 1)
    );
    expect(hasBearOff).toBe(true);
  });

  it("white over-bearing: checker on point 2, die 6, no checker on 3-6 is legal", () => {
    const board = makeBoard({ 2: 1, 1: 1 }, { whiteOff: 13, blackOff: 0 });
    board.points[24] = -15; // put all black checkers somewhere

    const sequences = generateAllMoveSequences(board, "white", [6, 1]);
    // Should find a sequence where white bears off from point 2 with die 6
    const hasBearOffFrom2 = sequences.some((seq) =>
      seq.some((m) => m.from === 2 && m.to === 0 && m.die === 6)
    );
    expect(hasBearOffFrom2).toBe(true);
  });

  it("white over-bearing: checker on point 2, die 6, checker on point 5 is illegal", () => {
    const board = makeBoard({ 2: 1, 5: 1 }, { whiteOff: 13, blackOff: 0 });
    board.points[24] = -15;

    const sequences = generateAllMoveSequences(board, "white", [6, 1]);
    // Should NOT find over-bearing from point 2 with die 6
    const hasBearOffFrom2WithDie6 = sequences.some((seq) =>
      seq.some((m) => m.from === 2 && m.to === 0 && m.die === 6)
    );
    expect(hasBearOffFrom2WithDie6).toBe(false);
  });

  it("black over-bearing: checker on point 23, die 6, no checker on 19-22 is legal", () => {
    // Black has a single checker on point 23 and one on point 24; rest borne off
    const board = makeBoard({ 23: -1, 24: -1 }, { blackOff: 13, whiteOff: 0 });
    board.points[1] = 15; // put all white checkers somewhere

    const sequences = generateAllMoveSequences(board, "black", [6, 1]);
    const hasBearOffFrom23 = sequences.some((seq) =>
      seq.some((m) => m.from === 23 && m.to === 25 && m.die === 6)
    );
    expect(hasBearOffFrom23).toBe(true);
  });

  it("black over-bearing: checker on point 23, die 6, checker on point 20 is illegal", () => {
    // App point 20 is farther from black's bearing-off edge than point 23,
    // so point 23 is not black's farthest occupied point.
    const board = makeBoard(
      { 23: -1, 20: -1 },
      { blackOff: 13, whiteOff: 0 }
    );
    board.points[1] = 15;

    const sequences = generateAllMoveSequences(board, "black", [6, 1]);
    const hasBearOffFrom23 = sequences.some((seq) =>
      seq.some((m) => m.from === 23 && m.to === 25 && m.die === 6)
    );
    expect(hasBearOffFrom23).toBe(false);
  });

  it("black over-bearing: checker on point 20, die 6, no checker on 21-24 is legal", () => {
    // This is the key bug-regression test
    const board = makeBoard({ 20: -2 }, { blackOff: 13, whiteOff: 0 });
    board.points[1] = 15;

    const sequences = generateAllMoveSequences(board, "black", [6, 1]);
    const hasBearOffFrom20 = sequences.some((seq) =>
      seq.some((m) => m.from === 20 && m.to === 25 && m.die === 6)
    );
    expect(hasBearOffFrom20).toBe(true);
  });

  it("black over-bearing: checker on point 20, die 6, checker on point 23 is legal", () => {
    // App point 23 is closer to black's bearing-off edge than point 20,
    // so point 20 remains black's farthest occupied point.
    const board = makeBoard(
      { 20: -1, 23: -1 },
      { blackOff: 13, whiteOff: 0 }
    );
    board.points[1] = 15;

    const sequences = generateAllMoveSequences(board, "black", [6, 1]);
    const hasBearOffFrom20WithDie6 = sequences.some((seq) =>
      seq.some((m) => m.from === 20 && m.to === 25 && m.die === 6)
    );
    expect(hasBearOffFrom20WithDie6).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Higher Die Rule Tests
// ---------------------------------------------------------------------------

describe("Higher Die Rule", () => {
  it("roll 3-5, only die 5 can be used, must use 5", () => {
    // White: single checker on point 13.
    //   Die 3: 13→10 (blocked). Die 5: 13→8 (open).
    //   After using 5 (13→8): die 3: 8→5 (blocked). Can't use.
    // So maxDiceUsed = 1, and the higher die (5) must be used.
    const board = makeBoard(
      {
        13: 1,
        10: -2,
        5: -2,
      },
      { whiteOff: 14 }
    );
    board.points[19] = -11;

    const sequences = generateAllMoveSequences(board, "white", [3, 5]);
    expect(sequences.length).toBeGreaterThan(0);
    // All sequences should use only die 5 (the higher one)
    for (const seq of sequences) {
      expect(seq.length).toBe(1);
      expect(seq[0].die).toBe(5);
    }
  });

  it("roll 3-5, only die 3 can be used, falls back to 3", () => {
    // White has a single checker on point 3; can move 3→0 (bear off) with die 3
    // Die 5: 3-5 = -2 → over-bearing, but only valid if no higher point occupied
    // Put another white checker on point 5 to block over-bearing with die 5
    const board = makeBoard({ 3: 1, 5: 1 }, { whiteOff: 13 });
    board.points[24] = -15;

    const sequences = generateAllMoveSequences(board, "white", [3, 5]);
    // Should find sequences using die 3 (exact bear off from point 3)
    const usesDie3 = sequences.some((seq) =>
      seq.some((m) => m.die === 3)
    );
    expect(usesDie3).toBe(true);
  });

  it("roll 3-5, both usable, both available", () => {
    const state = createGameState();
    const withDice = setDice(state, 3, 5);
    const moves = getLegalFirstMoves(
      withDice.board,
      "white",
      withDice.movesRemaining
    );
    const hasDie3 = moves.some((m) => m.die === 3);
    const hasDie5 = moves.some((m) => m.die === 5);
    expect(hasDie3).toBe(true);
    expect(hasDie5).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Doubles Tests
// ---------------------------------------------------------------------------

describe("Doubles", () => {
  it("rolling doubles gives 4 dice", () => {
    const state = createGameState();
    const withDice = setDice(state, 3, 3);
    expect(withDice.movesRemaining).toEqual([3, 3, 3, 3]);
  });

  it("can use all 4 dice if possible", () => {
    const state = createGameState();
    const withDice = setDice(state, 1, 1);
    // From the initial position, white should be able to make 4 moves with 1s
    const sequences = generateAllMoveSequences(
      withDice.board,
      "white",
      withDice.movesRemaining
    );
    const maxMoves = Math.max(0, ...sequences.map((s) => s.length));
    expect(maxMoves).toBe(4);
  });

  it("partial doubles usage when blocked", () => {
    // Set up a position where white can only use some of the 4 dice
    // White has 2 checkers on point 6, all of points 1-5 blocked by black
    // Die = 6,6,6,6 → only 2 can bear off (point 6 has only 2 checkers)
    // Actually let's just block moves: white on point 6 only, blocked on point 1-5
    const board = makeBoard(
      {
        6: 2,
        1: -2,
        2: -2,
        3: -2,
        4: -2,
        5: -2,
      },
      { whiteOff: 13 }
    );
    // Use remaining black checkers
    board.points[24] = -5;

    // Die 1,1,1,1: white can move 6→5? No, point 5 is blocked.
    // So no legal moves at all.
    const sequences = generateAllMoveSequences(board, "white", [1, 1, 1, 1]);
    const maxMoves = Math.max(0, ...sequences.map((s) => s.length));
    expect(maxMoves).toBe(0);

    // Now with die 6: can bear off from point 6
    const sequences6 = generateAllMoveSequences(
      board,
      "white",
      [6, 6, 6, 6]
    );
    const maxMoves6 = Math.max(0, ...sequences6.map((s) => s.length));
    // Only 2 checkers on point 6, so at most 2 bear-offs
    expect(maxMoves6).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Game Over Tests
// ---------------------------------------------------------------------------

describe("Game Over", () => {
  it("white wins normal: all 15 white borne off, black has borne off some", () => {
    const board = makeBoard({}, { whiteOff: 15, blackOff: 3 });
    // Put remaining 12 black checkers on board
    board.points[19] = -12;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("white");
    expect(result.resultType).toBe("normal");
  });

  it("white wins gammon: all 15 white borne off, black borne off 0, not in white home", () => {
    const board = makeBoard({}, { whiteOff: 15, blackOff: 0 });
    // Put all 15 black checkers outside white's home board (points 7-24)
    board.points[12] = -15;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("white");
    expect(result.resultType).toBe("gammon");
  });

  it("white wins backgammon: all 15 white borne off, black borne off 0, black in white home board", () => {
    const board = makeBoard({}, { whiteOff: 15, blackOff: 0 });
    // Put some black checkers in white's home board (points 1-6)
    board.points[3] = -5;
    board.points[12] = -10;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("white");
    expect(result.resultType).toBe("backgammon");
  });

  it("white wins backgammon: black checker on bar counts", () => {
    const board = makeBoard({}, { whiteOff: 15, blackOff: 0 });
    board.points[25] = -1; // black bar
    board.points[12] = -14;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("white");
    expect(result.resultType).toBe("backgammon");
  });

  it("black wins normal: all 15 black borne off, white has borne off some", () => {
    const board = makeBoard({}, { blackOff: 15, whiteOff: 5 });
    board.points[6] = 10;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("black");
    expect(result.resultType).toBe("normal");
  });

  it("black wins gammon: all 15 black borne off, white borne off 0, not in black home", () => {
    const board = makeBoard({}, { blackOff: 15, whiteOff: 0 });
    board.points[6] = 15;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("black");
    expect(result.resultType).toBe("gammon");
  });

  it("black wins backgammon: all 15 black borne off, white borne off 0, white in black home board", () => {
    const board = makeBoard({}, { blackOff: 15, whiteOff: 0 });
    // White in black's home board (points 19-24)
    board.points[22] = 5;
    board.points[6] = 10;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("black");
    expect(result.resultType).toBe("backgammon");
  });

  it("black wins backgammon: white checker on bar counts", () => {
    const board = makeBoard({}, { blackOff: 15, whiteOff: 0 });
    board.points[0] = 1; // white bar
    board.points[6] = 14;

    const result = checkGameOver(board);
    expect(result.over).toBe(true);
    expect(result.winner).toBe("black");
    expect(result.resultType).toBe("backgammon");
  });

  it("no game over when neither player has borne off all checkers", () => {
    const board = makeBoard({}, { whiteOff: 14, blackOff: 14 });
    board.points[1] = 1;
    board.points[24] = -1;

    const result = checkGameOver(board);
    expect(result.over).toBe(false);
    expect(result.winner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Move History Tests
// ---------------------------------------------------------------------------

describe("Move History", () => {
  it("makeMove populates moveHistory", () => {
    const state = createGameState();
    const withDice = setDice(state, 1, 2);

    // Find a legal first move
    const moves = getLegalFirstMoves(
      withDice.board,
      "white",
      withDice.movesRemaining
    );
    expect(moves.length).toBeGreaterThan(0);

    const firstMove = moves[0];
    const result = makeMove(withDice, firstMove.from, firstMove.to);
    expect(result).not.toBeNull();
    expect(result!.moveHistory.length).toBe(1);
    expect(result!.moveHistory[0].player).toBe("white");
    expect(result!.moveHistory[0].moves.length).toBe(1);
    expect(result!.moveHistory[0].moves[0].from).toBe(firstMove.from);
    expect(result!.moveHistory[0].moves[0].to).toBe(firstMove.to);
  });

  it("multiple moves in same turn are grouped in one MoveRecord", () => {
    const state = createGameState();
    const withDice = setDice(state, 1, 2);

    // Make the first move
    const firstMoves = getLegalFirstMoves(
      withDice.board,
      "white",
      withDice.movesRemaining
    );
    const result1 = makeMove(withDice, firstMoves[0].from, firstMoves[0].to);
    expect(result1).not.toBeNull();

    // If there are remaining moves, make a second one
    if (result1!.movesRemaining.length > 0 && result1!.currentPlayer === "white") {
      const secondMoves = getLegalFirstMoves(
        result1!.board,
        "white",
        result1!.movesRemaining
      );
      if (secondMoves.length > 0) {
        const result2 = makeMove(
          result1!,
          secondMoves[0].from,
          secondMoves[0].to
        );
        expect(result2).not.toBeNull();
        // Both moves should be grouped in the same MoveRecord
        expect(result2!.moveHistory.length).toBe(1);
        expect(result2!.moveHistory[0].moves.length).toBe(2);
      }
    }
  });

  it("new turn creates a new MoveRecord", () => {
    const state = createGameState();

    // White's turn
    let current = setDice(state, 1, 2);
    const whiteMoves = getLegalFirstMoves(
      current.board,
      "white",
      current.movesRemaining
    );
    current = makeMove(current, whiteMoves[0].from, whiteMoves[0].to)!;

    // If there are remaining white moves, complete the turn
    while (
      current.movesRemaining.length > 0 &&
      current.currentPlayer === "white"
    ) {
      const nextMoves = getLegalFirstMoves(
        current.board,
        "white",
        current.movesRemaining
      );
      if (nextMoves.length === 0) break;
      current = makeMove(current, nextMoves[0].from, nextMoves[0].to)!;
    }

    // Now it should be black's turn (turn auto-ends when all dice used)
    // If the turn didn't auto-end, end it manually
    if (current.currentPlayer === "white") {
      current = endTurn(current);
    }

    // Black's turn
    current = setDice(current, 3, 4);
    const blackMoves = getLegalFirstMoves(
      current.board,
      "black",
      current.movesRemaining
    );
    expect(blackMoves.length).toBeGreaterThan(0);
    current = makeMove(current, blackMoves[0].from, blackMoves[0].to)!;

    // There should be at least 2 MoveRecords now
    expect(current.moveHistory.length).toBeGreaterThanOrEqual(2);
    expect(current.moveHistory[0].player).toBe("white");
    expect(current.moveHistory[current.moveHistory.length - 1].player).toBe(
      "black"
    );
  });
});

// ---------------------------------------------------------------------------
// State Immutability Tests
// ---------------------------------------------------------------------------

describe("State Immutability", () => {
  it("makeMove does not mutate the original state", () => {
    const state = createGameState();
    const withDice = setDice(state, 1, 2);

    // Deep-copy the state for comparison
    const originalBoard = JSON.parse(JSON.stringify(withDice.board));
    const originalRemaining = [...withDice.movesRemaining];

    const moves = getLegalFirstMoves(
      withDice.board,
      "white",
      withDice.movesRemaining
    );
    const result = makeMove(withDice, moves[0].from, moves[0].to);
    expect(result).not.toBeNull();

    // Original state should be unchanged
    expect(withDice.board.points).toEqual(originalBoard.points);
    expect(withDice.board.whiteOff).toBe(originalBoard.whiteOff);
    expect(withDice.board.blackOff).toBe(originalBoard.blackOff);
    expect(withDice.movesRemaining).toEqual(originalRemaining);
  });

  it("cloneBoard does not share references with the original", () => {
    const board = createInitialBoard();
    const clone = cloneBoard(board);

    // Mutate the clone
    clone.points[1] = 999;
    clone.whiteOff = 10;

    // Original should be unaffected
    expect(board.points[1]).toBe(-2);
    expect(board.whiteOff).toBe(0);
  });

  it("applySingleMove does not mutate the original board", () => {
    const board = createInitialBoard();
    const originalPoints = [...board.points];

    const newBoard = applySingleMove(board, "white", 24, 23);

    // Original should be unchanged
    expect(board.points).toEqual(originalPoints);
    // New board should be different
    expect(newBoard.points[24]).toBe(1); // one fewer white checker
    expect(newBoard.points[23]).toBe(1); // one more white checker
  });
});

// ---------------------------------------------------------------------------
// setDice and endTurn Tests
// ---------------------------------------------------------------------------

describe("setDice and endTurn", () => {
  it("setDice sets dice and increments turnNumber", () => {
    const state = createGameState();
    expect(state.turnNumber).toBe(0);

    const withDice = setDice(state, 4, 2);
    expect(withDice.dice).toEqual([4, 2]);
    expect(withDice.movesRemaining).toEqual([4, 2]);
    expect(withDice.turnNumber).toBe(1);
  });

  it("setDice with doubles gives 4 moves", () => {
    const state = createGameState();
    const withDice = setDice(state, 5, 5);
    expect(withDice.movesRemaining).toEqual([5, 5, 5, 5]);
  });

  it("endTurn switches currentPlayer", () => {
    const state = createGameState();
    expect(state.currentPlayer).toBe("white");

    const ended = endTurn(state);
    expect(ended.currentPlayer).toBe("black");

    const ended2 = endTurn(ended);
    expect(ended2.currentPlayer).toBe("white");
  });

  it("endTurn clears dice and movesRemaining", () => {
    const state = createGameState();
    const withDice = setDice(state, 3, 4);
    expect(withDice.movesRemaining.length).toBeGreaterThan(0);

    const ended = endTurn(withDice);
    expect(ended.dice).toBeNull();
    expect(ended.movesRemaining).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hasLegalMoves Tests
// ---------------------------------------------------------------------------

describe("hasLegalMoves", () => {
  it("returns true when legal moves exist", () => {
    const state = createGameState();
    const withDice = setDice(state, 1, 2);
    expect(hasLegalMoves(withDice)).toBe(true);
  });

  it("returns false when no dice remain", () => {
    const state = createGameState();
    // No dice set, movesRemaining is empty
    expect(hasLegalMoves(state)).toBe(false);
  });

  it("returns false when completely blocked", () => {
    // White on bar, all entry points (19-24) blocked by black
    const board = makeBoard({
      0: 1, // white on bar
      19: -2,
      20: -2,
      21: -2,
      22: -2,
      23: -2,
      24: -2,
    });
    // Fill up remaining checkers
    board.points[6] = 14; // rest of white
    board.points[17] = -3; // rest of black

    const state = makeState({
      board,
      currentPlayer: "white",
      dice: [3, 4],
      movesRemaining: [3, 4],
      turnNumber: 1,
    });

    expect(hasLegalMoves(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hitting (blot) Tests
// ---------------------------------------------------------------------------

describe("Hitting", () => {
  it("white can hit a black blot and send it to the bar", () => {
    // White on 24, single black on 23 (blot)
    const board = makeBoard({
      24: 2,
      13: 5,
      8: 3,
      6: 5,
      23: -1, // black blot
      12: -4,
      17: -3,
      19: -5,
      1: -2,
    });

    const newBoard = applySingleMove(board, "white", 24, 23);
    // Black blot should be sent to bar (index 25)
    expect(newBoard.points[23]).toBe(1); // white now occupies
    expect(newBoard.points[25]).toBe(-1); // black sent to bar
  });

  it("black can hit a white blot and send it to the bar", () => {
    const board = makeBoard({
      1: -2,
      2: 1, // white blot
      12: -5,
      17: -3,
      19: -5,
      24: 2,
      13: 5,
      8: 3,
      6: 4,
    });

    const newBoard = applySingleMove(board, "black", 1, 2);
    expect(newBoard.points[2]).toBe(-1); // black now occupies
    expect(newBoard.points[0]).toBe(1); // white sent to bar
  });
});

// ---------------------------------------------------------------------------
// Board Utility Tests
// ---------------------------------------------------------------------------

describe("Board Utilities", () => {
  it("getCheckerCount returns correct counts", () => {
    const board = createInitialBoard();
    expect(getCheckerCount(board, 24, "white")).toBe(2);
    expect(getCheckerCount(board, 24, "black")).toBe(0);
    expect(getCheckerCount(board, 1, "black")).toBe(2);
    expect(getCheckerCount(board, 1, "white")).toBe(0);
  });

  it("isPointBlocked correctly identifies blocked points", () => {
    const board = createInitialBoard();
    // Point 19 has -5 black checkers → blocked for white
    expect(isPointBlocked(board, 19, "white")).toBe(true);
    // Point 6 has 5 white checkers → blocked for black
    expect(isPointBlocked(board, 6, "black")).toBe(true);
    // Point 24 has 2 white checkers → not blocked for white (it's their own)
    expect(isPointBlocked(board, 24, "white")).toBe(false);
  });

  it("canBearOff returns false when checkers are outside home board", () => {
    const board = createInitialBoard();
    expect(canBearOff(board, "white")).toBe(false);
    expect(canBearOff(board, "black")).toBe(false);
  });

  it("canBearOff returns true when all checkers are in home board", () => {
    const boardW = makeBoard({ 1: 5, 2: 5, 3: 5 }, { whiteOff: 0 });
    expect(canBearOff(boardW, "white")).toBe(true);

    const boardB = makeBoard({ 19: -5, 20: -5, 21: -5 }, { blackOff: 0 });
    expect(canBearOff(boardB, "black")).toBe(true);
  });

  it("canBearOff returns false when checker is on bar", () => {
    const board = makeBoard({ 0: 1, 1: 4, 2: 5, 3: 5 }, { whiteOff: 0 });
    expect(canBearOff(board, "white")).toBe(false);
  });
});
