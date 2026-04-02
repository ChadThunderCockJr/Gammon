import type { GameState, Player, Move, MatchState } from "@xion-beginner/backgammon-core";
import type { TurnRecord } from "./useLocalGame";
import { DEFAULT_TURN_TIME_LIMIT_SEC } from "@/lib/constants";

export interface GameContext {
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
  doubleDepositRequired: boolean;
  doubleDepositAmount: string;
  doubleDepositNewCubeValue: number;
  doubleDepositDoubler: string | null;
  doubleDepositResponder: string | null;
  doubleDepositDoublerDone: boolean;
  doubleDepositResponderDone: boolean;
  doubleDepositComplete: boolean;
  turnHistory: TurnRecord[];
  currentTurnPlayer: Player | null;
  currentTurnDice: [number, number] | null;
  currentTurnMoves: { from: number; to: number; die: number }[];
  turnStartBoard: { points: number[]; whiteOff: number; blackOff: number } | null;
  matchState: MatchState | null;
  matchOver: boolean;
  matchTurnHistory: TurnRecord[][];
  bufferedMoves: { from: number; to: number }[];
  localGameState: GameState | null;
  localLegalMoves: Move[];
}

export type GameAction =
  | { type: "GAME_CREATED"; gameId: string; color: Player }
  | { type: "GAME_JOINED"; gameId: string; color: Player; opponent: string; opponentName?: string }
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
  | { type: "DICE_ROLLED"; gameState: GameState; legalMoves: Move[]; player: Player; needsConfirmation?: boolean }
  | { type: "MOVE_MADE"; gameState: GameState; legalMoves: Move[]; player: Player; move: Move; needsConfirmation?: boolean }
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
  | { type: "NEXT_GAME"; gameId: string; gameState: GameState; matchState: MatchState; myAddress: string; white: string; black: string }
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
  | { type: "DOUBLE_AWAITING_DEPOSITS"; newCubeValue: number; additionalDeposit: string; doubler: string; responder: string }
  | { type: "DOUBLE_DEPOSIT_RECEIVED"; player: string; depositsComplete: boolean }
  | { type: "DOUBLE_DEPOSITS_COMPLETE"; newCubeValue: number; cubeOwner: Player }
  | { type: "DOUBLE_DEPOSIT_TIMEOUT" }
  | { type: "LOCAL_MOVE"; from: number; to: number; die: number; newState: GameState; legalMoves: Move[] }
  | { type: "LOCAL_UNDO" }
  | { type: "CLEAR_BUFFER" };

export const initialGameContext: GameContext = {
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
  doubleDepositRequired: false,
  doubleDepositAmount: "0",
  doubleDepositNewCubeValue: 0,
  doubleDepositDoubler: null,
  doubleDepositResponder: null,
  doubleDepositDoublerDone: false,
  doubleDepositResponderDone: false,
  doubleDepositComplete: false,
  turnHistory: [],
  currentTurnPlayer: null,
  currentTurnDice: null,
  currentTurnMoves: [],
  turnStartBoard: null,
  matchState: null,
  matchOver: false,
  matchTurnHistory: [],
  bufferedMoves: [],
  localGameState: null,
  localLegalMoves: [],
};
