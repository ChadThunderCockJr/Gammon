import { BoardState, Move, Player, WHITE_BAR, BLACK_BAR } from "./types";
import {
  cloneBoard,
  getBarCount,
  canBearOff,
  isPointBlocked,
  getCheckerCount,
} from "./board";

/** Get the destination point for a move from a given point using a die value */
function getDestination(from: number, die: number, player: Player): number {
  if (player === "white") {
    if (from === WHITE_BAR) return 25 - die; // entering from bar: die=1 -> point 24, die=6 -> point 19
    return from - die;
  } else {
    if (from === BLACK_BAR) return die; // entering from bar: die=1 -> point 1, die=6 -> point 6
    return from + die;
  }
}

/** Check if a destination is a valid bearing-off move */
function isBearingOff(dest: number, player: Player): boolean {
  if (player === "white") return dest <= 0;
  return dest >= 25;
}

/**
 * Check if a single move (from -> using die) is legal.
 * Does NOT check bar requirements or maximum-use rules -- those are sequence-level.
 */
function isSingleMoveLegal(
  board: BoardState,
  player: Player,
  from: number,
  die: number
): { legal: boolean; to: number } {
  const dest = getDestination(from, die, player);

  // Bearing off
  if (isBearingOff(dest, player)) {
    if (!canBearOff(board, player)) return { legal: false, to: dest };

    // Validate that the source point actually has a checker of the correct color
    if (getCheckerCount(board, from, player) <= 0)
      return { legal: false, to: dest };

    if (player === "white") {
      const exactDest = from - die;
      if (exactDest === 0) return { legal: true, to: 0 }; // Exact bear off
      if (exactDest < 0) {
        // Over-bearing: only legal if no checker on a higher point in home board
        for (let i = from + 1; i <= 6; i++) {
          if (board.points[i] > 0) return { legal: false, to: 0 };
        }
        return { legal: true, to: 0 };
      }
    } else {
      const exactDest = from + die;
      if (exactDest === 25) return { legal: true, to: 25 }; // Exact bear off
      if (exactDest > 25) {
        // Over-bearing: only legal if no black checker on a higher point (closer to bear-off)
        for (let i = from + 1; i <= 24; i++) {
          if (board.points[i] < 0) return { legal: false, to: 25 };
        }
        return { legal: true, to: 25 };
      }
    }
    return { legal: false, to: dest };
  }

  // Normal move: destination must be 1-24 and not blocked
  if (dest < 1 || dest > 24) return { legal: false, to: dest };
  if (isPointBlocked(board, dest, player)) return { legal: false, to: dest };

  // Must have a checker at 'from'
  if (from === WHITE_BAR || from === BLACK_BAR) {
    if (getBarCount(board, player) <= 0) return { legal: false, to: dest };
  } else {
    if (getCheckerCount(board, from, player) <= 0)
      return { legal: false, to: dest };
  }

  return { legal: true, to: dest };
}

/** Apply a single move to a board (returns a new board) */
export function applySingleMove(
  board: BoardState,
  player: Player,
  from: number,
  to: number
): BoardState {
  const newBoard = cloneBoard(board);

  // Remove checker from source
  if (player === "white") {
    newBoard.points[from]--;
  } else {
    newBoard.points[from]++;
  }

  // Bearing off
  if (
    (player === "white" && to === 0) ||
    (player === "black" && to === 25)
  ) {
    if (player === "white") newBoard.whiteOff++;
    else newBoard.blackOff++;
    return newBoard;
  }

  // Check for hit (blot)
  if (player === "white" && newBoard.points[to] === -1) {
    newBoard.points[to] = 0; // Remove black blot
    newBoard.points[BLACK_BAR]--; // Send to black's bar (more negative)
  } else if (player === "black" && newBoard.points[to] === 1) {
    newBoard.points[to] = 0; // Remove white blot
    newBoard.points[WHITE_BAR]++; // Send to white's bar (more positive)
  }

  // Place checker at destination
  if (player === "white") {
    newBoard.points[to]++;
  } else {
    newBoard.points[to]--;
  }

  return newBoard;
}

/**
 * Generate all legal move sequences for the current dice roll.
 * Returns an array of Move arrays, where each array is a complete turn.
 * The player MUST use the maximum number of dice possible.
 * If only one die can be used, the higher value must be used.
 */
export function generateAllMoveSequences(
  board: BoardState,
  player: Player,
  dice: number[]
): Move[][] {
  const results: Move[][] = [];

  function findMoves(
    currentBoard: BoardState,
    remainingDice: number[],
    currentMoves: Move[]
  ) {
    if (remainingDice.length === 0) {
      results.push([...currentMoves]);
      return;
    }

    let anyMovePossible = false;
    const barIndex = player === "white" ? WHITE_BAR : BLACK_BAR;
    const onBar = getBarCount(currentBoard, player) > 0;

    // Try each remaining die
    const triedDice = new Set<number>();
    for (let di = 0; di < remainingDice.length; di++) {
      const die = remainingDice[di];
      if (triedDice.has(die)) continue; // skip duplicate dice values
      triedDice.add(die);

      // If on bar, must enter from bar
      if (onBar) {
        const check = isSingleMoveLegal(currentBoard, player, barIndex, die);
        if (check.legal) {
          anyMovePossible = true;
          const move: Move = { from: barIndex, to: check.to, die };
          const newBoard = applySingleMove(
            currentBoard,
            player,
            barIndex,
            check.to
          );
          const newRemaining = [...remainingDice];
          newRemaining.splice(di, 1);
          findMoves(newBoard, newRemaining, [...currentMoves, move]);
        }
      } else {
        // Try all points where the player has checkers
        const start = player === "white" ? 24 : 1;
        const end = player === "white" ? 1 : 24;
        const step = player === "white" ? -1 : 1;

        for (
          let pt = start;
          player === "white" ? pt >= end : pt <= end;
          pt += step
        ) {
          if (getCheckerCount(currentBoard, pt, player) <= 0) continue;

          const check = isSingleMoveLegal(currentBoard, player, pt, die);
          if (check.legal) {
            anyMovePossible = true;
            const move: Move = { from: pt, to: check.to, die };
            const newBoard = applySingleMove(
              currentBoard,
              player,
              pt,
              check.to
            );
            const newRemaining = [...remainingDice];
            newRemaining.splice(di, 1);
            findMoves(newBoard, newRemaining, [...currentMoves, move]);
          }
        }
      }
    }

    if (!anyMovePossible) {
      // Can't use any more dice -- record what we have
      results.push([...currentMoves]);
    }
  }

  findMoves(board, dice, []);

  // Filter to only keep sequences that use the maximum number of dice
  const maxDiceUsed = Math.max(0, ...results.map((r) => r.length));
  let maxResults = results.filter((r) => r.length === maxDiceUsed);

  // If only one die can be used (maxDiceUsed === 1) and dice are different,
  // must use the higher value
  if (maxDiceUsed === 1 && dice.length === 2 && dice[0] !== dice[1]) {
    const higherDie = Math.max(...dice);
    const canUseHigher = maxResults.some((r) => r[0].die === higherDie);
    if (canUseHigher) {
      maxResults = maxResults.filter((r) => r[0].die === higherDie);
    }
  }

  // Deduplicate move sequences
  const seen = new Set<string>();
  return maxResults.filter((seq) => {
    const key = seq.map((m) => `${m.from}-${m.to}-${m.die}`).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Get all legal first moves (for UI -- show which pieces can be moved).
 * Returns unique (from, to, die) combinations that appear in at least one valid full sequence.
 */
export function getLegalFirstMoves(
  board: BoardState,
  player: Player,
  dice: number[]
): Move[] {
  const sequences = generateAllMoveSequences(board, player, dice);
  const seen = new Set<string>();
  const moves: Move[] = [];

  for (const seq of sequences) {
    if (seq.length > 0) {
      const m = seq[0];
      const key = `${m.from}-${m.to}-${m.die}`;
      if (!seen.has(key)) {
        seen.add(key);
        moves.push(m);
      }
    }
  }

  return moves;
}

/**
 * Given a board state and a partial move sequence already made this turn,
 * return the legal next moves.
 */
export function getLegalNextMoves(
  board: BoardState,
  player: Player,
  dice: number[],
  movesMade: Move[]
): Move[] {
  // Replay movesMade to get current board state
  let currentBoard = board;
  const remainingDice = [...dice];

  for (const move of movesMade) {
    currentBoard = applySingleMove(currentBoard, player, move.from, move.to);
    const dieIdx = remainingDice.indexOf(move.die);
    if (dieIdx !== -1) remainingDice.splice(dieIdx, 1);
  }

  if (remainingDice.length === 0) return [];

  // Generate all sequences from this point
  const sequences = generateAllMoveSequences(
    currentBoard,
    player,
    remainingDice
  );
  const seen = new Set<string>();
  const moves: Move[] = [];

  for (const seq of sequences) {
    if (seq.length > 0) {
      const m = seq[0];
      const key = `${m.from}-${m.to}-${m.die}`;
      if (!seen.has(key)) {
        seen.add(key);
        moves.push(m);
      }
    }
  }

  return moves;
}
