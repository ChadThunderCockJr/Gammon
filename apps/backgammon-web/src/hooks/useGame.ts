import { useCallback, useEffect, useReducer, useRef } from "react";
import type { GameState, MatchState, Move, Player } from "@xion-beginner/backgammon-core";
import { canDouble as checkCanDouble, getLegalFirstMoves, makeMove as coreMakeMove } from "@xion-beginner/backgammon-core";
import { useWebSocket } from "./useWebSocket";
import { useServerSession } from "./useServerSession";
import { playCheckerHit, playCheckerPlace, playDiceRoll, playGameOver, playTurnEnd } from "@/lib/sounds";
import { CLEAR_LAST_MOVE_DELAY_MS, CLEAR_REACTION_DELAY_MS } from "@/lib/constants";
import type { GameAction, GameContext } from "./useGame.types";
import { initialGameContext } from "./useGame.types";
import { gameReducer } from "./useGame.reducer";

export type { GameAction, GameContext };
export { initialGameContext };

type IncomingMessage = Record<string, unknown> & { type: string };
type BufferedFlush = { gameId: string; moves: Array<{ from: number; to: number }>; nextIndex: number };
function readPendingDouble(value: unknown): { player: Player; cubeValue: number; deadlineAt: string } | null {
  if (!value || typeof value !== "object") return null;
  const pending = value as Record<string, unknown>;
  if (
    (pending.player !== "white" && pending.player !== "black")
    || typeof pending.cube_value !== "number"
    || !Number.isFinite(pending.cube_value)
    || typeof pending.deadline_at !== "string"
    || !Number.isFinite(Date.parse(pending.deadline_at))
  ) return null;
  return { player: pending.player, cubeValue: pending.cube_value, deadlineAt: pending.deadline_at };
}

function routedWebSocketUrl(wsUrl: string, gameId: string | null | undefined): string {
  if (!gameId) return wsUrl;
  const url = new URL(wsUrl, typeof window === "undefined" ? "ws://localhost" : window.location.href);
  url.searchParams.set("game_id", gameId);
  return url.toString();
}


export function useGame(wsUrl: string, address: string | null, routingGameId?: string | null) {
  const { connect, disconnect, sendMessage, connected, on } = useWebSocket(routedWebSocketUrl(wsUrl, routingGameId));
  const secureSession = useServerSession();
  const [state, dispatch] = useReducer(gameReducer, initialGameContext);
  const addressRef = useRef(address);
  const myColorRef = useRef(state.myColor);
  const stateRef = useRef(state);
  const revisionRef = useRef(0);
  const flushRef = useRef<BufferedFlush | null>(null);
  addressRef.current = address;
  myColorRef.current = state.myColor;
  stateRef.current = state;

  const applyRevision = useCallback((message: IncomingMessage): number => {
    const revision = message.revision;
    if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) {
      revisionRef.current = revision;
      dispatch({ type: "SET_REVISION", revision });
      return revision;
    }
    return revisionRef.current;
  }, []);

  const sendMutation = useCallback((type: string, payload: Record<string, unknown> = {}, expectedRevision = revisionRef.current): boolean => {
    return sendMessage({
      type,
      ...payload,
      command_id: crypto.randomUUID(),
      expected_revision: expectedRevision,
    });
  }, [sendMessage]);

  useEffect(() => {
    if (!address || secureSession.status !== "ready") {
      disconnect();
      return;
    }
    connect();
    return disconnect;
  }, [address, connect, disconnect, secureSession.status]);

  useEffect(() => {
    if (!connected && stateRef.current.status === "queued") dispatch({ type: "QUEUE_LEFT" });
  }, [connected]);

  useEffect(() => {
    if (secureSession.status === "error") dispatch({ type: "ERROR", message: secureSession.error });
  }, [secureSession.error, secureSession.status]);

  useEffect(() => {
    const unsubs = [
      on("game_created", (message) => {
        applyRevision(message);
        dispatch({ type: "GAME_CREATED", gameId: message.game_id as string, color: message.color as Player });
      }),
      on("game_joined", (message) => {
        applyRevision(message);
        dispatch({
          type: "GAME_JOINED",
          gameId: message.game_id as string,
          color: message.color as Player,
          opponent: message.opponent as string,
          opponentName: message.opponent_name as string | undefined,
        });
      }),
      on("game_start", (message) => {
        applyRevision(message);
        const gameId = message.game_id as string;
        const gameState = message.game_state as GameState;
        const legalMoves = (message.legal_moves ?? []) as Move[];
        const pendingDouble = readPendingDouble(message.pending_double);
        if (stateRef.current.status === "playing" && stateRef.current.gameId === gameId) {
          dispatch({
            type: "GAME_SYNC",
            gameState,
            legalMoves,
            needsConfirmation: message.needs_confirmation as boolean | undefined,
            pendingDouble,
          });
          return;
        }
        dispatch({
          type: "GAME_START",
          gameId,
          white: message.white as string,
          black: message.black as string,
          whiteName: message.white_name as string | undefined,
          blackName: message.black_name as string | undefined,
          gameState,
          legalMoves,
          myAddress: addressRef.current ?? "",
          matchState: message.match_state as MatchState | undefined,
          turnTimeLimit: message.turn_time_limit as number | undefined,
          needsConfirmation: message.needs_confirmation as boolean | undefined,
          pendingDouble,
        });
      }),
      on("dice_rolled", (message) => {
        applyRevision(message);
        playDiceRoll();
        dispatch({
          type: "DICE_ROLLED",
          gameState: message.game_state as GameState,
          legalMoves: (message.legal_moves ?? []) as Move[],
          player: message.player as Player,
          needsConfirmation: message.needs_confirmation as boolean | undefined,
        });
      }),
      on("move_made", (message) => {
        const revision = applyRevision(message);
        const player = message.player as Player;
        const move = message.move as Move;
        const ownMove = player === myColorRef.current;
        if (ownMove) playCheckerPlace();
        else playCheckerHit();
        dispatch({
          type: "MOVE_MADE",
          gameState: message.game_state as GameState,
          legalMoves: (message.legal_moves ?? []) as Move[],
          player,
          move,
          needsConfirmation: message.needs_confirmation as boolean | undefined,
        });
        const flush = flushRef.current;
        if (!ownMove || !flush) return;
        if (flush.nextIndex < flush.moves.length) {
          const next = flush.moves[flush.nextIndex];
          flush.nextIndex += 1;
          sendMutation("move", { game_id: flush.gameId, from: next.from, to: next.to }, revision);
        } else {
          flushRef.current = null;
          sendMutation("end_turn", { game_id: flush.gameId }, revision);
        }
      }),
      on("move_undone", (message) => {
        applyRevision(message);
        dispatch({ type: "MOVE_UNDONE", gameState: message.game_state as GameState, legalMoves: (message.legal_moves ?? []) as Move[] });
      }),
      on("turn_ended", (message) => {
        flushRef.current = null;
        applyRevision(message);
        playTurnEnd();
        dispatch({ type: "TURN_ENDED", gameState: message.game_state as GameState });
      }),
      on("game_over", (message) => {
        flushRef.current = null;
        applyRevision(message);
        const winner = message.winner as Player;
        playGameOver(winner === myColorRef.current);
        dispatch({
          type: "GAME_OVER",
          winner,
          resultType: message.result_type as string,
          gameState: message.game_state as GameState,
          matchState: message.match_state as MatchState | undefined,
          matchOver: message.match_over as boolean | undefined,
        });
      }),
      on("next_game", (message) => {
        applyRevision(message);
        dispatch({
          type: "NEXT_GAME",
          gameId: message.game_id as string,
          gameState: message.game_state as GameState,
          matchState: message.match_state as MatchState,
          myAddress: addressRef.current ?? "",
          white: message.white as string,
          black: message.black as string,
        });
      }),
      on("double_offered", (message) => {
        applyRevision(message);
        if (
          (message.player !== "white" && message.player !== "black")
          || typeof message.cube_value !== "number"
          || typeof message.deadline_at !== "string"
          || !Number.isFinite(Date.parse(message.deadline_at))
        ) return;
        dispatch({
          type: "DOUBLE_OFFERED",
          player: message.player,
          cubeValue: message.cube_value,
          deadlineAt: message.deadline_at,
        });
      }),
      on("double_accepted", (message) => {
        applyRevision(message);
        dispatch({ type: "DOUBLE_ACCEPTED", cubeValue: message.cube_value as number, cubeOwner: message.cube_owner as Player });
      }),
      on("double_rejected", (message) => {
        applyRevision(message);
        dispatch({ type: "DOUBLE_REJECTED", winner: message.winner as Player });
      }),
      on("game_review", (message) => {
        applyRevision(message);
        dispatch({
          type: "GAME_REVIEW",
          reason: typeof message.reason === "string" ? message.reason : "manual_review",
        });
      }),
      on("opponent_disconnected", () => dispatch({ type: "OPPONENT_DISCONNECTED" })),
      on("opponent_reconnected", () => dispatch({ type: "OPPONENT_RECONNECTED" })),
      on("opponent_disconnecting", (message) => dispatch({ type: "OPPONENT_DISCONNECTING", countdown: message.grace_seconds as number })),
      on("disconnect_countdown", (message) => dispatch({ type: "DISCONNECT_COUNTDOWN", countdown: message.seconds_remaining as number })),
      on("queue_joined", () => dispatch({ type: "QUEUED" })),
      on("queue_left", () => dispatch({ type: "QUEUE_LEFT" })),
      on("error", (message) => {
        flushRef.current = null;
        dispatch({ type: "CLEAR_BUFFER" });
        dispatch({ type: "ERROR", message: typeof message.message === "string" ? message.message : "The game request failed" });
        const code = message.code;
        if (code === "GAME_OWNER_ROUTING_REQUIRED" || code === "GAME_OWNERSHIP_LOST") {
          disconnect();
          connect();
          return;
        }
        if (stateRef.current.gameId) sendMessage({ type: "rejoin_game", game_id: stateRef.current.gameId });
      }),
      on("reaction", (message) => dispatch({ type: "REACTION_RECEIVED", emoji: message.emoji as string, from: message.from as string })),
    ];
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [applyRevision, connect, disconnect, on, sendMessage, sendMutation]);

  useEffect(() => {
    if (!state.lastOpponentMove) return;
    const timer = window.setTimeout(() => dispatch({ type: "CLEAR_LAST_MOVE" }), CLEAR_LAST_MOVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state.lastOpponentMove]);

  useEffect(() => {
    if (!state.lastReaction) return;
    const timer = window.setTimeout(() => dispatch({ type: "CLEAR_REACTION" }), CLEAR_REACTION_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state.lastReaction]);

  const createGame = useCallback((matchLength = 1, timeControl = 60) => {
    sendMessage({ type: "create_game", wager_amount: 0, match_length: matchLength, time_control: timeControl });
  }, [sendMessage]);

  const joinGame = useCallback((gameId: string) => {
    sendMessage({ type: "join_game", game_id: gameId });
  }, [sendMessage]);

  const joinCashGame = useCallback((quoteId: string) => {
    sendMessage({ type: "join_cash_game", quote_id: quoteId });
  }, [sendMessage]);

  const joinQueue = useCallback((matchLength = 1) => {
    sendMessage({ type: "join_queue", wager_amount: 0, match_length: matchLength });
  }, [sendMessage]);

  const leaveQueue = useCallback(() => { sendMessage({ type: "leave_queue" }); }, [sendMessage]);
  const retryConnection = useCallback(() => {
    connect();
  }, [connect]);


  const rollDice = useCallback(() => {
    if (stateRef.current.gameId) sendMutation("roll_dice", { game_id: stateRef.current.gameId });
  }, [sendMutation]);

  const makeMove = useCallback((from: number, to: number) => {
    if (!stateRef.current.gameId) return;
    const current = stateRef.current.localGameState ?? stateRef.current.gameState;
    if (!current) return;
    const next = coreMakeMove(current, from, to);
    if (!next) return;
    const remaining = [...next.movesRemaining];
    let die = current.movesRemaining[0] ?? 0;
    for (const candidate of current.movesRemaining) {
      const index = remaining.indexOf(candidate);
      if (index === -1) { die = candidate; break; }
      remaining.splice(index, 1);
    }
    const legalMoves = next.movesRemaining.length > 0
      ? getLegalFirstMoves(next.board, next.currentPlayer, next.movesRemaining)
      : [];
    dispatch({ type: "LOCAL_MOVE", from, to, die, newState: next, legalMoves });
  }, []);

  const endTurn = useCallback(() => {
    const gameId = stateRef.current.gameId;
    if (!gameId || flushRef.current) return;
    const moves = [...stateRef.current.bufferedMoves];
    if (moves.length === 0) {
      sendMutation("end_turn", { game_id: gameId });
      return;
    }
    flushRef.current = { gameId, moves, nextIndex: 1 };
    dispatch({ type: "CLEAR_BUFFER" });
    sendMutation("move", { game_id: gameId, from: moves[0].from, to: moves[0].to });
  }, [sendMutation]);

  const undoMove = useCallback(() => {
    const gameId = stateRef.current.gameId;
    if (!gameId || flushRef.current) return;
    if (stateRef.current.bufferedMoves.length > 0) dispatch({ type: "LOCAL_UNDO" });
    else sendMutation("undo_move", { game_id: gameId });
  }, [sendMutation]);

  const resign = useCallback(() => {
    if (stateRef.current.gameId) sendMutation("resign", { game_id: stateRef.current.gameId });
  }, [sendMutation]);
  const offerDouble = useCallback(() => {
    if (stateRef.current.gameId) sendMutation("offer_double", { game_id: stateRef.current.gameId });
  }, [sendMutation]);
  const acceptDouble = useCallback(() => {
    if (stateRef.current.gameId) sendMutation("accept_double", { game_id: stateRef.current.gameId });
  }, [sendMutation]);
  const rejectDouble = useCallback(() => {
    if (stateRef.current.gameId) sendMutation("reject_double", { game_id: stateRef.current.gameId });
  }, [sendMutation]);
  const requestCashReview = useCallback(() => {
    if (stateRef.current.gameId) sendMutation("request_cash_review", { game_id: stateRef.current.gameId });
  }, [sendMutation]);
  const sendReaction = useCallback((emoji: string) => {
    if (stateRef.current.gameId) sendMessage({ type: "reaction", game_id: stateRef.current.gameId, emoji });
  }, [sendMessage]);
  const reset = useCallback(() => {
    flushRef.current = null;
    revisionRef.current = 0;
    dispatch({ type: "RESET" });
  }, []);

  const hasBuffer = state.bufferedMoves.length > 0;
  const gameState = hasBuffer ? state.localGameState : state.gameState;
  const legalMoves = hasBuffer ? state.localLegalMoves : state.legalMoves;
  const authenticated = connected && secureSession.status === "ready";

  return {
    ...state,
    gameState,
    legalMoves,
    canUndo: hasBuffer || state.undoCount > 0 || state.pendingConfirmation,
    pendingConfirmation: (hasBuffer && state.localLegalMoves.length === 0) || state.pendingConfirmation,
    canDouble: gameState && gameState.turnNumber > 0 && state.myColor && !state.matchState?.isCrawford
      ? checkCanDouble(gameState, state.myColor)
      : false,
    connected,
    authenticated,
    sessionStatus: secureSession.status,
    retrySession: secureSession.retry,
    createGame,
    joinGame,
    joinCashGame,
    joinQueue,
    leaveQueue,
    retryConnection,
    rollDice,
    makeMove,
    endTurn,
    undoMove,
    resign,
    offerDouble,
    acceptDouble,
    rejectDouble,
    requestCashReview,
    sendReaction,
    reset,
  };
}
