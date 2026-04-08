import {
  BoardState,
  GameState,
  MoveRecord,
  Player,
  ResultType,
  TOTAL_CHECKERS,
} from "./types";
import { createInitialBoard } from "./board";
import { applySingleMove, generateAllMoveSequences } from "./moves";

/** Create a new game state */
export function createGameState(): GameState {
  return {
    board: createInitialBoard(),
    currentPlayer: "white", // White always goes first (after initial roll)
    dice: null,
    movesRemaining: [],
    gameOver: false,
    winner: null,
    resultType: null,
    turnNumber: 0,
    moveHistory: [],
    cubeValue: 1,
    cubeOwner: null,
  };
}

/** Set dice for the current turn */
export function setDice(
  state: GameState,
  die1: number,
  die2: number
): GameState {
  if (
    die1 < 1 || die1 > 6 || die2 < 1 || die2 > 6 ||
    !Number.isInteger(die1) || !Number.isInteger(die2)
  ) {
    throw new Error(`Invalid die values: ${die1}, ${die2}`);
  }

  const dice: [number, number] = [die1, die2];
  const movesRemaining =
    die1 === die2
      ? [die1, die1, die1, die1] // Doubles: 4 moves
      : [die1, die2];

  return {
    ...state,
    dice,
    movesRemaining,
    turnNumber: state.turnNumber + 1,
  };
}

/**
 * Validate and apply a move. Returns the new game state or null if invalid.
 * Optional `preferDie` hint: when multiple dice can produce the same from→to,
 * prefer consuming this die value. Used by the AI to match GNUBG's die assignment.
 */
export function makeMove(
  state: GameState,
  from: number,
  to: number,
  preferDie?: number
): GameState | null {
  if (state.gameOver) return null;
  if (state.movesRemaining.length === 0) return null;

  // Find which die value this move uses
  const player = state.currentPlayer;
  const allSequences = generateAllMoveSequences(
    state.board,
    player,
    state.movesRemaining
  );

  // Check if this move appears as a valid first move in any maximum-length sequence.
  // If preferDie is specified, prefer sequences that use that die value.
  let matchedDie: number | null = null;
  let fallbackDie: number | null = null;
  for (const seq of allSequences) {
    if (seq.length > 0 && seq[0].from === from && seq[0].to === to) {
      if (preferDie !== undefined && seq[0].die === preferDie) {
        matchedDie = seq[0].die;
        break;
      }
      if (fallbackDie === null) {
        fallbackDie = seq[0].die;
      }
    }
  }
  if (matchedDie === null) matchedDie = fallbackDie;

  if (matchedDie === null) return null; // Illegal move

  // Apply the move
  const newBoard = applySingleMove(state.board, player, from, to);
  const newRemaining = [...state.movesRemaining];
  const dieIdx = newRemaining.indexOf(matchedDie);
  newRemaining.splice(dieIdx, 1);

  // Check if game is over
  const gameOverResult = checkGameOver(newBoard);

  // Check if the turn should end (no remaining moves or no legal moves)
  let shouldEndTurn = newRemaining.length === 0;
  if (!shouldEndTurn && newRemaining.length > 0) {
    const nextSequences = generateAllMoveSequences(
      newBoard,
      player,
      newRemaining
    );
    const maxMoves = Math.max(0, ...nextSequences.map((s) => s.length));
    if (maxMoves === 0) shouldEndTurn = true;
  }

  // Update moveHistory: append to the current turn's record, or create a new one
  const updatedHistory = [...state.moveHistory];
  const currentMove = { from, to, die: matchedDie };
  const lastRecord = updatedHistory[updatedHistory.length - 1];
  if (
    lastRecord &&
    lastRecord.turnNumber === state.turnNumber &&
    lastRecord.player === player
  ) {
    // Append to existing turn record
    updatedHistory[updatedHistory.length - 1] = {
      ...lastRecord,
      moves: [...lastRecord.moves, currentMove],
    };
  } else {
    // Create a new turn record
    updatedHistory.push({
      turnNumber: state.turnNumber,
      player,
      dice: state.dice!,
      moves: [currentMove],
    });
  }

  const newState: GameState = {
    ...state,
    board: newBoard,
    dice: shouldEndTurn ? null : state.dice,
    movesRemaining: shouldEndTurn ? [] : newRemaining,
    currentPlayer:
      shouldEndTurn && !gameOverResult.over
        ? player === "white"
          ? "black"
          : "white"
        : player,
    gameOver: gameOverResult.over,
    winner: gameOverResult.winner,
    resultType: gameOverResult.resultType,
    moveHistory: updatedHistory,
  };

  return newState;
}

/** End the current turn (when all dice are used or no more legal moves) */
export function endTurn(state: GameState): GameState {
  if (state.gameOver) return state;

  return {
    ...state,
    dice: null,
    movesRemaining: [],
    currentPlayer: state.currentPlayer === "white" ? "black" : "white",
  };
}

/** Check if any legal moves exist for the current dice */
export function hasLegalMoves(state: GameState): boolean {
  if (state.movesRemaining.length === 0) return false;
  const sequences = generateAllMoveSequences(
    state.board,
    state.currentPlayer,
    state.movesRemaining
  );
  return sequences.some((s) => s.length > 0);
}

/** Check game-over conditions */
export function checkGameOver(board: BoardState): {
  over: boolean;
  winner: Player | null;
  resultType: ResultType | null;
} {
  if (board.whiteOff === TOTAL_CHECKERS) {
    // White wins -- check for gammon/backgammon
    if (board.blackOff === 0) {
      // Black hasn't borne off any -- gammon at minimum
      // Check for backgammon: black has checkers in white's home board (1-6) or on bar
      let blackInWhiteHome = false;
      for (let i = 1; i <= 6; i++) {
        if (board.points[i] < 0) {
          blackInWhiteHome = true;
          break;
        }
      }
      if (board.points[25] < 0) blackInWhiteHome = true; // black bar

      return {
        over: true,
        winner: "white",
        resultType: blackInWhiteHome ? "backgammon" : "gammon",
      };
    }
    return { over: true, winner: "white", resultType: "normal" };
  }

  if (board.blackOff === TOTAL_CHECKERS) {
    if (board.whiteOff === 0) {
      let whiteInBlackHome = false;
      for (let i = 19; i <= 24; i++) {
        if (board.points[i] > 0) {
          whiteInBlackHome = true;
          break;
        }
      }
      if (board.points[0] > 0) whiteInBlackHome = true; // white bar

      return {
        over: true,
        winner: "black",
        resultType: whiteInBlackHome ? "backgammon" : "gammon",
      };
    }
    return { over: true, winner: "black", resultType: "normal" };
  }

  return { over: false, winner: null, resultType: null };
}

/** Check if a player can offer a double */
export function canDouble(state: GameState, player: Player): boolean {
  if (state.gameOver) return false;
  if (state.dice !== null) return false; // can only double before rolling
  if (state.currentPlayer !== player) return false;
  if (state.cubeValue >= 64) return false;
  // Can double if cube is centered or owned by this player
  return state.cubeOwner === null || state.cubeOwner === player;
}

/** Offer a double — returns state with pending double */
export function offerDouble(state: GameState, player: Player): GameState | null {
  if (!canDouble(state, player)) return null;
  return { ...state };
}

/** Accept a double — cube value doubles, ownership transfers to acceptor */
export function acceptDouble(state: GameState, acceptingPlayer: Player): GameState {
  return {
    ...state,
    cubeValue: state.cubeValue * 2,
    cubeOwner: acceptingPlayer,
  };
}

/** Reject a double — game ends, doubling player wins */
export function rejectDouble(state: GameState, rejectingPlayer: Player): { state: GameState; winner: Player } {
  const winner: Player = rejectingPlayer === "white" ? "black" : "white";
  return {
    state: {
      ...state,
      gameOver: true,
      winner,
      resultType: "normal",
    },
    winner,
  };
}

/** Handle the opening roll where each player rolls one die.
 *  Returns null if tie (re-roll needed), otherwise sets currentPlayer and dice. */
export function setOpeningRoll(
  state: GameState,
  whiteDie: number,
  blackDie: number,
): GameState | null {
  if (whiteDie < 1 || whiteDie > 6 || blackDie < 1 || blackDie > 6 ||
      !Number.isInteger(whiteDie) || !Number.isInteger(blackDie)) {
    throw new Error(`Invalid opening roll values: ${whiteDie}, ${blackDie}`);
  }

  // Tie — re-roll needed
  if (whiteDie === blackDie) return null;

  const firstPlayer: Player = whiteDie > blackDie ? "white" : "black";
  const dice: [number, number] = whiteDie > blackDie
    ? [whiteDie, blackDie]
    : [blackDie, whiteDie];

  const movesRemaining = [dice[0], dice[1]];

  return {
    ...state,
    currentPlayer: firstPlayer,
    dice,
    movesRemaining,
    turnNumber: state.turnNumber + 1,
  };
}
