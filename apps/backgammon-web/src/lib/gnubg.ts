import type { BoardState, Move, Player } from "@xion-beginner/backgammon-core";
import type { GnubgRequest, GnubgResponse, GnubgRawMove } from "./gnubg.worker";

/* ── Public Result Types ── */

export interface GnubgMoveResult {
  moves: Move[];
  evaluation?: {
    eq: number;
    diff: number;
    probability?: {
      win: number;
      winG: number;
      winBG: number;
      lose: number;
      loseG: number;
      loseBG: number;
    };
  };
}

/* ── Worker Singleton ── */

let worker: Worker | null = null;
let workerReady = false;
let readyPromise: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (moves: GnubgRawMove[]) => void; reject: (err: Error) => void }
>();

function ensureWorker(): Promise<void> {
  if (readyPromise) return readyPromise;

  readyPromise = new Promise<void>((resolve, reject) => {
    try {
      worker = new Worker(
        new URL("./gnubg.worker.ts", import.meta.url),
      );
    } catch {
      readyPromise = null;
      reject(new Error("Failed to create gnubg worker"));
      return;
    }

    const initTimeout = setTimeout(() => {
      if (!workerReady) {
        console.warn("[GNUBG] WASM init timed out (30s)");
        readyPromise = null; // Allow retry
        reject(new Error("WASM init timed out (30s)"));
      }
    }, 30_000);

    worker.onmessage = (e: MessageEvent<GnubgResponse>) => {
      const msg = e.data;

      if (msg.type === "ready") {
        workerReady = true;
        clearTimeout(initTimeout);
        console.log("[GNUBG] WASM engine loaded and ready");
        resolve();
        return;
      }

      if (msg.type === "error" && msg.id === -1) {
        // Init error
        clearTimeout(initTimeout);
        console.warn("[GNUBG] WASM init failed:", msg.error);
        readyPromise = null; // Allow retry
        reject(new Error(msg.error));
        return;
      }

      if ((msg.type === "result" || msg.type === "error") && msg.id !== undefined) {
        const handler = pending.get(msg.id);
        if (handler) {
          pending.delete(msg.id);
          if (msg.type === "result") {
            handler.resolve(msg.moves);
          } else {
            handler.reject(new Error(msg.error));
          }
        }
      }
    };

    worker.onerror = (err) => {
      clearTimeout(initTimeout);
      if (!workerReady) {
        console.warn("[GNUBG] Worker error:", err.message);
        readyPromise = null; // Allow retry
        reject(new Error(`Worker error: ${err.message}`));
      }
    };
  });

  return readyPromise;
}

/** Check if the WASM engine is loaded and ready */
export function isGnubgReady(): boolean {
  return workerReady;
}

/** Preload the WASM engine (non-blocking, call early) */
export function preloadGnubg(): void {
  ensureWorker().catch(() => {
    // Preload failures are silent — callers check isGnubgReady()
  });
}

/** Wait for GNUBG to become ready. Kicks off loading if needed. */
export function waitForGnubg(): Promise<void> {
  return ensureWorker();
}

/* ── Board Format Translation ── */

/**
 * Convert our BoardState to bgweb's {x: {...}, o: {...}} format.
 * We always map the current player as "x" in the gnubg call.
 *
 * BoardState.points: [0]=white bar, [1-24]=points, [25]=black bar
 * Positive values = white checkers, negative = black checkers.
 *
 * GnuBG board: x plays from point 24 → 1, o plays from 1 → 24.
 * Points are keyed as strings "1"-"24" plus "bar".
 * Undefined (or omitted) means no checkers on that point.
 */
function boardToGnubg(
  board: BoardState,
  currentPlayer: Player,
): { x: Record<string, number | undefined>; o: Record<string, number | undefined> } {
  const x: Record<string, number | undefined> = {};
  const o: Record<string, number | undefined> = {};

  if (currentPlayer === "white") {
    // White = X (current player): white checkers on point i → x[i]
    // Black = O (opponent): black checkers on point i → o[25-i]
    for (let i = 1; i <= 24; i++) {
      const val = board.points[i];
      if (val > 0) {
        x[String(i)] = val;
      } else if (val < 0) {
        o[String(25 - i)] = -val;
      }
    }
    // Bar
    const whiteBar = board.points[0]; // white bar
    if (whiteBar > 0) x["bar"] = whiteBar;
    const blackBar = board.points[25]; // black bar
    if (blackBar < 0) o["bar"] = -blackBar;
  } else {
    // Black = X (current player): black checkers on point i → x[25-i]
    // White = O (opponent): white checkers on point i → o[i]
    for (let i = 1; i <= 24; i++) {
      const val = board.points[i];
      if (val < 0) {
        x[String(25 - i)] = -val;
      } else if (val > 0) {
        o[String(i)] = val;
      }
    }
    // Bar
    const blackBar = board.points[25]; // black bar
    if (blackBar < 0) x["bar"] = -blackBar;
    const whiteBar = board.points[0]; // white bar
    if (whiteBar > 0) o["bar"] = whiteBar;
  }

  return { x, o };
}

/**
 * Convert gnubg move result back to our Move[] format.
 * gnubg returns moves in X's perspective where X plays 24→1.
 *
 * CheckerPlay: { from: "n"|"bar", to: "n"|"off" }
 *
 * If currentPlayer=white: X's point n = our point n
 *   - "bar" → from: 0 (white bar)
 *   - "off" → to: 0 (white bear-off direction)
 *
 * If currentPlayer=black: X's point n = our point 25-n
 *   - "bar" → from: 25 (black bar)
 *   - "off" → to: 25 (black bear-off direction)
 */
export function gnubgMovesToOurs(
  plays: { from: string; to: string }[],
  currentPlayer: Player,
  dice: [number, number],
): Move[] {
  // Track which dice are available so we can assign the correct die
  // to each sub-move, especially for bear-off where multiple dice
  // can produce the same from→to (exact vs over-bear).
  const availableDice = dice[0] === dice[1]
    ? [dice[0], dice[0], dice[0], dice[0]]
    : [dice[0], dice[1]];

  return plays.map((play) => {
    let from: number;
    let to: number;

    if (play.from === "bar") {
      from = currentPlayer === "white" ? 0 : 25;
    } else {
      const n = parseInt(play.from, 10);
      from = currentPlayer === "white" ? n : 25 - n;
    }

    if (play.to === "off") {
      to = currentPlayer === "white" ? 0 : 25;
    } else {
      const n = parseInt(play.to, 10);
      to = currentPlayer === "white" ? n : 25 - n;
    }

    // Determine which die was used by matching against available dice.
    // In GNUBG's X-perspective, X plays 24→1:
    //   - Normal move: die = distance in GNUBG coords (from - to)
    //   - Bar entry: die = 25 - dest
    //   - Bear-off: die >= source point (exact or over-bear)
    let die: number;
    const gnubgFrom = parseInt(play.from, 10);

    if (play.to === "off") {
      // Bear-off: the die is >= gnubgFrom (source point in X-coords).
      // For exact bear-off, die === gnubgFrom. For over-bear, die > gnubgFrom.
      // Find the matching die from available dice.
      const exactIdx = availableDice.indexOf(gnubgFrom);
      if (exactIdx !== -1) {
        // Exact bear-off die available
        die = gnubgFrom;
        availableDice.splice(exactIdx, 1);
      } else {
        // Over-bear: find the smallest available die >= gnubgFrom
        const overBearIdx = availableDice.findIndex(d => d >= gnubgFrom);
        if (overBearIdx !== -1) {
          die = availableDice[overBearIdx];
          availableDice.splice(overBearIdx, 1);
        } else {
          die = gnubgFrom; // shouldn't happen, fallback
        }
      }
    } else if (play.from === "bar") {
      die = 25 - parseInt(play.to, 10);
      const idx = availableDice.indexOf(die);
      if (idx !== -1) availableDice.splice(idx, 1);
    } else {
      die = gnubgFrom - parseInt(play.to, 10);
      const idx = availableDice.indexOf(die);
      if (idx !== -1) availableDice.splice(idx, 1);
    }

    return { from, to, die };
  });
}

/* ── Public API ── */

/**
 * Get moves from the GNU Backgammon WASM engine.
 * Returns move candidates sorted best-first.
 */
export async function getGnubgMoves(
  board: BoardState,
  player: Player,
  dice: [number, number],
  options?: { maxMoves?: number; scoreMoves?: boolean; plies?: number; cubeful?: boolean },
): Promise<GnubgMoveResult[]> {
  await ensureWorker();

  const gnubgBoard = boardToGnubg(board, player);
  const id = nextId++;

  return new Promise<GnubgMoveResult[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("gnubg getMoves timed out (30s)"));
    }, 30_000);

    pending.set(id, {
      resolve: (rawMoves: GnubgRawMove[]) => {
        clearTimeout(timeout);
        const results: GnubgMoveResult[] = rawMoves.map((raw) => ({
          moves: gnubgMovesToOurs(
            (raw.play ?? []).map((p) => ({
              from: String(p.from),
              to: String(p.to),
            })),
            player,
            dice,
          ),
          evaluation: raw.evaluation
            ? {
                eq: raw.evaluation.eq,
                diff: raw.evaluation.diff,
                probability: raw.evaluation.probability,
              }
            : undefined,
        }));
        resolve(results);
      },
      reject: (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    worker!.postMessage({
      type: "getMoves",
      id,
      payload: {
        board: gnubgBoard,
        dice,
        maxMoves: options?.maxMoves,
        scoreMoves: options?.scoreMoves,
        plies: options?.plies,
        cubeful: options?.cubeful,
      },
    } satisfies GnubgRequest);
  });
}
