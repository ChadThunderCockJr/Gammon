import type { BoardState, Move, Player } from "@xion-beginner/backgammon-core";
import {
  createInitialBoard,
  generateAllMoveSequences,
  applySingleMove,
  getPipCount,
} from "@xion-beginner/backgammon-core";
import { getGnubgMoves, isGnubgReady, type GnubgMoveResult } from "./gnubg";

/* ── Types ── */

export type ErrorClass = "blunder" | "mistake" | "inaccuracy" | null;

export interface WinProbability {
  win: number;
  winG: number;
  winBG: number;
  lose: number;
  loseG: number;
  loseBG: number;
}

export interface CandidateMove {
  moves: Move[];
  notation: string;
  equity: number; // normalized [-1, +1] from white's perspective
  isPlayed: boolean;
  probability?: WinProbability;
}

export interface TurnAnalysis {
  turnNumber: number;
  player: Player;
  dice: [number, number];
  playedMoves: Move[];
  playedNotation: string;
  equityAfter: number; // equity after played move (white's perspective)
  bestEquity: number; // equity of best candidate (white's perspective)
  equityLoss: number; // always >= 0, from the moving player's perspective
  errorClass: ErrorClass;
  candidates: CandidateMove[]; // top 5, sorted best-first
  boardBefore: BoardState; // board state before this turn's moves
  probability?: WinProbability; // gnubg win probability for played move
}

export interface PlayerSummary {
  totalTurns: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  avgEquityLoss: number;
  performanceRating: number; // 0-100
}

export interface GameAnalysis {
  turns: TurnAnalysis[];
  equityHistory: number[]; // index 0 = initial position, then one per turn
  whiteSummary: PlayerSummary;
  blackSummary: PlayerSummary;
}

export interface TurnRecord {
  player: Player;
  dice: [number, number];
  moves: { from: number; to: number; die: number }[];
  boardBefore?: BoardState;
}

/* ── Helpers ── */

/**
 * Simple pip-count-based equity estimate used ONLY as a last-resort fallback
 * when GNUBG is unavailable. Returns a value in roughly [-1, +1] from white's
 * perspective. This is intentionally crude — the real evaluation comes from GNUBG.
 */
function fallbackEquityWhite(board: BoardState): number {
  const whitePips = getPipCount(board, "white");
  const blackPips = getPipCount(board, "black");
  // Normalize pip difference: 167 is starting pip count
  const diff = (blackPips - whitePips) / 167;
  // Add bearing-off progress
  const offBonus = (board.whiteOff - board.blackOff) / 15;
  return Math.tanh((diff + offBonus) * 2);
}

/** Format a move sequence into notation like "13/7 8/5" */
function formatNotation(moves: Move[]): string {
  if (moves.length === 0) return "(no moves)";
  return moves.map((m) => `${m.from}/${m.to}`).join(" ");
}

/** Classify equity loss into error category */
export function classifyError(equityLoss: number): ErrorClass {
  if (equityLoss >= 0.12) return "blunder";
  if (equityLoss >= 0.06) return "mistake";
  if (equityLoss >= 0.02) return "inaccuracy";
  return null;
}

/** Compute performance rating from average equity loss */
function computePerformanceRating(avgEquityLoss: number): number {
  return Math.round(100 * Math.exp(-avgEquityLoss * 25));
}

/** Apply a full sequence of moves to a board */
function applyMoveSequence(
  board: BoardState,
  player: Player,
  moves: Move[],
): BoardState {
  let result = board;
  for (const move of moves) {
    result = applySingleMove(result, player, move.from, move.to);
  }
  return result;
}

/** Build dice array for generateAllMoveSequences (handles doubles) */
function buildDiceArray(dice: [number, number]): number[] {
  if (dice[0] === dice[1]) {
    return [dice[0], dice[0], dice[0], dice[0]];
  }
  return [dice[0], dice[1]];
}

/* ── Monte Carlo Win Probability ── */

/**
 * Estimate winning probability by simulating random games from a position.
 * Rolls random dice, picks random legal moves for both sides, counts outcomes.
 * Returns { white: number, black: number } as percentages (0-100).
 */
export function estimateWinProbability(
  board: BoardState,
  nextPlayer: Player,
  samples: number = 150,
): { white: number; black: number } {
  let whiteWins = 0;

  for (let i = 0; i < samples; i++) {
    let sim = board;
    let player = nextPlayer;
    let moves = 0;
    const maxMoves = 150;

    while (moves < maxMoves) {
      if (sim.whiteOff >= 15) { whiteWins++; break; }
      if (sim.blackOff >= 15) { break; }

      const d1 = Math.floor(Math.random() * 6) + 1;
      const d2 = Math.floor(Math.random() * 6) + 1;
      const diceArr = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];

      const seqs = generateAllMoveSequences(sim, player, diceArr);
      const nonEmpty = seqs.filter((s) => s.length > 0);

      if (nonEmpty.length > 0) {
        const chosen = nonEmpty[Math.floor(Math.random() * nonEmpty.length)];
        for (const m of chosen) {
          sim = applySingleMove(sim, player, m.from, m.to);
        }
      }

      player = player === "white" ? "black" : "white";
      moves++;
    }
  }

  const whitePct = Math.round((whiteWins / samples) * 100);
  return { white: whitePct, black: 100 - whitePct };
}

/* ── Core Analysis (fallback — used only when GNUBG is unavailable) ── */

export function analyzeGame(turnHistory: TurnRecord[]): GameAnalysis {
  let board = createInitialBoard();
  const equityHistory: number[] = [fallbackEquityWhite(board)];
  const turns: TurnAnalysis[] = [];

  for (let i = 0; i < turnHistory.length; i++) {
    const turn = turnHistory[i];
    const { player, dice, moves: playedMoves } = turn;
    const diceArray = buildDiceArray(dice);

    if (turn.boardBefore) {
      board = turn.boardBefore;
    }

    const allSequences = generateAllMoveSequences(board, player, diceArray);
    const playedKey = playedMoves.map((m) => `${m.from}/${m.to}`).sort().join(" ");

    const scored: (CandidateMove & { playerEq: number })[] = [];

    if (allSequences.length === 0 || (allSequences.length === 1 && allSequences[0].length === 0)) {
      scored.push({
        moves: [],
        notation: "(no moves)",
        equity: fallbackEquityWhite(board),
        isPlayed: playedMoves.length === 0,
        playerEq: 0,
      });
    } else {
      for (const seq of allSequences) {
        const resultBoard = applyMoveSequence(board, player, seq);
        const whiteEq = fallbackEquityWhite(resultBoard);
        const key = seq.map((m) => `${m.from}/${m.to}`).sort().join(" ");
        scored.push({
          moves: seq,
          notation: formatNotation(seq),
          equity: whiteEq,
          isPlayed: key === playedKey,
          playerEq: player === "white" ? whiteEq : -whiteEq,
        });
      }
    }

    scored.sort((a, b) => b.playerEq - a.playerEq);
    const candidates: CandidateMove[] = scored.map(({ playerEq: _, ...rest }) => rest);

    // Deduplicate
    const seenMap = new Map<string, number>();
    const uniqueCandidates: CandidateMove[] = [];
    for (const c of candidates) {
      const key = c.moves.map((m) => `${m.from}/${m.to}`).sort().join(" ");
      const existing = seenMap.get(key);
      if (existing === undefined) {
        seenMap.set(key, uniqueCandidates.length);
        uniqueCandidates.push(c);
      } else if (c.isPlayed) {
        uniqueCandidates[existing] = { ...uniqueCandidates[existing], isPlayed: true };
      }
    }

    let topCandidates = uniqueCandidates.slice(0, 5);
    if (!topCandidates.some((c) => c.isPlayed)) {
      const playedCandidate = uniqueCandidates.find((c) => c.isPlayed);
      if (playedCandidate) {
        topCandidates = [...topCandidates.slice(0, 4), playedCandidate];
      }
    }

    const playedBoard = applyMoveSequence(board, player, playedMoves);
    const playedEquity = fallbackEquityWhite(playedBoard);
    const bestEquity = uniqueCandidates.length > 0 ? uniqueCandidates[0].equity : playedEquity;

    const bestPlayerEq = uniqueCandidates.length > 0
      ? (player === "white" ? uniqueCandidates[0].equity : -uniqueCandidates[0].equity)
      : (player === "white" ? playedEquity : -playedEquity);
    const playedPlayerEq = player === "white" ? playedEquity : -playedEquity;
    const equityLoss = Math.max(0, bestPlayerEq - playedPlayerEq);

    turns.push({
      turnNumber: i + 1,
      player,
      dice,
      playedMoves,
      playedNotation: formatNotation(playedMoves),
      equityAfter: playedEquity,
      bestEquity,
      equityLoss,
      errorClass: classifyError(equityLoss),
      candidates: topCandidates,
      boardBefore: board,
    });

    equityHistory.push(playedEquity);
    board = playedBoard;
  }

  const whiteSummary = computeSummary(turns, "white");
  const blackSummary = computeSummary(turns, "black");

  return { turns, equityHistory, whiteSummary, blackSummary };
}

function computeSummary(turns: TurnAnalysis[], player: Player): PlayerSummary {
  const playerTurns = turns.filter((t) => t.player === player);
  const totalTurns = playerTurns.length;

  if (totalTurns === 0) {
    return {
      totalTurns: 0,
      blunders: 0,
      mistakes: 0,
      inaccuracies: 0,
      avgEquityLoss: 0,
      performanceRating: 100,
    };
  }

  const blunders = playerTurns.filter((t) => t.errorClass === "blunder").length;
  const mistakes = playerTurns.filter((t) => t.errorClass === "mistake").length;
  const inaccuracies = playerTurns.filter((t) => t.errorClass === "inaccuracy").length;
  const totalEquityLoss = playerTurns.reduce((sum, t) => sum + t.equityLoss, 0);
  const avgEquityLoss = totalEquityLoss / totalTurns;
  const performanceRating = computePerformanceRating(avgEquityLoss);

  return { totalTurns, blunders, mistakes, inaccuracies, avgEquityLoss, performanceRating };
}

/* ── WASM-Based Analysis ── */

/**
 * Analyze a game using GNU Backgammon's WASM engine for proper equity scores.
 * Falls back to heuristic analysis if GNUBG is unavailable.
 */
export async function analyzeGameWithGnubg(
  turnHistory: TurnRecord[],
  onProgress?: (current: number, total: number) => void,
): Promise<GameAnalysis> {
  if (!isGnubgReady()) {
    return analyzeGame(turnHistory);
  }

  let board = createInitialBoard();
  const equityHistory: number[] = [0]; // gnubg equity starts at 0 (equal position)
  const turns: TurnAnalysis[] = [];

  for (let i = 0; i < turnHistory.length; i++) {
    onProgress?.(i + 1, turnHistory.length);

    const turn = turnHistory[i];
    const { player, dice, moves: playedMoves } = turn;

    if (turn.boardBefore) {
      board = turn.boardBefore;
    }

    let turnAnalysis: TurnAnalysis;

    try {
      const gnubgResults = await getGnubgMoves(board, player, dice, {
        scoreMoves: true,
        maxMoves: 0,
      });

      turnAnalysis = buildGnubgTurnAnalysis(
        i + 1, player, dice, playedMoves, board, gnubgResults,
      );
    } catch {
      turnAnalysis = buildFallbackTurnAnalysis(
        i + 1, player, dice, playedMoves, board,
      );
    }

    turns.push(turnAnalysis);
    equityHistory.push(turnAnalysis.equityAfter);
    board = applyMoveSequence(board, player, playedMoves);
  }

  const whiteSummary = computeSummary(turns, "white");
  const blackSummary = computeSummary(turns, "black");

  return { turns, equityHistory, whiteSummary, blackSummary };
}

/** Build a TurnAnalysis from gnubg scored results */
export function buildGnubgTurnAnalysis(
  turnNumber: number,
  player: Player,
  dice: [number, number],
  playedMoves: Move[],
  board: BoardState,
  gnubgResults: GnubgMoveResult[],
): TurnAnalysis {
  const playedKey = playedMoves.map((m) => `${m.from}/${m.to}`).sort().join(" ");

  const candidates: CandidateMove[] = [];
  let playedEquity: number | null = null;
  let bestEquity: number | null = null;
  let playedProbability: WinProbability | undefined;

  for (const result of gnubgResults) {
    const key = result.moves.map((m) => `${m.from}/${m.to}`).sort().join(" ");
    const isPlayed = key === playedKey;

    // gnubg equity is from current player's perspective — convert to white's
    const rawEq = result.evaluation?.eq ?? 0;
    const whiteEq = player === "white" ? rawEq : -rawEq;

    if (bestEquity === null) {
      bestEquity = whiteEq;
    }

    if (isPlayed) {
      playedEquity = whiteEq;
      playedProbability = result.evaluation?.probability;
    }

    candidates.push({
      moves: result.moves,
      notation: formatNotation(result.moves),
      equity: whiteEq,
      isPlayed,
      probability: result.evaluation?.probability,
    });
  }

  // Fallback if played move wasn't found in gnubg results
  if (playedEquity === null) {
    const playedBoard = applyMoveSequence(board, player, playedMoves);
    playedEquity = fallbackEquityWhite(playedBoard);

    candidates.push({
      moves: playedMoves,
      notation: formatNotation(playedMoves),
      equity: playedEquity,
      isPlayed: true,
    });
  }

  if (bestEquity === null) {
    bestEquity = playedEquity;
  }

  // Equity loss from the moving player's perspective
  const bestPlayerEq = candidates.length > 0 ? candidates[0].equity : playedEquity;
  const equityLoss = player === "white"
    ? Math.max(0, bestPlayerEq - playedEquity)
    : Math.max(0, playedEquity - bestPlayerEq);

  let topCandidates = candidates.slice(0, 5);
  if (!topCandidates.some((c) => c.isPlayed)) {
    const played = candidates.find((c) => c.isPlayed);
    if (played) {
      topCandidates = [...topCandidates.slice(0, 4), played];
    }
  }

  return {
    turnNumber,
    player,
    dice,
    playedMoves,
    playedNotation: formatNotation(playedMoves),
    equityAfter: playedEquity,
    bestEquity,
    equityLoss,
    errorClass: classifyError(equityLoss),
    candidates: topCandidates,
    boardBefore: board,
    probability: playedProbability,
  };
}

/** Fallback turn analysis when GNUBG fails for a specific turn */
function buildFallbackTurnAnalysis(
  turnNumber: number,
  player: Player,
  dice: [number, number],
  playedMoves: Move[],
  board: BoardState,
): TurnAnalysis {
  const diceArray = buildDiceArray(dice);
  const allSequences = generateAllMoveSequences(board, player, diceArray);
  const playedKey = playedMoves.map((m) => `${m.from}/${m.to}`).sort().join(" ");

  const scored: (CandidateMove & { playerEq: number })[] = [];

  if (allSequences.length === 0 || (allSequences.length === 1 && allSequences[0].length === 0)) {
    scored.push({
      moves: [],
      notation: "(no moves)",
      equity: fallbackEquityWhite(board),
      isPlayed: playedMoves.length === 0,
      playerEq: 0,
    });
  } else {
    for (const seq of allSequences) {
      const resultBoard = applyMoveSequence(board, player, seq);
      const whiteEq = fallbackEquityWhite(resultBoard);
      const key = seq.map((m) => `${m.from}/${m.to}`).sort().join(" ");
      scored.push({
        moves: seq,
        notation: formatNotation(seq),
        equity: whiteEq,
        isPlayed: key === playedKey,
        playerEq: player === "white" ? whiteEq : -whiteEq,
      });
    }
  }

  scored.sort((a, b) => b.playerEq - a.playerEq);

  // Deduplicate
  const seenMap = new Map<string, number>();
  const uniqueCandidates: CandidateMove[] = [];
  for (const { playerEq: _, ...c } of scored) {
    const key = c.moves.map((m) => `${m.from}/${m.to}`).sort().join(" ");
    const existing = seenMap.get(key);
    if (existing === undefined) {
      seenMap.set(key, uniqueCandidates.length);
      uniqueCandidates.push(c);
    } else if (c.isPlayed) {
      uniqueCandidates[existing] = { ...uniqueCandidates[existing], isPlayed: true };
    }
  }

  let topCandidates = uniqueCandidates.slice(0, 5);
  if (!topCandidates.some((c) => c.isPlayed)) {
    const playedCandidate = uniqueCandidates.find((c) => c.isPlayed);
    if (playedCandidate) {
      topCandidates = [...topCandidates.slice(0, 4), playedCandidate];
    }
  }

  const playedBoard = applyMoveSequence(board, player, playedMoves);
  const playedEquity = fallbackEquityWhite(playedBoard);
  const bestEquity = uniqueCandidates.length > 0 ? uniqueCandidates[0].equity : playedEquity;

  const bestPlayerEq = uniqueCandidates.length > 0
    ? (player === "white" ? uniqueCandidates[0].equity : -uniqueCandidates[0].equity)
    : (player === "white" ? playedEquity : -playedEquity);
  const playedPlayerEq = player === "white" ? playedEquity : -playedEquity;
  const equityLoss = Math.max(0, bestPlayerEq - playedPlayerEq);

  return {
    turnNumber,
    player,
    dice,
    playedMoves,
    playedNotation: formatNotation(playedMoves),
    equityAfter: playedEquity,
    bestEquity,
    equityLoss,
    errorClass: classifyError(equityLoss),
    candidates: topCandidates,
    boardBefore: board,
  };
}

/* ── Cube Decision Analysis ── */

export type CubeDecision = "double" | "no_double" | "take" | "drop";

export interface CubeAnalysis {
  turnNumber: number;
  player: Player;
  action: "offered" | "accepted" | "rejected";
  correctAction: CubeDecision;
  isCorrect: boolean;
  equityLoss: number;
  details: string;
}

/**
 * Analyze a cube decision using GNUBG equity probe.
 * Falls back to pip-count estimate if GNUBG is unavailable.
 *
 * Money game doubling theory:
 *   - Double when equity ≥ ~0.66
 *   - Take when equity ≥ -0.76 (opponent's equity ≤ 0.76)
 */
export async function analyzeCubeDecision(
  board: BoardState,
  player: Player,
  action: "offered" | "accepted" | "rejected",
  cubeValue: number,
): Promise<CubeAnalysis> {
  // Try to get GNUBG equity
  let playerEq: number;

  if (isGnubgReady()) {
    try {
      // Probe with a representative dice roll
      const results = await getGnubgMoves(board, player, [3, 1], {
        maxMoves: 1,
        scoreMoves: true,
      });
      playerEq = results.length > 0 && results[0].evaluation
        ? results[0].evaluation.eq
        : fallbackEquityWhite(board) * (player === "white" ? 1 : -1);
    } catch {
      playerEq = fallbackEquityWhite(board) * (player === "white" ? 1 : -1);
    }
  } else {
    playerEq = fallbackEquityWhite(board) * (player === "white" ? 1 : -1);
  }

  let correctAction: CubeDecision;
  let isCorrect: boolean;
  let equityLoss = 0;
  let details: string;

  if (action === "offered") {
    const shouldDouble = playerEq > 0.66;
    correctAction = shouldDouble ? "double" : "no_double";
    isCorrect = shouldDouble;
    equityLoss = shouldDouble ? 0 : Math.max(0, 0.66 - playerEq) * cubeValue * 0.1;
    details = shouldDouble
      ? `Correct double (equity: ${playerEq.toFixed(3)})`
      : `Premature double (equity: ${playerEq.toFixed(3)}, need > 0.66)`;
  } else if (action === "accepted") {
    // "player" here is the one accepting — their equity should be > -0.76
    const shouldTake = playerEq > -0.76;
    correctAction = shouldTake ? "take" : "drop";
    isCorrect = shouldTake;
    equityLoss = shouldTake ? 0 : Math.max(0, -0.76 - playerEq) * cubeValue * 0.1;
    details = shouldTake
      ? `Correct take (equity: ${playerEq.toFixed(3)})`
      : `Should have dropped (equity: ${playerEq.toFixed(3)}, too low)`;
  } else {
    // Rejected — was dropping correct?
    const shouldDrop = playerEq <= -0.76;
    correctAction = shouldDrop ? "drop" : "take";
    isCorrect = shouldDrop;
    equityLoss = shouldDrop ? 0 : Math.max(0, playerEq - (-0.76)) * cubeValue * 0.1;
    details = shouldDrop
      ? `Correct drop (equity: ${playerEq.toFixed(3)})`
      : `Should have taken (equity: ${playerEq.toFixed(3)}, enough to play)`;
  }

  return {
    turnNumber: 0,
    player,
    action,
    correctAction,
    isCorrect,
    equityLoss,
    details,
  };
}
