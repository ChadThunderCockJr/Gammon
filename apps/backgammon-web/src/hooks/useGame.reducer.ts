import type { GameState, Move } from "@xion-beginner/backgammon-core";
import {
  makeMove as coreMakeMove,
  getLegalFirstMoves,
} from "@xion-beginner/backgammon-core";
import type { TurnRecord } from "./useLocalGame";
import type { GameContext, GameAction } from "./useGame.types";
import { initialGameContext } from "./useGame.types";

export function gameReducer(state: GameContext, action: GameAction): GameContext {
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
      const opponent = myColor === "white"
        ? (action.blackName || action.black)
        : (action.whiteName || action.white);
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
        turnHistory: [],
        currentTurnPlayer: null,
        currentTurnDice: null,
        currentTurnMoves: [],
        turnStartBoard: null,
        matchState: action.matchState ?? state.matchState,
        matchOver: false,
        winner: null,
        resultType: null,
        turnTimeLimit: action.turnTimeLimit ?? state.turnTimeLimit,
        pendingConfirmation: action.needsConfirmation ?? false,
        matchTurnHistory: [],
      };
    }
    case "GAME_SYNC": {
      const hasDice = action.gameState.dice !== null;
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        turnStartedAt: state.turnStartedAt ?? (hasDice ? Date.now() : null),
        pendingConfirmation: action.needsConfirmation ?? state.pendingConfirmation,
      };
    }
    case "DICE_ROLLED": {
      const board = action.gameState.board;
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
        currentTurnPlayer: action.player,
        currentTurnDice: action.gameState.dice,
        currentTurnMoves: [],
        turnStartBoard: { points: [...board.points], whiteOff: board.whiteOff, blackOff: board.blackOff },
        bufferedMoves: [],
        localGameState: null,
        localLegalMoves: [],
      };
    }
    case "MOVE_MADE": {
      const iMadeIt = state.myColor !== null && action.player === state.myColor;
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        undoCount: iMadeIt ? state.undoCount + 1 : state.undoCount,
        lastOpponentMove: !iMadeIt
          ? { from: action.move.from, to: action.move.to }
          : state.lastOpponentMove,
        pendingConfirmation: iMadeIt && action.needsConfirmation ? true : state.pendingConfirmation,
        currentTurnMoves: [...state.currentTurnMoves, { from: action.move.from, to: action.move.to, die: action.move.die }],
      };
    }
    case "MOVE_UNDONE":
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: action.legalMoves,
        undoCount: Math.max(0, state.undoCount - 1),
        currentTurnMoves: state.currentTurnMoves.slice(0, -1),
      };
    case "TURN_ENDED": {
      const turnRecord: TurnRecord | null = state.currentTurnDice ? {
        player: state.currentTurnPlayer ?? state.gameState?.currentPlayer ?? "white",
        dice: state.currentTurnDice,
        moves: state.currentTurnMoves,
        boardBefore: state.turnStartBoard ?? undefined,
      } : null;
      return {
        ...state,
        gameState: action.gameState,
        legalMoves: [],
        undoCount: 0,
        turnStartedAt: null,
        pendingConfirmation: false,
        doubleOffered: false,
        doubleOfferedBy: null,
        turnHistory: turnRecord ? [...state.turnHistory, turnRecord] : state.turnHistory,
        currentTurnPlayer: null,
        currentTurnDice: null,
        currentTurnMoves: [],
        turnStartBoard: null,
        bufferedMoves: [],
        localGameState: null,
        localLegalMoves: [],
      };
    }
    case "GAME_OVER": {
      const finalTurnRecord: TurnRecord | null = state.currentTurnDice && state.currentTurnMoves.length > 0 ? {
        player: state.currentTurnPlayer ?? state.gameState?.currentPlayer ?? "white",
        dice: state.currentTurnDice,
        moves: state.currentTurnMoves,
        boardBefore: state.turnStartBoard ?? undefined,
      } : null;
      const finalTurnHistory = finalTurnRecord ? [...state.turnHistory, finalTurnRecord] : state.turnHistory;
      return {
        ...state,
        gameState: action.gameState,
        winner: action.winner,
        resultType: action.resultType,
        status: "finished",
        legalMoves: [],
        undoCount: 0,
        turnStartedAt: null,
        doubleOffered: false,
        doubleOfferedBy: null,
        turnHistory: finalTurnHistory,
        currentTurnPlayer: null,
        currentTurnDice: null,
        currentTurnMoves: [],
        turnStartBoard: null,
        matchState: action.matchState ?? state.matchState,
        matchOver: action.matchOver ?? false,
        matchTurnHistory: [...state.matchTurnHistory, finalTurnHistory],
      };
    }
    case "NEXT_GAME": {
      const nextMyColor = action.myAddress
        ? (action.white === action.myAddress ? "white" as const : "black" as const)
        : state.myColor;
      return {
        ...state,
        gameId: action.gameId,
        gameState: action.gameState,
        matchState: action.matchState,
        myColor: nextMyColor,
        status: "playing",
        winner: null,
        resultType: null,
        legalMoves: [],
        undoCount: 0,
        turnStartedAt: null,
        lastOpponentMove: null,
        pendingConfirmation: false,
        doubleOffered: false,
        doubleOfferedBy: null,
        turnHistory: [],
        currentTurnPlayer: null,
        currentTurnDice: null,
        currentTurnMoves: [],
        turnStartBoard: null,
        matchOver: false,
      };
    }
    case "DOUBLE_OFFERED":
      return { ...state, doubleOffered: true, doubleOfferedBy: action.player };
    case "DOUBLE_ACCEPTED":
      return {
        ...state,
        gameState: state.gameState
          ? { ...state.gameState, cubeValue: action.cubeValue, cubeOwner: action.cubeOwner }
          : state.gameState,
        doubleOffered: false,
        doubleOfferedBy: null,
      };
    case "DOUBLE_REJECTED":
      return {
        ...state,
        gameState: state.gameState
          ? { ...state.gameState, gameOver: true, winner: action.winner, resultType: "normal" }
          : state.gameState,
        winner: action.winner,
        resultType: "normal",
        status: "finished",
        legalMoves: [],
        doubleOffered: false,
        doubleOfferedBy: null,
        doubleDepositRequired: false,
      };
    case "DOUBLE_AWAITING_DEPOSITS":
      return {
        ...state,
        doubleOffered: false,
        doubleOfferedBy: null,
        doubleDepositRequired: true,
        doubleDepositAmount: action.additionalDeposit,
        doubleDepositNewCubeValue: action.newCubeValue,
        doubleDepositDoubler: action.doubler,
        doubleDepositResponder: action.responder,
        doubleDepositDoublerDone: false,
        doubleDepositResponderDone: false,
        doubleDepositComplete: false,
      };
    case "DOUBLE_DEPOSIT_RECEIVED":
      return {
        ...state,
        doubleDepositDoublerDone: action.player === state.doubleDepositDoubler ? true : state.doubleDepositDoublerDone,
        doubleDepositResponderDone: action.player === state.doubleDepositResponder ? true : state.doubleDepositResponderDone,
      };
    case "DOUBLE_DEPOSITS_COMPLETE":
      return {
        ...state,
        doubleDepositRequired: false,
        doubleDepositComplete: true,
        doubleDepositDoublerDone: true,
        doubleDepositResponderDone: true,
        gameState: state.gameState
          ? { ...state.gameState, cubeValue: action.newCubeValue, cubeOwner: action.cubeOwner }
          : state.gameState,
      };
    case "DOUBLE_DEPOSIT_TIMEOUT":
      return {
        ...state,
        doubleDepositRequired: false,
        doubleDepositComplete: false,
        doubleDepositDoubler: null,
        doubleDepositResponder: null,
        doubleDepositDoublerDone: false,
        doubleDepositResponderDone: false,
      };
    case "OPPONENT_DISCONNECTED":
      return { ...state, opponentDisconnected: true };
    case "OPPONENT_RECONNECTED":
      return { ...state, opponentDisconnected: false, disconnectCountdown: null };
    case "FORCED_MOVE_NOTICE":
      return { ...state, forcedMoveNotice: action.on };
    case "OPPONENT_DISCONNECTING":
      return { ...state, opponentDisconnected: true, disconnectCountdown: action.countdown };
    case "DISCONNECT_COUNTDOWN":
      return { ...state, disconnectCountdown: action.countdown };
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
    case "REACTION_RECEIVED":
      return { ...state, lastReaction: { emoji: action.emoji, from: action.from } };
    case "CLEAR_REACTION":
      return { ...state, lastReaction: null };
    case "LOCAL_MOVE":
      return {
        ...state,
        bufferedMoves: [...state.bufferedMoves, { from: action.from, to: action.to }],
        localGameState: action.newState,
        localLegalMoves: action.legalMoves,
        currentTurnMoves: [...state.currentTurnMoves, { from: action.from, to: action.to, die: action.die }],
      };
    case "LOCAL_UNDO": {
      if (state.bufferedMoves.length === 0 || !state.gameState) return state;
      const remaining = state.bufferedMoves.slice(0, -1);
      let replayState: GameState = state.gameState;
      for (const m of remaining) {
        const next = coreMakeMove(replayState, m.from, m.to);
        if (next) replayState = next;
      }
      const replayLegal = replayState.movesRemaining.length > 0
        ? getLegalFirstMoves(replayState.board, replayState.currentPlayer, replayState.movesRemaining)
        : [];
      return {
        ...state,
        bufferedMoves: remaining,
        localGameState: remaining.length > 0 ? replayState : null,
        localLegalMoves: remaining.length > 0 ? replayLegal : state.legalMoves,
        currentTurnMoves: state.currentTurnMoves.slice(0, -1),
      };
    }
    case "CLEAR_BUFFER":
      return {
        ...state,
        bufferedMoves: [],
        localGameState: null,
        localLegalMoves: [],
        currentTurnMoves: [],
      };
    default:
      return state;
  }
}
