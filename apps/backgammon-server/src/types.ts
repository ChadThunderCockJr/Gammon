import type { CashGameRules, GameState, Player, Move, ResultType, MatchState } from "@xion-beginner/backgammon-core";

export type GameReviewReason =
  | "turn_timeout"
  | "resignation_response_timeout"
  | "double_response_timeout"
  | "player_disconnect"
  | "proof_unavailable"
  | "platform_recovery"
  | "funding_timeout"
  | "escrow_reconciliation"
  | "terms_unavailable";

export type GamePhase =
  | "waiting"
  | "await_roll"
  | "playing_moves"
  | "await_confirmation"
  | "double_offer"
  | "resignation_offer"
  | "terminal"
  | "review";

export interface ServerGame {
  id: string;
  revision: number;
  phase: GamePhase;
  deadlineAt: number | null;
  reviewReason?: GameReviewReason;
  gameState: GameState;
  playerWhite: PlayerConnection | null;
  playerBlack: PlayerConnection | null;
  wagerAmount: number;
  status: "waiting" | "depositing" | "playing" | "finished" | "abandoned";
  createdAt: number;
  turnTimer: ReturnType<typeof setTimeout> | null;
  ownershipTimer: NodeJS.Timeout | null;
  turnTimeLimit: number; // seconds per turn
  cashRules?: CashGameRules;
  doublingAllowed: boolean;
  turnMoveStack: GameState[];
  pendingConfirmation: string | null;
  disconnectTimer: ReturnType<typeof setInterval> | null;
  disconnectedPlayer: string | null;
  disconnectedAt: number | null;
  escrowStatus: "none" | "active" | "settled" | "cancelled";
  pendingResignation: {
    player: string;
    resignType: "normal" | "gammon" | "backgammon";
    previousPhase: "await_roll" | "playing_moves" | "await_confirmation";
    previousDeadlineAt: number;
    offeredAt: number;
    deadlineAt: number;
    offerRevision: number;
  } | null;
  moveTimes: number[];
  stallingWarned: boolean;
  pendingMatchLength?: number;
  cashQuoteId?: string;
  pendingDoubleOffer: {
    doubler: string;
    offeredCube: 2 | 4 | 8;
    offeredAt: number;
    deadlineAt: number;
    offerRevision: number;
  } | null;
}

export interface PlayerConnection {
  ws: import("ws").WebSocket;
  address: string; // player identifier
  rating: number;
  connectedAt: number;
}

export interface MatchmakingEntry {
  address: string;
  ws: import("ws").WebSocket;
  rating: number;
  wagerAmount: number;
  matchLength: number;
  joinedAt: number;
}

export interface ChallengeTerms {
  version: "free-challenge-v1";
  mode: "free";
  match_length: 1 | 3 | 5 | 7;
  doubling_cube: boolean;
  time_control: number;
}

// Client -> Server messages
export type ClientMessage =
  | { type: "create_game"; wager_amount: number; match_length?: number; time_control?: number }
  | { type: "join_cash_game"; quote_id: string }
  | { type: "join_game"; game_id: string }
  | { type: "rejoin_game"; game_id: string }
  | { type: "join_queue"; wager_amount: number; match_length?: number }
  | { type: "leave_queue" }
  | { type: "move"; game_id: string; from: number; to: number; command_id?: string; expected_revision?: number }
  | { type: "end_turn"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "roll_dice"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "undo_move"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "resign"; game_id: string; resign_type?: "normal" | "gammon" | "backgammon"; command_id?: string; expected_revision?: number }
  | { type: "accept_resign"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "reject_resign"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "offer_double"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "accept_double"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "reject_double"; game_id: string; command_id?: string; expected_revision?: number }
  | { type: "request_cash_review"; game_id: string; command_id: string; expected_revision: number }
  // Social messages
  | { type: "set_profile"; display_name: string }
  | { type: "get_friends" }
  | { type: "send_friend_request"; to_address: string }
  | { type: "accept_friend_request"; from_address: string }
  | { type: "reject_friend_request"; from_address: string }
  | { type: "remove_friend"; address: string }
  | { type: "get_activity" }
  | { type: "challenge_friend"; to_address: string; config: ChallengeTerms }
  | { type: "accept_challenge"; challenge_id: string }
  | { type: "decline_challenge"; challenge_id: string }
  | { type: "set_username"; username: string }
  | { type: "search_players"; query: string }
  | { type: "block_user"; target_address: string; request_id: string }
  | { type: "unblock_user"; target_address: string }
  | { type: "report_user"; target_address: string; category: "cheating" | "harassment" | "inappropriate_name" | "other"; description?: string; request_id: string }
  // Reaction
  | { type: "reaction"; game_id: string; emoji: string };

// Server -> Client messages
export type ServerMessage =
  | { type: "error"; message: string; code?: string }
  | { type: "game_created"; game_id: string; color: Player; revision?: number }
  | { type: "game_joined"; game_id: string; color: Player; opponent: string; opponent_name?: string; revision?: number }
  | { type: "queue_joined"; position: number }
  | { type: "queue_left" }
  | {
      type: "game_start";
      game_id: string;
      white: string;
      black: string;
      white_name?: string;
      black_name?: string;
      game_state: GameState;
      legal_moves?: Move[];
      match_state?: MatchState;
      turn_time_limit?: number;
      needs_confirmation?: boolean;
      revision?: number;
      phase?: GamePhase;
      deadline_at?: string | null;
      pending_double?: { player: Player; cube_value: number; deadline_at: string; offer_revision: number } | null;
      pending_resignation?: { player: Player; resign_type: "normal" | "gammon" | "backgammon"; deadline_at: string; offer_revision: number } | null;
    }
  | { type: "dice_rolled"; game_id: string; dice: [number, number]; player: Player; game_state: GameState; legal_moves: Move[]; needs_confirmation?: boolean; drand_proof?: { round: number; randomness: string; signature: string }; drand_failed?: boolean; revision?: number }
  | { type: "move_made"; game_id: string; move: Move; player: Player; game_state: GameState; legal_moves: Move[]; needs_confirmation?: boolean; revision?: number }
  | { type: "move_undone"; game_id: string; game_state: GameState; legal_moves: Move[]; revision?: number }
  | { type: "turn_ended"; game_id: string; next_player: Player; game_state: GameState; revision?: number }
  | { type: "game_over"; game_id: string; winner: Player; result_type: ResultType; game_state: GameState; match_state?: MatchState; match_over?: boolean; settlement_pending?: boolean; revision?: number }
  | { type: "match_score"; game_id: string; match_state: MatchState }
  | { type: "next_game"; game_id: string; match_state: MatchState; game_state: GameState; white: string; black: string }
  | { type: "opponent_disconnected"; game_id: string }
  | { type: "opponent_reconnected"; game_id: string }
  | { type: "opponent_disconnecting"; game_id: string; grace_seconds: number }
  | { type: "disconnect_countdown"; game_id: string; seconds_remaining: number }
  | { type: "game_abandoned"; game_id: string; winner: string }
  | { type: "dice_commit"; game_id: string; commit_hash: string; turn_number: number }  // deprecated (kept for backward compat)
  | { type: "dice_revealed"; game_id: string; dice: [number, number]; server_seed: string; commit_hash: string; turn_number: number }  // deprecated (kept for backward compat)
  // Cube messages
  | { type: "double_offered"; game_id: string; player: Player; cube_value: number; deadline_at: string; offer_revision: number; revision?: number }
  | { type: "double_accepted"; game_id: string; cube_value: number; cube_owner: Player; revision?: number }
  | { type: "double_rejected"; game_id: string; winner: Player; revision?: number }
  | { type: "resign_offered"; game_id: string; player: Player; resign_type: "normal" | "gammon" | "backgammon"; deadline_at: string; offer_revision: number; revision?: number }
  | { type: "resign_accepted"; game_id: string; winner: Player; result_type: ResultType; revision?: number }
  | { type: "resign_rejected"; game_id: string; revision?: number }
  | { type: "game_review"; game_id: string; reason: GameReviewReason; funds_status: "held_for_review"; revision?: number }
  // Stalling
  | { type: "stalling_warning"; game_id: string; message: string }
  // Social messages
  | { type: "profile_updated"; address: string; display_name: string }
  | { type: "friends_list"; friends: FriendEntry[]; incoming_requests: FriendRequestEntry[]; outgoing_requests: string[]; blocked_users: string[]; pending_challenges?: { challenge_id: string; from_address: string; from_name: string; created_at: number; expires_at: number; config: ChallengeTerms }[] }
  | { type: "friend_request_received"; from_address: string; from_name: string }
  | { type: "friend_request_accepted"; address: string; display_name: string }
  | { type: "friend_removed"; address: string }
  | { type: "friend_online"; address: string }
  | { type: "friend_offline"; address: string }
  | { type: "activity_feed"; items: ActivityFeedItem[] }
  | { type: "challenge_received"; challenge_id: string; from_address: string; from_name: string; created_at: number; expires_at: number; config: ChallengeTerms }
  | { type: "challenge_sent"; challenge_id: string; to_address: string; to_name: string; created_at: number; expires_at: number; config: ChallengeTerms }
  | { type: "challenge_accepted"; challenge_id: string; game_id: string }
  | { type: "challenge_declined"; challenge_id: string }
  | { type: "username_set"; username: string }
  | { type: "username_error"; message: string }
  | { type: "search_results"; results: SearchResultEntry[] }
  | { type: "user_blocked"; target_address: string; request_id: string }
  | { type: "user_unblocked"; target_address: string }
  | { type: "user_reported"; target_address: string; report_id: string; request_id: string }
  // Reaction
  | { type: "reaction"; game_id: string; emoji: string; from: string };

export interface FriendEntry {
  address: string;
  displayName: string;
  online: boolean;
}

export interface FriendRequestEntry {
  address: string;
  displayName: string;
}

export interface SearchResultEntry {
  address: string;
  username: string;
  displayName: string;
}

export interface ActivityFeedItem {
  type: "match" | "friend_added" | "friend_online";
  text: string;
  result?: "W" | "L";
  timestamp: number;
}
