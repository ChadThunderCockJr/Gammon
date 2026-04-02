import type { GameState, Player, Move, ResultType, MatchState } from "@xion-beginner/backgammon-core";

export interface ServerGame {
  id: string;
  gameState: GameState;
  playerWhite: PlayerConnection | null;
  playerBlack: PlayerConnection | null;
  spectators: PlayerConnection[];
  wagerAmount: number;
  status: "waiting" | "depositing" | "playing" | "finished" | "abandoned";
  createdAt: number;
  turnTimer: ReturnType<typeof setTimeout> | null;
  turnTimeLimit: number; // seconds per turn
  turnMoveStack: GameState[];
  pendingConfirmation: string | null;
  disconnectTimer: ReturnType<typeof setInterval> | null;
  disconnectedPlayer: string | null;
  disconnectedAt: number | null;
  escrowStatus: "none" | "pending_deposits" | "active" | "awaiting_double_deposits" | "settled" | "cancelled" | "forfeited";
  pendingResignation: { player: string; resignType: "normal" | "gammon" | "backgammon" } | null;
  moveTimes: number[];
  stallingWarned: boolean;
  pendingMatchLength?: number;
  /** Pending double deposit info for wagered games */
  pendingDoubleDeposit: {
    doubler: string;
    responder: string;
    newCubeValue: number;
    additionalDeposit: string;
    doublerDeposited: boolean;
    responderDeposited: boolean;
    depositTimer: ReturnType<typeof setTimeout> | null;
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

// Client -> Server messages
export type ClientMessage =
  | { type: "auth"; address: string; signature?: string; pubkey?: string; nonce?: string; signer_address?: string }
  | { type: "create_game"; wager_amount: number; match_length?: number; time_control?: number }
  | { type: "join_game"; game_id: string }
  | { type: "rejoin_game"; game_id: string }
  | { type: "join_queue"; wager_amount: number; match_length?: number }
  | { type: "leave_queue" }
  | { type: "move"; game_id: string; from: number; to: number }
  | { type: "end_turn"; game_id: string }
  | { type: "roll_dice"; game_id: string }
  | { type: "undo_move"; game_id: string }
  | { type: "resign"; game_id: string; resign_type?: "normal" | "gammon" | "backgammon" }
  | { type: "accept_resign"; game_id: string }
  | { type: "reject_resign"; game_id: string }
  | { type: "offer_double"; game_id: string }
  | { type: "accept_double"; game_id: string }
  | { type: "reject_double"; game_id: string }
  | { type: "double_deposit_confirmed"; game_id: string }
  | { type: "spectate"; game_id: string }
  // Social messages
  | { type: "set_profile"; display_name: string }
  | { type: "get_friends" }
  | { type: "send_friend_request"; to_address: string }
  | { type: "accept_friend_request"; from_address: string }
  | { type: "reject_friend_request"; from_address: string }
  | { type: "remove_friend"; address: string }
  | { type: "get_activity" }
  | { type: "challenge_friend"; to_address: string }
  | { type: "accept_challenge"; challenge_id: string }
  | { type: "decline_challenge"; challenge_id: string }
  | { type: "set_username"; username: string }
  | { type: "search_players"; query: string }
  // Reaction
  | { type: "reaction"; game_id: string; emoji: string };

// Server -> Client messages
export type ServerMessage =
  | { type: "auth_ok"; address: string }
  | { type: "auth_challenge"; nonce: string }
  | { type: "error"; message: string; code?: string }
  | { type: "game_created"; game_id: string; color: Player }
  | { type: "game_joined"; game_id: string; color: Player; opponent: string; opponent_name?: string }
  | { type: "game_start"; game_id: string; white: string; black: string; white_name?: string; black_name?: string; game_state: GameState; legal_moves?: Move[]; match_state?: MatchState; turn_time_limit?: number; needs_confirmation?: boolean }
  | { type: "queue_joined"; position: number }
  | { type: "queue_left" }
  | { type: "dice_rolled"; game_id: string; dice: [number, number]; player: Player; game_state: GameState; legal_moves: Move[]; needs_confirmation?: boolean; drand_proof?: { round: number; randomness: string; signature: string }; drand_failed?: boolean }
  | { type: "move_made"; game_id: string; move: Move; player: Player; game_state: GameState; legal_moves: Move[]; needs_confirmation?: boolean }
  | { type: "move_undone"; game_id: string; game_state: GameState; legal_moves: Move[] }
  | { type: "turn_ended"; game_id: string; next_player: Player; game_state: GameState }
  | { type: "game_over"; game_id: string; winner: Player; result_type: ResultType; game_state: GameState; match_state?: MatchState; match_over?: boolean }
  | { type: "match_score"; game_id: string; match_state: MatchState }
  | { type: "next_game"; game_id: string; match_state: MatchState; game_state: GameState; white: string; black: string }
  | { type: "opponent_disconnected"; game_id: string }
  | { type: "opponent_reconnected"; game_id: string }
  | { type: "opponent_disconnecting"; game_id: string; grace_seconds: number }
  | { type: "disconnect_countdown"; game_id: string; seconds_remaining: number }
  | { type: "game_abandoned"; game_id: string; winner: string }
  | { type: "spectate_joined"; game_id: string; game_state: GameState }
  | { type: "dice_commit"; game_id: string; commit_hash: string; turn_number: number }  // deprecated (kept for backward compat)
  | { type: "dice_revealed"; game_id: string; dice: [number, number]; server_seed: string; commit_hash: string; turn_number: number }  // deprecated (kept for backward compat)
  // Cube messages
  | { type: "double_offered"; game_id: string; player: Player; cube_value: number }
  | { type: "double_accepted"; game_id: string; cube_value: number; cube_owner: Player }
  | { type: "double_rejected"; game_id: string; winner: Player }
  // Cube deposit messages (wagered games)
  | { type: "double_awaiting_deposits"; game_id: string; new_cube_value: number; additional_deposit: string; doubler: string; responder: string }
  | { type: "double_deposit_received"; game_id: string; player: string; deposits_complete: boolean }
  | { type: "double_deposits_complete"; game_id: string; new_cube_value: number; cube_owner: Player }
  | { type: "double_deposit_timeout"; game_id: string; message: string }
  // Resignation messages
  | { type: "resign_offered"; game_id: string; player: Player; resign_type: "normal" | "gammon" | "backgammon" }
  | { type: "resign_accepted"; game_id: string; winner: Player; result_type: ResultType }
  | { type: "resign_rejected"; game_id: string }
  // Escrow messages
  | { type: "escrow_created"; game_id: string; wager_amount: number }
  | { type: "deposit_status"; game_id: string; player_a_deposited: boolean; player_b_deposited: boolean }
  | { type: "escrow_active"; game_id: string }
  // Stalling
  | { type: "stalling_warning"; game_id: string; message: string }
  // Social messages
  | { type: "profile_updated"; address: string; display_name: string }
  | { type: "friends_list"; friends: FriendEntry[]; incoming_requests: FriendRequestEntry[]; outgoing_requests: string[]; pending_challenges?: { challenge_id: string; from_address: string; from_name: string }[] }
  | { type: "friend_request_received"; from_address: string; from_name: string }
  | { type: "friend_request_accepted"; address: string; display_name: string }
  | { type: "friend_removed"; address: string }
  | { type: "friend_online"; address: string }
  | { type: "friend_offline"; address: string }
  | { type: "activity_feed"; items: ActivityFeedItem[] }
  | { type: "challenge_received"; challenge_id: string; from_address: string; from_name: string }
  | { type: "challenge_accepted"; challenge_id: string; game_id: string }
  | { type: "challenge_declined"; challenge_id: string }
  | { type: "username_set"; username: string }
  | { type: "username_error"; message: string }
  | { type: "search_results"; results: SearchResultEntry[] }
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
