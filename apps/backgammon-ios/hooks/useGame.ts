import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  GameState,
  Player,
  Move,
  MatchState,
} from "@xion-beginner/backgammon-core";
import {
  canDouble as checkCanDouble,
  makeMove as coreMakeMove,
  getLegalFirstMoves,
} from "@xion-beginner/backgammon-core";
import { useWebSocket } from "./useWebSocket";

const CLEAR_LAST_MOVE_DELAY_MS = 3000;
const CLEAR_REACTION_DELAY_MS = 3000;
const DEFAULT_TURN_TIME_LIMIT_SEC = 60;

// ─── Types ──────────────────────────────────────────────────────

interface GameContext {
  gameId: string | null;
  myColor: Player | null;
  gameState: GameState | null;
  legalMoves: Move[];
  opponent: string | null;
  status: "idle" | "waiting" | "queued" | "playing" | "finished";
  winner: Player | null;
  resultType: string | null;
  opponentDisconnected: boolean;
  error: string | null;
  undoCount: number;
  turnStartedAt: number | null;
  turnTimeLimit: number;
  lastOpponentMove: { from: number; to: number } | null;
  lastReaction: { emoji: string; from: string } | null;
  pendingConfirmation: boolean;
  forcedMoveNotice: boolean;
  disconnectCountdown: number | null;
  doubleOffered: boolean;
  doubleOfferedBy: Player | null;
  matchState: MatchState | null;
  matchOver: boolean;
  bufferedMoves: { from: number; to: number }[];
  localGameState: GameState | null;
  localLegalMoves: Move[];
}

type GameAction =
  | { type: "GAME_CREATED"; gameId: string; color: Player }
  | {
      type: "GAME_JOINED";
      gameId: string;
      color: Player;
      opponent: string;
      opponentName?: string;
    }
  | {
      type: "GAME_START";
      gameId: string;
      white: string;
      black: string;
      whiteName?: string;
      blackName?: string;
      gameState: GameState;
      legalMoves: Move[];
      myAddress: string;
      matchState?: MatchState | null;
      turnTimeLimit?: number;
      needsConfirmation?: boolean;
    }
  | {
      type: "GAME_SYNC";
      gameState: GameState;
      legalMoves: Move[];
      needsConfirmation?: boolean;
    }
  | {
      type: "DICE_ROLLED";
      gameState: GameState;
      legalMoves: Move[];
      player: Player;
      needsConfirmation?: boolean;
    }
  | {
      type: "MOVE_MADE";
      gameState: GameState;
      legalMoves: Move[];
      player: Player;
      move: Move;
      needsConfirmation?: boolean;
    }
  | { type: "MOVE_UNDONE"; gameState: GameState; legalMoves: Move[] }
  | { type: "TURN_ENDED"; gameState: GameState }
  | {
      type: "GAME_OVER";
      winner: Player;
      resultType: string;
      gameState: GameState;
      matchState?: MatchState | null;
      matchOver?: boolean;
    }
  | {
      type: "NEXT_GAME";
      gameId: string;
      gameState: GameState;
      matchState: MatchState;
      myAddress: string;
      white: string;
      black: string;
    }
  | { type: "OPPONENT_DISCONNECTED" }
  | { type: "OPPONENT_RECONNECTED" }
  | { type: "QUEUED" }
  | { type: "QUEUE_LEFT" }
  | { type: "ERROR"; message: string }
  | { type: "RESET" }
  | { type: "CLEAR_LAST_MOVE" }
  | { type: "FORCED_MOVE_NOTICE"; on: boolean }
  | { type: "OPPONENT_DISCONNECTING"; countdown: number }
  | { type: "DISCONNECT_COUNTDOWN"; countdown: number }
  | { type: "REACTION_RECEIVED"; emoji: string; from: string }
  | { type: "CLEAR_REACTION" }
  | { type: "DOUBLE_OFFERED"; player: Player; cubeValue: number }
  | { type: "DOUBLE_ACCEPTED"; cubeValue: number; cubeOwner: Player }
  | { type: "DOUBLE_REJECTED"; winner: Player }
  | { type: "LOCAL_MOVE"; from: number; to: number; die: number; newState: GameState; legalMoves: Move[] }
  | { type: "LOCAL_UNDO" }
  | { type: "CLEAR_BUFFER" };

const initialGameContext: GameContext = {
  gameId: null,
  myColor: null,
  gameState: null,
  legalMoves: [],
  opponent: null,
  status: "idle",
  winner: null,
  resultType: null,
  opponentDisconnected: false,
  error: null,
  undoCount: 0,
  turnStartedAt: null,
  turnTimeLimit: DEFAULT_TURN_TIME_LIMIT_SEC,
  lastOpponentMove: null,
  lastReaction: null,
  pendingConfirmation: false,
  forcedMoveNotice: false,
  disconnectCountdown: null,
  doubleOffered: false,
  doubleOfferedBy: null,
  matchState: null,
  matchOver: false,
  bufferedMoves: [],
  localGameState: null,
  localLegalMoves: [],
};

// ─── Reducer ────────────────────────────────────────────────────

function gameReducer(state: GameContext, action: GameAction): GameContext {
  switch (action.type) {
    case "GAME_CREATED":
      return {
        ...state,
        gameId: action.gameId,
        myColor: action.color,
        status: "waiting",
        error: null,
      };
    case "GAME_JOINED":
      return {
        ...state,
        gameId: action.gameId,
        myColor: action.color,
        opponent: action.opponentName || action.opponent,
        status: "waiting",
        error: null,
      };
    case "GAME_START": {
      const myColor =
        state.myColor ||
        (action.white === action.myAddress ? "white" : "black");
      const opponent =
        myColor === "white"
          ? action.blackName || action.black
          : action.whiteName || action.white;
      return {
        ...state,
        gameId: action.gameId,
        myColor,
        opponent,
        gameState: action.gameState,
        status: "playing",
        legalMoves: action.legalMoves,
        error: null,
        undoCount: 0,
        turnStartedAt: action.gameState.dice ? Date.now() : null,
        lastOpponentMove: null,
        doubleOffered: false,
        doubleOfferedBy: null,
        matchState: action.matchState ?? state.matchState,
        matchOver: false,
        winner: null,
        resultType: null,
        turnTimeLimit: action.turnTimeLimit ?? state.turnTimeLimit,
        pendingConfirmation: action.needsConfirmation ?? false,
      };
    }
    case "GAME_SYNC":
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        turnStartedAt:
          state.turnStartedAt ??
          (action.gameState.dice !== null ? Date.now() : null),
        pendingConfirmation:
          action.needsConfirmation ?? state.pendingConfirmation,
      };
    case "DICE_ROLLED":
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        undoCount: 0,
        turnStartedAt: Date.now(),
        lastOpponentMove: null,
        pendingConfirmation: action.needsConfirmation ? true : false,
        doubleOffered: false,
        doubleOfferedBy: null,
        bufferedMoves: [],
        localGameState: null,
        localLegalMoves: [],
      };
    case "MOVE_MADE": {
      const iMadeIt =
        state.myColor !== null && action.player === state.myColor;
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        undoCount: iMadeIt ? state.undoCount + 1 : state.undoCount,
        lastOpponentMove: !iMadeIt
          ? { from: action.move.from, to: action.move.to }
          : state.lastOpponentMove,
        pendingConfirmation:
          iMadeIt && action.needsConfirmation
            ? true
            : state.pendingConfirmation,
      };
    }
    case "MOVE_UNDONE":
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        undoCount: Math.max(0, state.undoCount - 1),
      };
    case "TURN_ENDED":
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: [],
        undoCount: 0,
        turnStartedAt: null,
        pendingConfirmation: false,
        doubleOffered: false,
        doubleOfferedBy: null,
      };
    case "GAME_OVER":
      return {
        ...state,
        gameState: action.gameState,
        winner: action.winner,
        resultType: action.resultType,
        status: "finished",
        legalMoves: [],
        turnStartedAt: null,
        pendingConfirmation: false,
        matchState: action.matchState ?? state.matchState,
        matchOver: action.matchOver ?? false,
      };
    case "NEXT_GAME": {
      const myColor =
        action.white === action.myAddress ? "white" : "black";
      return {
        ...initialGameContext,
        gameId: action.gameId,
        myColor,
        gameState: action.gameState,
        status: "playing",
        matchState: action.matchState,
        opponent: state.opponent,
      };
    }
    case "OPPONENT_DISCONNECTED":
      return { ...state, opponentDisconnected: true };
    case "OPPONENT_RECONNECTED":
      return {
        ...state,
        opponentDisconnected: false,
        disconnectCountdown: null,
      };
    case "QUEUED":
      return { ...state, status: "queued", error: null };
    case "QUEUE_LEFT":
      return { ...state, status: "idle" };
    case "ERROR":
      return { ...state, error: action.message };
    case "RESET":
      return initialGameContext;
    case "CLEAR_LAST_MOVE":
      return { ...state, lastOpponentMove: null };
    case "FORCED_MOVE_NOTICE":
      return { ...state, forcedMoveNotice: action.on };
    case "OPPONENT_DISCONNECTING":
      return { ...state, disconnectCountdown: action.countdown };
    case "DISCONNECT_COUNTDOWN":
      return { ...state, disconnectCountdown: action.countdown };
    case "REACTION_RECEIVED":
      return {
        ...state,
        lastReaction: { emoji: action.emoji, from: action.from },
      };
    case "CLEAR_REACTION":
      return { ...state, lastReaction: null };
    case "DOUBLE_OFFERED":
      return {
        ...state,
        doubleOffered: true,
        doubleOfferedBy: action.player,
      };
    case "DOUBLE_ACCEPTED":
      return {
        ...state,
        doubleOffered: false,
        doubleOfferedBy: null,
        gameState: state.gameState
          ? {
              ...state.gameState,
              cubeValue: action.cubeValue,
              cubeOwner: action.cubeOwner,
            }
          : null,
      };
    case "DOUBLE_REJECTED":
      return {
        ...state,
        winner: action.winner,
        status: "finished",
        doubleOffered: false,
        doubleOfferedBy: null,
      };
    case "LOCAL_MOVE":
      return {
        ...state,
        localGameState: action.newState,
        localLegalMoves: action.legalMoves,
        bufferedMoves: [
          ...state.bufferedMoves,
          { from: action.from, to: action.to },
        ],
      };
    case "LOCAL_UNDO": {
      const moves = state.bufferedMoves.slice(0, -1);
      if (moves.length === 0) {
        return {
          ...state,
          bufferedMoves: [],
          localGameState: null,
          localLegalMoves: [],
        };
      }
      // Replay moves from server state to reconstruct local state
      let gs = state.gameState!;
      for (const m of moves) {
        const next = coreMakeMove(gs, m.from, m.to);
        if (next) gs = next;
      }
      const legal =
        gs.movesRemaining.length > 0
          ? getLegalFirstMoves(gs.board, gs.currentPlayer, gs.movesRemaining)
          : [];
      return {
        ...state,
        bufferedMoves: moves,
        localGameState: gs,
        localLegalMoves: legal,
      };
    }
    case "CLEAR_BUFFER":
      return {
        ...state,
        bufferedMoves: [],
        localGameState: null,
        localLegalMoves: [],
      };
    default:
      return state;
  }
}

// ─── Hook ───────────────────────────────────────────────────────

export function useGame(wsUrl: string, address: string | null) {
  const { connect, sendMessage, connected, on } = useWebSocket(wsUrl);
  const [state, dispatch] = useReducer(gameReducer, initialGameContext);
  const addressRef = useRef(address);
  addressRef.current = address;
  const myColorRef = useRef(state.myColor);
  myColorRef.current = state.myColor;
  const stateRef = useRef(state);
  stateRef.current = state;
  const flushingRef = useRef(false);

  const authSentRef = useRef(false);
  const [authenticated, setAuthenticated] = useState(false);

  // Connect when address is available
  useEffect(() => {
    if (address) {
      connect();
    }
  }, [address, connect]);

  // Listen for auth_challenge — send unsigned auth (MVP: no wallet signing)
  useEffect(() => {
    const unsub = on("auth_challenge", () => {
      if (!addressRef.current || authSentRef.current) return;
      sendMessage({ type: "auth", address: addressRef.current });
      authSentRef.current = true;
    });
    return unsub;
  }, [on, sendMessage]);

  // Listen for auth_ok
  useEffect(() => {
    const unsub = on("auth_ok", () => setAuthenticated(true));
    return unsub;
  }, [on]);

  // Reset auth on disconnect
  useEffect(() => {
    if (!connected) {
      setAuthenticated(false);
      authSentRef.current = false;
      if (state.status === "queued") {
        dispatch({ type: "QUEUE_LEFT" });
      }
    }
  }, [connected, state.status]);

  // Register message handlers
  useEffect(() => {
    const unsubs = [
      on("game_created", (msg) =>
        dispatch({
          type: "GAME_CREATED",
          gameId: msg.game_id as string,
          color: msg.color as Player,
        }),
      ),
      on("game_joined", (msg) =>
        dispatch({
          type: "GAME_JOINED",
          gameId: msg.game_id as string,
          color: msg.color as Player,
          opponent: msg.opponent as string,
          opponentName: msg.opponent_name as string | undefined,
        }),
      ),
      on("game_start", (msg) => {
        const gameId = msg.game_id as string;
        const gs = msg.game_state as GameState;
        const legalMoves = (msg.legal_moves || []) as Move[];
        sendMessage({ type: "rejoin_game", game_id: gameId });

        if (
          stateRef.current.status === "playing" &&
          stateRef.current.gameId === gameId
        ) {
          dispatch({
            type: "GAME_SYNC",
            gameState: gs,
            legalMoves,
            needsConfirmation: msg.needs_confirmation as boolean | undefined,
          });
          return;
        }

        dispatch({
          type: "GAME_START",
          gameId,
          white: msg.white as string,
          black: msg.black as string,
          whiteName: msg.white_name as string | undefined,
          blackName: msg.black_name as string | undefined,
          gameState: gs,
          legalMoves,
          myAddress: addressRef.current || "",
          matchState: msg.match_state as MatchState | undefined,
          turnTimeLimit: msg.turn_time_limit as number | undefined,
          needsConfirmation: msg.needs_confirmation as boolean | undefined,
        });
      }),
      on("dice_rolled", (msg) => {
        flushingRef.current = false;
        dispatch({
          type: "DICE_ROLLED",
          gameState: msg.game_state as GameState,
          legalMoves: (msg.legal_moves || []) as Move[],
          player: msg.player as Player,
          needsConfirmation: msg.needs_confirmation as boolean | undefined,
        });
      }),
      on("move_made", (msg) => {
        const player = msg.player as Player;
        const move = msg.move as Move;
        const gs = msg.game_state as GameState;
        if (flushingRef.current && player === myColorRef.current) {
          dispatch({
            type: "MOVE_MADE",
            gameState: gs,
            legalMoves: (msg.legal_moves || []) as Move[],
            player,
            move,
            needsConfirmation: msg.needs_confirmation as boolean | undefined,
          });
          return;
        }
        dispatch({
          type: "MOVE_MADE",
          gameState: gs,
          legalMoves: (msg.legal_moves || []) as Move[],
          player,
          move,
          needsConfirmation: msg.needs_confirmation as boolean | undefined,
        });
      }),
      on("move_undone", (msg) => {
        dispatch({
          type: "MOVE_UNDONE",
          gameState: msg.game_state as GameState,
          legalMoves: (msg.legal_moves || []) as Move[],
        });
      }),
      on("turn_ended", (msg) => {
        flushingRef.current = false;
        dispatch({ type: "TURN_ENDED", gameState: msg.game_state as GameState });
      }),
      on("game_over", (msg) => {
        flushingRef.current = false;
        dispatch({
          type: "GAME_OVER",
          winner: msg.winner as Player,
          resultType: msg.result_type as string,
          gameState: msg.game_state as GameState,
          matchState: msg.match_state as MatchState | undefined,
          matchOver: msg.match_over as boolean | undefined,
        });
      }),
      on("next_game", (msg) => {
        dispatch({
          type: "NEXT_GAME",
          gameId: msg.game_id as string,
          gameState: msg.game_state as GameState,
          matchState: msg.match_state as MatchState,
          myAddress: addressRef.current || "",
          white: msg.white as string,
          black: msg.black as string,
        });
      }),
      on("double_offered", (msg) =>
        dispatch({
          type: "DOUBLE_OFFERED",
          player: msg.player as Player,
          cubeValue: msg.cube_value as number,
        }),
      ),
      on("double_accepted", (msg) =>
        dispatch({
          type: "DOUBLE_ACCEPTED",
          cubeValue: msg.cube_value as number,
          cubeOwner: msg.cube_owner as Player,
        }),
      ),
      on("double_rejected", (msg) =>
        dispatch({ type: "DOUBLE_REJECTED", winner: msg.winner as Player }),
      ),
      on("opponent_disconnected", () =>
        dispatch({ type: "OPPONENT_DISCONNECTED" }),
      ),
      on("opponent_reconnected", () =>
        dispatch({ type: "OPPONENT_RECONNECTED" }),
      ),
      on("opponent_disconnecting", (msg) =>
        dispatch({
          type: "OPPONENT_DISCONNECTING",
          countdown: msg.grace_seconds as number,
        }),
      ),
      on("disconnect_countdown", (msg) =>
        dispatch({
          type: "DISCONNECT_COUNTDOWN",
          countdown: msg.seconds_remaining as number,
        }),
      ),
      on("queue_joined", () => dispatch({ type: "QUEUED" })),
      on("queue_left", () => dispatch({ type: "QUEUE_LEFT" })),
      on("error", (msg) =>
        dispatch({ type: "ERROR", message: msg.message as string }),
      ),
      on("reaction", (msg) =>
        dispatch({
          type: "REACTION_RECEIVED",
          emoji: msg.emoji as string,
          from: msg.from as string,
        }),
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [on, sendMessage]);

  // Clear last opponent move after delay
  useEffect(() => {
    if (state.lastOpponentMove) {
      const timer = setTimeout(
        () => dispatch({ type: "CLEAR_LAST_MOVE" }),
        CLEAR_LAST_MOVE_DELAY_MS,
      );
      return () => clearTimeout(timer);
    }
  }, [state.lastOpponentMove]);

  // Clear reaction after delay
  useEffect(() => {
    if (state.lastReaction) {
      const timer = setTimeout(
        () => dispatch({ type: "CLEAR_REACTION" }),
        CLEAR_REACTION_DELAY_MS,
      );
      return () => clearTimeout(timer);
    }
  }, [state.lastReaction]);

  // ─── Actions ──────────────────────────────────────────────────

  const createGame = useCallback(
    (wagerAmount: number, matchLength?: number, timeControl?: number) => {
      sendMessage({
        type: "create_game",
        wager_amount: wagerAmount,
        match_length: matchLength,
        time_control: timeControl,
      });
    },
    [sendMessage],
  );

  const joinGame = useCallback(
    (gameId: string) => {
      sendMessage({ type: "join_game", game_id: gameId });
    },
    [sendMessage],
  );

  const joinQueue = useCallback(
    (wagerAmount: number, matchLength: number = 1) => {
      sendMessage({
        type: "join_queue",
        wager_amount: wagerAmount,
        match_length: matchLength,
      });
    },
    [sendMessage],
  );

  const leaveQueue = useCallback(() => {
    sendMessage({ type: "leave_queue" });
  }, [sendMessage]);

  const rollDice = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "roll_dice", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const makeMove = useCallback(
    (from: number, to: number) => {
      if (!state.gameId) return;
      const currentState =
        stateRef.current.localGameState || stateRef.current.gameState;
      if (!currentState) return;
      const newState = coreMakeMove(currentState, from, to);
      if (!newState) return;
      const oldMoves = [...currentState.movesRemaining];
      const newMoves = [...newState.movesRemaining];
      let die = oldMoves[0] || 0;
      for (const d of oldMoves) {
        const idx = newMoves.indexOf(d);
        if (idx === -1) {
          die = d;
          break;
        }
        newMoves.splice(idx, 1);
      }
      const legalMoves =
        newState.movesRemaining.length > 0
          ? getLegalFirstMoves(
              newState.board,
              newState.currentPlayer,
              newState.movesRemaining,
            )
          : [];
      dispatch({ type: "LOCAL_MOVE", from, to, die, newState, legalMoves });
    },
    [state.gameId],
  );

  const endTurn = useCallback(() => {
    if (!state.gameId) return;
    const moves = stateRef.current.bufferedMoves;
    if (moves.length > 0) {
      flushingRef.current = true;
      for (const m of moves) {
        sendMessage({
          type: "move",
          game_id: state.gameId!,
          from: m.from,
          to: m.to,
        });
      }
      sendMessage({ type: "end_turn", game_id: state.gameId! });
      dispatch({ type: "CLEAR_BUFFER" });
    } else {
      sendMessage({ type: "end_turn", game_id: state.gameId });
    }
  }, [sendMessage, state.gameId]);

  const undoMove = useCallback(() => {
    if (!state.gameId) return;
    if (stateRef.current.bufferedMoves.length > 0) {
      dispatch({ type: "LOCAL_UNDO" });
    } else {
      sendMessage({ type: "undo_move", game_id: state.gameId });
    }
  }, [sendMessage, state.gameId]);

  const resign = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "resign", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const offerDouble = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "offer_double", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const acceptDouble = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "accept_double", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const rejectDouble = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "reject_double", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const sendReaction = useCallback(
    (emoji: string) => {
      if (state.gameId) {
        sendMessage({ type: "reaction", game_id: state.gameId, emoji });
      }
    },
    [sendMessage, state.gameId],
  );

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  const myCanDouble =
    state.gameState && state.myColor
      ? checkCanDouble(state.gameState, state.myColor)
      : false;

  const hasBuffer = state.bufferedMoves.length > 0;
  const effectiveGameState = hasBuffer
    ? state.localGameState
    : state.gameState;
  const effectiveLegalMoves = hasBuffer
    ? state.localLegalMoves
    : state.legalMoves;
  const bufferPendingConfirmation =
    hasBuffer && state.localLegalMoves.length === 0;

  return {
    ...state,
    gameState: effectiveGameState,
    legalMoves: effectiveLegalMoves,
    canUndo: hasBuffer || state.undoCount > 0 || state.pendingConfirmation,
    pendingConfirmation:
      bufferPendingConfirmation || state.pendingConfirmation,
    canDouble: myCanDouble,
    connected,
    authenticated,
    createGame,
    joinGame,
    joinQueue,
    leaveQueue,
    rollDice,
    makeMove,
    endTurn,
    undoMove,
    resign,
    offerDouble,
    acceptDouble,
    rejectDouble,
    sendReaction,
    reset,
  };
}
