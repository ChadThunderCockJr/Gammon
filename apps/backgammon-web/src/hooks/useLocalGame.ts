"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { GameState, Player, Move } from "@xion-beginner/backgammon-core";
import {
  createGameState,
  setDice,
  makeMove as coreMakeMove,
  endTurn as coreEndTurn,
  getLegalFirstMoves,
  getLegalNextMoves,
} from "@xion-beginner/backgammon-core";
import {
  playDiceRoll,
  playCheckerPlace,
  playCheckerHit,
  playTurnEnd,
  playGameOver,
} from "@/lib/sounds";
import { selectAIMove, getThinkingDelay, shouldAIDouble, shouldAIAcceptDouble, type AIDifficulty } from "@/lib/ai";
import { preloadGnubg } from "@/lib/gnubg";
import { MOVE_ANIMATION_STEP_MS } from "@/lib/constants";
import { recordAIGameResult } from "@/lib/local-stats";

// ── Persistence ───────────────────────────────────────────────

const STORAGE_KEY = "backgammon-ai-game";

export interface TurnRecord {
  player: Player;
  dice: [number, number];
  moves: { from: number; to: number; die: number }[];
  boardBefore?: { points: number[]; whiteOff: number; blackOff: number };
}

interface PersistedState {
  gameState: GameState;
  myColor: Player;
  opponent: string;
  winner: Player | null;
  resultType: string | null;
  undoStack: GameState[];
  movesMade: Move[];
  difficulty: AIDifficulty;
  cubeValue: number;
  cubeOwner: Player | null;
  doubleOffered: boolean;
  doubleOfferedBy: Player | null;
  turnHistory?: TurnRecord[];
  currentTurnDice?: [number, number] | null;
  turnStartBoard?: { points: number[]; whiteOff: number; blackOff: number } | null;
}

function saveToStorage(state: LocalGameState, difficulty: AIDifficulty) {
  try {
    const data: PersistedState = {
      gameState: state.gameState,
      myColor: state.myColor,
      opponent: state.opponent,
      winner: state.winner,
      resultType: state.resultType,
      undoStack: state.undoStack,
      movesMade: state.movesMade,
      difficulty,
      cubeValue: state.cubeValue,
      cubeOwner: state.cubeOwner,
      doubleOffered: state.doubleOffered,
      doubleOfferedBy: state.doubleOfferedBy,
      turnHistory: state.turnHistory,
      currentTurnDice: state.currentTurnDice,
      turnStartBoard: state.turnStartBoard,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function loadFromStorage(difficulty: AIDifficulty): LocalGameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data: PersistedState = JSON.parse(raw);
    if (data.difficulty !== difficulty) return null;
    if (!data.gameState?.board?.points) return null;

    const gs = data.gameState;
    const myColor = data.myColor;
    const isMyTurn = gs.currentPlayer === myColor;

    // If it was the AI's turn mid-move, clear dice so the AI effect re-triggers
    if (!isMyTurn && !gs.gameOver) {
      gs.dice = null;
      gs.movesRemaining = [];
    }

    // Recompute legalMoves
    let legalMoves: Move[] = [];
    if (isMyTurn && gs.dice && !gs.gameOver && gs.movesRemaining.length > 0) {
      if (data.movesMade.length === 0) {
        legalMoves = getLegalFirstMoves(gs.board, gs.currentPlayer, gs.movesRemaining);
      } else {
        const origDice: number[] = gs.dice[0] === gs.dice[1]
          ? [gs.dice[0], gs.dice[0], gs.dice[0], gs.dice[0]]
          : [gs.dice[0], gs.dice[1]];
        const origBoard = data.undoStack.length > 0 ? data.undoStack[0].board : gs.board;
        legalMoves = getLegalNextMoves(origBoard, gs.currentPlayer, origDice, data.movesMade);
      }
    }

    return {
      gameState: gs,
      myColor,
      legalMoves,
      opponent: data.opponent,
      winner: data.winner,
      resultType: data.resultType,
      undoStack: data.undoStack,
      movesMade: data.movesMade,
      turnStartedAt: gs.gameOver ? null : Date.now(),
      lastOpponentMove: null,
      forcedMoveNotice: false,
      cubeValue: data.cubeValue ?? 1,
      cubeOwner: data.cubeOwner ?? null,
      doubleOffered: data.doubleOffered ?? false,
      doubleOfferedBy: data.doubleOfferedBy ?? null,
      turnHistory: data.turnHistory ?? [],
      aiMovesMade: [],
      currentTurnDice: data.currentTurnDice ?? null,
      turnStartBoard: data.turnStartBoard ?? null,
    };
  } catch {
    return null;
  }
}

function clearStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ── State ──────────────────────────────────────────────────────

interface LocalGameState {
  gameState: GameState;
  myColor: Player;
  legalMoves: Move[];
  opponent: string;
  winner: Player | null;
  resultType: string | null;
  undoStack: GameState[];
  movesMade: Move[];
  turnStartedAt: number | null;
  lastOpponentMove: { from: number; to: number } | null;
  forcedMoveNotice: boolean;
  cubeValue: number;
  cubeOwner: Player | null;
  doubleOffered: boolean;
  doubleOfferedBy: Player | null;
  turnHistory: TurnRecord[];
  aiMovesMade: Move[];
  currentTurnDice: [number, number] | null;
  turnStartBoard: { points: number[]; whiteOff: number; blackOff: number } | null;
}

type Action =
  | { type: "RESTORE"; state: LocalGameState }
  | { type: "ROLL_DICE"; die1: number; die2: number }
  | { type: "MOVE_MADE"; newState: GameState; move: Move; forced?: boolean }
  | { type: "UNDO" }
  | { type: "END_TURN" }
  | { type: "AI_ROLLED"; gameState: GameState; legalMoves: Move[] }
  | { type: "AI_MOVED"; gameState: GameState; move: Move }
  | { type: "AI_TURN_ENDED"; gameState: GameState }
  | { type: "GAME_OVER"; winner: Player; resultType: string; gameState: GameState; finalMove?: Move }
  | { type: "CLEAR_LAST_MOVE" }
  | { type: "CLEAR_FORCED_NOTICE" }
  | { type: "RESET"; opponent: string }
  | { type: "OFFER_DOUBLE" }
  | { type: "ACCEPT_DOUBLE" }
  | { type: "REJECT_DOUBLE" }
  | { type: "AI_OFFER_DOUBLE" }
  | { type: "AI_ACCEPT_DOUBLE" }
  | { type: "AI_REJECT_DOUBLE" };

function createInitialState(difficulty: AIDifficulty): LocalGameState {
  const label =
    difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
  return {
    gameState: createGameState(),
    myColor: "white",
    legalMoves: [],
    opponent: `AI (${label})`,
    winner: null,
    resultType: null,
    undoStack: [],
    movesMade: [],
    turnStartedAt: null,
    lastOpponentMove: null,
    forcedMoveNotice: false,
    cubeValue: 1,
    cubeOwner: null,
    doubleOffered: false,
    doubleOfferedBy: null,
    turnHistory: [],
    aiMovesMade: [],
    currentTurnDice: null,
    turnStartBoard: null,
  };
}

function reducer(state: LocalGameState, action: Action): LocalGameState {
  switch (action.type) {
    case "RESTORE":
      return action.state;
    case "ROLL_DICE": {
      const gs = setDice(state.gameState, action.die1, action.die2);
      const legalMoves = getLegalFirstMoves(
        gs.board,
        gs.currentPlayer,
        gs.movesRemaining
      );
      // If no legal moves, auto-end turn happens via effect
      return {
        ...state,
        gameState: gs,
        legalMoves,
        undoStack: [],
        movesMade: [],
        turnStartedAt: Date.now(),
        forcedMoveNotice: false,
        currentTurnDice: [action.die1, action.die2],
        turnStartBoard: { points: [...gs.board.points], whiteOff: gs.board.whiteOff, blackOff: gs.board.blackOff },
      };
    }
    case "MOVE_MADE": {
      const prevGs = state.gameState;
      const gs = action.newState;
      const forced = action.forced ? true : state.forcedMoveNotice;

      // Game over — end immediately
      if (gs.gameOver) {
        return {
          ...state,
          gameState: gs,
          legalMoves: [],
          undoStack: [],
          movesMade: [],
          winner: gs.winner,
          resultType: gs.resultType,
          forcedMoveNotice: forced,
        };
      }

      const turnFlipped = gs.currentPlayer !== prevGs.currentPlayer;

      // More moves remaining — compute legal moves for the next step
      if (!turnFlipped && gs.movesRemaining.length > 0) {
        const newMovesMade = [...state.movesMade, action.move];
        const legalMoves = getLegalNextMoves(
          prevGs.dice ? state.undoStack.length > 0 ? state.undoStack[0].board : prevGs.board : prevGs.board,
          gs.currentPlayer,
          prevGs.dice ? (prevGs.dice[0] === prevGs.dice[1] ? [prevGs.dice[0], prevGs.dice[0], prevGs.dice[0], prevGs.dice[0]] : [prevGs.dice[0], prevGs.dice[1]]) : [],
          newMovesMade
        );
        return {
          ...state,
          gameState: gs,
          legalMoves,
          undoStack: [...state.undoStack, prevGs],
          movesMade: newMovesMade,
          forcedMoveNotice: forced,
        };
      }

      // All dice used or no legal moves left — wait for human to confirm.
      // Override currentPlayer back to human so the Confirm button shows
      // and undo still works. END_TURN will flip to AI.
      const pendingGs: GameState = {
        ...gs,
        currentPlayer: prevGs.currentPlayer,
        dice: prevGs.dice,
        movesRemaining: [],
      };
      return {
        ...state,
        gameState: pendingGs,
        legalMoves: [],
        undoStack: [...state.undoStack, prevGs],
        movesMade: [...state.movesMade, action.move],
        forcedMoveNotice: forced,
      };
    }
    case "UNDO": {
      if (state.undoStack.length === 0) return state;
      const prevGs = state.undoStack[state.undoStack.length - 1];
      const newStack = state.undoStack.slice(0, -1);
      const newMovesMade = state.movesMade.slice(0, -1);
      const legalMoves =
        newMovesMade.length === 0
          ? getLegalFirstMoves(
              prevGs.board,
              prevGs.currentPlayer,
              prevGs.movesRemaining
            )
          : getLegalNextMoves(
              newStack.length > 0 ? newStack[0].board : prevGs.board,
              prevGs.currentPlayer,
              prevGs.dice
                ? prevGs.dice[0] === prevGs.dice[1]
                  ? [prevGs.dice[0], prevGs.dice[0], prevGs.dice[0], prevGs.dice[0]]
                  : [prevGs.dice[0], prevGs.dice[1]]
                : [],
              newMovesMade
            );
      return {
        ...state,
        gameState: prevGs,
        legalMoves,
        undoStack: newStack,
        movesMade: newMovesMade,
      };
    }
    case "END_TURN": {
      // Record this turn before ending
      const turnRecord: TurnRecord | null = state.currentTurnDice ? {
        player: state.gameState.currentPlayer,
        dice: state.currentTurnDice,
        moves: state.movesMade.map(m => ({ from: m.from, to: m.to, die: m.die })),
        boardBefore: state.turnStartBoard ?? undefined,
      } : null;
      const gs = coreEndTurn(state.gameState);
      return {
        ...state,
        gameState: gs,
        legalMoves: [],
        undoStack: [],
        movesMade: [],
        turnStartedAt: Date.now(),
        turnHistory: turnRecord ? [...state.turnHistory, turnRecord] : state.turnHistory,
        currentTurnDice: null,
        turnStartBoard: null,
      };
    }
    case "AI_ROLLED":
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        turnStartedAt: Date.now(),
        currentTurnDice: action.gameState.dice,
        aiMovesMade: [],
        turnStartBoard: { points: [...action.gameState.board.points], whiteOff: action.gameState.board.whiteOff, blackOff: action.gameState.board.blackOff },
      };
    case "AI_MOVED":
      return {
        ...state,
        gameState: action.gameState,
        lastOpponentMove: { from: action.move.from, to: action.move.to },
        aiMovesMade: [...state.aiMovesMade, action.move],
      };
    case "AI_TURN_ENDED": {
      const aiTurnRecord: TurnRecord | null = state.currentTurnDice ? {
        player: state.myColor === "white" ? "black" : "white",
        dice: state.currentTurnDice,
        moves: state.aiMovesMade.map(m => ({ from: m.from, to: m.to, die: m.die })),
        boardBefore: state.turnStartBoard ?? undefined,
      } : null;
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: [],
        turnStartedAt: Date.now(),
        turnHistory: aiTurnRecord ? [...state.turnHistory, aiTurnRecord] : state.turnHistory,
        aiMovesMade: [],
        currentTurnDice: null,
        turnStartBoard: null,
      };
    }
    case "GAME_OVER": {
      // Record the final turn if there are pending moves
      // GAME_OVER is dispatched instead of MOVE_MADE/AI_MOVED for the winning move,
      // so the winning move is NOT in movesMade/aiMovesMade yet — append it.
      const pendingMoves = state.movesMade.length > 0 ? state.movesMade : state.aiMovesMade;
      const allMoves = action.finalMove ? [...pendingMoves, action.finalMove] : pendingMoves;
      const finalTurnRecord: TurnRecord | null = state.currentTurnDice && allMoves.length > 0 ? {
        player: state.gameState.currentPlayer,
        dice: state.currentTurnDice,
        moves: allMoves.map(m => ({ from: m.from, to: m.to, die: m.die })),
        boardBefore: state.turnStartBoard ?? undefined,
      } : null;
      return {
        ...state,
        gameState: action.gameState,
        winner: action.winner,
        resultType: action.resultType,
        legalMoves: [],
        undoStack: [],
        movesMade: [],
        turnStartedAt: null,
        turnHistory: finalTurnRecord ? [...state.turnHistory, finalTurnRecord] : state.turnHistory,
        aiMovesMade: [],
        currentTurnDice: null,
        turnStartBoard: null,
      };
    }
    case "OFFER_DOUBLE":
      return {
        ...state,
        doubleOffered: true,
        doubleOfferedBy: state.myColor,
      };
    case "AI_ACCEPT_DOUBLE":
      return {
        ...state,
        cubeValue: state.cubeValue * 2,
        cubeOwner: state.myColor === "white" ? "black" : "white",
        doubleOffered: false,
        doubleOfferedBy: null,
      };
    case "AI_REJECT_DOUBLE": {
      return {
        ...state,
        doubleOffered: false,
        doubleOfferedBy: null,
        winner: state.myColor,
        resultType: "normal",
        gameState: { ...state.gameState, gameOver: true, winner: state.myColor, resultType: "normal" },
        legalMoves: [],
        undoStack: [],
        movesMade: [],
        turnStartedAt: null,
      };
    }
    case "AI_OFFER_DOUBLE":
      return {
        ...state,
        doubleOffered: true,
        doubleOfferedBy: state.myColor === "white" ? "black" : "white",
      };
    case "ACCEPT_DOUBLE":
      return {
        ...state,
        cubeValue: state.cubeValue * 2,
        cubeOwner: state.myColor,
        doubleOffered: false,
        doubleOfferedBy: null,
      };
    case "REJECT_DOUBLE": {
      const aiColor: Player = state.myColor === "white" ? "black" : "white";
      return {
        ...state,
        doubleOffered: false,
        doubleOfferedBy: null,
        winner: aiColor,
        resultType: "normal",
        gameState: { ...state.gameState, gameOver: true, winner: aiColor, resultType: "normal" },
        legalMoves: [],
        undoStack: [],
        movesMade: [],
        turnStartedAt: null,
      };
    }
    case "CLEAR_LAST_MOVE":
      return { ...state, lastOpponentMove: null };
    case "CLEAR_FORCED_NOTICE":
      return { ...state, forcedMoveNotice: false };
    case "RESET":
      return { ...createInitialState("beginner" as AIDifficulty), opponent: action.opponent };
    default:
      return state;
  }
}

// ── Hook ───────────────────────────────────────────────────────

export function useLocalGame(difficulty: AIDifficulty) {
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;

  const [state, dispatch] = useReducer(reducer, difficulty, createInitialState);

  // Load persisted state from localStorage on mount (client-only).
  // Must be useEffect (not init function) to avoid hydration mismatch.
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    const saved = loadFromStorage(difficulty);
    if (saved) {
      dispatch({ type: "RESTORE", state: saved });
    }
  }, [difficulty]);

  // Persist to localStorage whenever state changes (except transient fields)
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    // Skip saving on initial render and RESTORE (avoid saving the just-loaded state)
    if (
      prev.gameState === state.gameState &&
      prev.legalMoves === state.legalMoves &&
      prev.undoStack === state.undoStack
    ) {
      return;
    }
    saveToStorage(state, difficultyRef.current);
  }, [state]);

  // Preload WASM engine for all AI difficulties
  useEffect(() => {
    preloadGnubg();
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;
  const aiAbortRef = useRef<(() => void) | null>(null);
  const aiThinkingRef = useRef(false);

  // Record AI game result to local stats when game ends
  const gameRecordedRef = useRef(false);
  useEffect(() => {
    if (state.winner && !gameRecordedRef.current) {
      gameRecordedRef.current = true;
      recordAIGameResult(
        state.myColor, state.winner, state.resultType ?? "normal",
        difficultyRef.current, state.turnHistory,
      );
    }
    if (!state.winner) {
      gameRecordedRef.current = false;
    }
  }, [state.winner, state.myColor, state.resultType, state.turnHistory]);

  // ── Human actions ───────────────────────────────────────────

  const rollDice = useCallback(() => {
    const s = stateRef.current;
    if (s.gameState.currentPlayer !== s.myColor) return;
    if (s.gameState.dice !== null) return;
    if (s.gameState.gameOver) return;

    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    playDiceRoll();
    dispatch({ type: "ROLL_DICE", die1, die2 });
  }, []);

  const makeMove = useCallback((from: number, to: number) => {
    const s = stateRef.current;
    if (s.gameState.currentPlayer !== s.myColor) return;
    if (s.gameState.gameOver) return;

    const result = coreMakeMove(s.gameState, from, to);
    if (!result) return;

    // Find which die was consumed by diffing movesRemaining
    const before = s.gameState.movesRemaining;
    const after = result.movesRemaining;
    const afterCopy = [...after];
    let usedDie = Math.abs(from - to); // fallback
    for (const d of before) {
      const idx = afterCopy.indexOf(d);
      if (idx !== -1) {
        afterCopy.splice(idx, 1);
      } else {
        usedDie = d;
        break;
      }
    }

    // Detect hit — was there an opponent checker at destination?
    const prevVal = s.gameState.board.points[to];
    const isHit =
      (s.myColor === "white" && prevVal === -1) ||
      (s.myColor === "black" && prevVal === 1);

    if (isHit) {
      playCheckerHit();
    } else {
      playCheckerPlace();
    }

    if (result.gameOver) {
      playGameOver(result.winner === s.myColor);
      dispatch({
        type: "GAME_OVER",
        winner: result.winner!,
        resultType: result.resultType!,
        gameState: result,
        finalMove: { from, to, die: usedDie },
      });
      return;
    }

    dispatch({
      type: "MOVE_MADE",
      newState: result,
      move: { from, to, die: usedDie },
    });
  }, []);

  const endTurn = useCallback(() => {
    const s = stateRef.current;
    if (s.gameState.currentPlayer !== s.myColor) return;
    playTurnEnd();
    dispatch({ type: "END_TURN" });
  }, []);

  const undoMove = useCallback(() => {
    dispatch({ type: "UNDO" });
  }, []);

  const offerDouble = useCallback(() => {
    const s = stateRef.current;
    if (s.gameState.currentPlayer !== s.myColor) return;
    if (s.gameState.dice !== null) return;
    if (s.gameState.gameOver) return;
    if (s.doubleOffered) return;
    if (s.cubeValue >= 64) return;
    if (s.cubeOwner !== null && s.cubeOwner !== s.myColor) return;
    dispatch({ type: "OFFER_DOUBLE" });
  }, []);

  const acceptDouble = useCallback(() => {
    const s = stateRef.current;
    if (!s.doubleOffered) return;
    if (s.doubleOfferedBy === s.myColor) return; // Can't accept own double
    dispatch({ type: "ACCEPT_DOUBLE" });
  }, []);

  const rejectDouble = useCallback(() => {
    const s = stateRef.current;
    if (!s.doubleOffered) return;
    if (s.doubleOfferedBy === s.myColor) return;
    playGameOver(false);
    dispatch({ type: "REJECT_DOUBLE" });
  }, []);

  const resign = useCallback(() => {
    const s = stateRef.current;
    const opponentColor: Player = s.myColor === "white" ? "black" : "white";
    playGameOver(false);
    dispatch({
      type: "GAME_OVER",
      winner: opponentColor,
      resultType: "normal",
      gameState: { ...s.gameState, gameOver: true, winner: opponentColor, resultType: "normal" },
    });
  }, []);

  const reset = useCallback(() => {
    if (aiAbortRef.current) aiAbortRef.current();
    aiThinkingRef.current = false;
    clearStorage();
    const label =
      difficultyRef.current.charAt(0).toUpperCase() +
      difficultyRef.current.slice(1);
    dispatch({ type: "RESET", opponent: `AI (${label})` });
  }, []);

  // ── AI responds to human's double offer ─────────────────────

  useEffect(() => {
    const s = stateRef.current;
    if (!s.doubleOffered || s.doubleOfferedBy !== s.myColor) return;
    if (s.gameState.gameOver) return;

    const aiColor: Player = s.myColor === "white" ? "black" : "white";
    const delay = getThinkingDelay(difficultyRef.current);

    const t = setTimeout(async () => {
      const current = stateRef.current;
      if (!current.doubleOffered || current.doubleOfferedBy !== current.myColor) return;

      const accepts = await shouldAIAcceptDouble(
        current.gameState.board,
        aiColor,
        current.cubeValue,
        difficultyRef.current
      );

      if (accepts) {
        dispatch({ type: "AI_ACCEPT_DOUBLE" });
      } else {
        playGameOver(true);
        dispatch({ type: "AI_REJECT_DOUBLE" });
      }
    }, delay);

    return () => clearTimeout(t);
  }, [state.doubleOffered, state.doubleOfferedBy]);

  // ── Always require manual confirmation — no auto-play, no auto-end ──
  // When no legal moves remain (after roll or mid-turn), the Confirm button
  // shows automatically via canEndTurn in GameScreen. Player must tap it.

  // ── AI turn ─────────────────────────────────────────────────

  useEffect(() => {
    const s = stateRef.current;
    if (s.gameState.currentPlayer === s.myColor) return;
    if (s.gameState.gameOver) return;
    if (s.gameState.dice !== null) return; // AI already rolled
    if (aiThinkingRef.current) return;
    if (s.doubleOffered) return; // Wait for human to respond to AI's double

    aiThinkingRef.current = true;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const cleanup = () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    aiAbortRef.current = cleanup;

    const thinkDelay = getThinkingDelay(difficultyRef.current);

    // Check if AI should offer a double before rolling
    const aiColor: Player = s.myColor === "white" ? "black" : "white";
    const canAIDouble =
      s.cubeValue < 64 &&
      (s.cubeOwner === null || s.cubeOwner === aiColor);

    // Async: check doubling then proceed to roll
    (async () => {
      try {
        if (canAIDouble) {
          const wantsDouble = await shouldAIDouble(
            s.gameState.board, aiColor, s.cubeValue, difficultyRef.current
          );
          if (cancelled) return;
          if (wantsDouble) {
            const t0 = setTimeout(() => {
              if (cancelled) return;
              aiThinkingRef.current = false;
              dispatch({ type: "AI_OFFER_DOUBLE" });
            }, thinkDelay);
            timers.push(t0);
            return; // Don't roll — wait for human response
          }
        }

        // Step 1: think, then roll
        const t1 = setTimeout(() => {
          if (cancelled) return;

          const die1 = Math.floor(Math.random() * 6) + 1;
          const die2 = Math.floor(Math.random() * 6) + 1;
          playDiceRoll();

          const currentGs = stateRef.current.gameState;
          const gs = setDice(currentGs, die1, die2);
          const aiColor = gs.currentPlayer;
          const legalMoves = getLegalFirstMoves(gs.board, aiColor, gs.movesRemaining);

          dispatch({ type: "AI_ROLLED", gameState: gs, legalMoves });

          // Step 2: select and play moves (async for WASM GM engine)
          (async () => {
            try {
              const moves = await selectAIMove(
                gs.board,
                aiColor,
                gs.movesRemaining,
                difficultyRef.current
              );

              if (cancelled) return;

              if (!moves || moves.length === 0) {
                // No legal moves — end turn
                const t2 = setTimeout(() => {
                  if (cancelled) return;
                  playTurnEnd();
                  const ended = coreEndTurn(gs);
                  aiThinkingRef.current = false;
                  dispatch({ type: "AI_TURN_ENDED", gameState: ended });
                }, 750);
                timers.push(t2);
                return;
              }

              // Animate moves one by one
              let currentBoard = gs;
              let moveFailed = false;

              moves.forEach((move, i) => {
                const delay = MOVE_ANIMATION_STEP_MS + i * MOVE_ANIMATION_STEP_MS;
                const t = setTimeout(() => {
                  if (cancelled || moveFailed) return;

                  const result = coreMakeMove(currentBoard, move.from, move.to, move.die);
                  if (!result) {
                    console.error("[AI] coreMakeMove failed for move", i, move, "board:", currentBoard);
                    moveFailed = true;
                    // End turn gracefully on invalid move
                    playTurnEnd();
                    const ended = coreEndTurn(currentBoard);
                    aiThinkingRef.current = false;
                    dispatch({ type: "AI_TURN_ENDED", gameState: ended });
                    return;
                  }
                  currentBoard = result;

                  // Detect hit
                  const prevVal = stateRef.current.gameState.board.points[move.to];
                  const isHit =
                    (aiColor === "white" && prevVal === -1) ||
                    (aiColor === "black" && prevVal === 1);
                  if (isHit) {
                    playCheckerHit();
                  } else {
                    playCheckerPlace();
                  }

                  if (result.gameOver) {
                    playGameOver(result.winner !== stateRef.current.myColor);
                    aiThinkingRef.current = false;
                    dispatch({
                      type: "GAME_OVER",
                      winner: result.winner!,
                      resultType: result.resultType!,
                      gameState: result,
                      finalMove: move,
                    });
                    return;
                  }

                  dispatch({ type: "AI_MOVED", gameState: result, move });

                  // After last move, end turn
                  if (i === moves.length - 1) {
                    const tEnd = setTimeout(() => {
                      if (cancelled) return;
                      // If turn hasn't auto-ended (currentPlayer already flipped), manually end
                      const latest = stateRef.current.gameState;
                      if (latest.currentPlayer !== stateRef.current.myColor && !latest.gameOver) {
                        playTurnEnd();
                        const ended = coreEndTurn(latest);
                        aiThinkingRef.current = false;
                        dispatch({ type: "AI_TURN_ENDED", gameState: ended });
                      } else {
                        // Turn already flipped via makeMove auto-end
                        aiThinkingRef.current = false;
                        dispatch({ type: "AI_TURN_ENDED", gameState: latest });
                      }
                    }, 500);
                    timers.push(tEnd);
                  }
                }, delay);
                timers.push(t);
              });
            } catch (err) {
              console.error("[AI] Move selection failed:", err);
              const ended = coreEndTurn(gs);
              aiThinkingRef.current = false;
              dispatch({ type: "AI_TURN_ENDED", gameState: ended });
            }
          })();
        }, thinkDelay);
        timers.push(t1);
      } catch (err) {
        console.error("[AI] Turn failed:", err);
        aiThinkingRef.current = false;
      }
    })(); // end async doubling/roll IIFE

    return () => {
      cleanup();
      aiThinkingRef.current = false;
    };
    // Deps: re-run when currentPlayer, gameOver, or doubleOffered changes.
    // DO NOT include dice — AI_ROLLED changes dice mid-callback,
    // which would trigger cleanup and cancel the move timers.
  }, [state.gameState.currentPlayer, state.gameState.gameOver, state.doubleOffered]);

  // ── Clear last opponent move after 3s ───────────────────────

  useEffect(() => {
    if (state.lastOpponentMove) {
      const t = setTimeout(() => dispatch({ type: "CLEAR_LAST_MOVE" }), 3000);
      return () => clearTimeout(t);
    }
  }, [state.lastOpponentMove]);

  // ── Clear forced move notice after 2s ─────────────────────

  useEffect(() => {
    if (state.forcedMoveNotice) {
      const t = setTimeout(() => dispatch({ type: "CLEAR_FORCED_NOTICE" }), 2000);
      return () => clearTimeout(t);
    }
  }, [state.forcedMoveNotice]);

  const isMyTurn = state.gameState.currentPlayer === state.myColor;
  const canDouble =
    isMyTurn &&
    state.gameState.dice === null &&
    !state.gameState.gameOver &&
    !state.doubleOffered &&
    state.cubeValue < 64 &&
    (state.cubeOwner === null || state.cubeOwner === state.myColor);

  return {
    gameState: state.gameState,
    myColor: state.myColor,
    legalMoves: state.legalMoves,
    opponent: state.opponent,
    opponentDisconnected: false,
    winner: state.winner,
    resultType: state.resultType,
    canUndo: state.undoStack.length > 0,
    turnStartedAt: state.turnStartedAt,
    lastOpponentMove: state.lastOpponentMove,
    forcedMoveNotice: state.forcedMoveNotice,
    cubeValue: state.cubeValue,
    cubeOwner: state.cubeOwner,
    doubleOffered: state.doubleOffered,
    doubleOfferedBy: state.doubleOfferedBy,
    canDouble,
    turnHistory: state.turnHistory,
    rollDice,
    makeMove,
    endTurn,
    undoMove,
    resign,
    reset,
    offerDouble,
    acceptDouble,
    rejectDouble,
  };
}
