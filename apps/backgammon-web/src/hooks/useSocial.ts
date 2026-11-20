import { useCallback, useEffect, useReducer } from "react";
import { useWebSocket } from "./useWebSocket";
import { useServerSession } from "./useServerSession";

export interface FriendEntry { address: string; displayName: string; online: boolean; }
export interface FriendRequestEntry { address: string; displayName: string; }
export interface ActivityItem { type: "match" | "friend_added" | "friend_online"; text: string; result?: "W" | "L"; timestamp: number; }
export interface SearchResult { address: string; username: string; displayName: string; }
export interface ChallengeConfig {
  version: "free-challenge-v1";
  mode: "free";
  matchLength: 1 | 3 | 5 | 7;
  doublingCube: boolean;
  timeControl: number;
}
export interface PendingChallenge { challengeId: string; fromAddress: string; fromName: string; createdAt: number; expiresAt: number; config: ChallengeConfig; }
export interface OutgoingChallenge { challengeId: string; toAddress: string; toName: string; config: ChallengeConfig; status: "sent" | "declined" | "expired"; createdAt: number; expiresAt: number; }
export interface SocialActionStatus { status: "idle" | "pending" | "success" | "error"; error?: string; receiptId?: string; }

export interface SocialState {
  friends: FriendEntry[];
  incomingRequests: FriendRequestEntry[];
  outgoingRequests: string[];
  activity: ActivityItem[];
  pendingChallenges: PendingChallenge[];
  outgoingChallenges: OutgoingChallenge[];
  searchResults: SearchResult[];
  blockedUsers: string[];
  displayName: string;
  username: string;
  usernameError: string;
  connected: boolean;
  acceptedGameId: string | null;
  error: string | null;
  reportReceipt: { targetAddress: string; reportId: string } | null;
  blockActions: Record<string, SocialActionStatus>;
  reportActions: Record<string, SocialActionStatus>;
}
type SocialAction =
  | { type: "FRIENDS"; friends: FriendEntry[]; incoming: FriendRequestEntry[]; outgoing: string[]; challenges: PendingChallenge[]; blockedUsers: string[] }
  | { type: "ACTIVITY"; activity: ActivityItem[] }
  | { type: "PROFILE"; displayName: string }
  | { type: "PRESENCE"; address: string; online: boolean }
  | { type: "REQUEST"; address: string; name: string }
  | { type: "REQUEST_ACCEPTED"; address: string; name: string }
  | { type: "REMOVED"; address: string }
  | { type: "CHALLENGE"; challenge: PendingChallenge }
  | { type: "CHALLENGE_SENT"; challenge: OutgoingChallenge }
  | { type: "CHALLENGE_ACCEPTED"; challengeId: string; gameId: string }
  | { type: "CHALLENGE_DECLINED"; challengeId: string }
  | { type: "CLEAR_ACCEPTED" }
  | { type: "DISMISS"; challengeId: string }
  | { type: "USERNAME"; username: string }
  | { type: "USERNAME_ERROR"; message: string }
  | { type: "SEARCH"; results: SearchResult[] }
  | { type: "ERROR"; message: string }
  | { type: "BLOCK_REQUEST"; address: string; requestId: string }
  | { type: "REPORT_REQUEST"; address: string; requestId: string }
  | { type: "BLOCKED"; address: string; requestId: string }
  | { type: "UNBLOCKED"; address: string }
  | { type: "REPORTED"; address: string; reportId: string; requestId: string }
  | { type: "SOCIAL_ERROR"; message: string }
  | { type: "EXPIRE_CHALLENGES"; now: number }
  | { type: "CONNECTED"; value: boolean };

const initialState: SocialState = {
  friends: [], incomingRequests: [], outgoingRequests: [], activity: [], pendingChallenges: [], outgoingChallenges: [], searchResults: [], blockedUsers: [],
  displayName: "", username: "", usernameError: "", connected: false, acceptedGameId: null, error: null, reportReceipt: null,
  blockActions: {}, reportActions: {},
};

function reducer(state: SocialState, action: SocialAction): SocialState {
  switch (action.type) {
    case "FRIENDS": return { ...state, friends: action.friends, incomingRequests: action.incoming, outgoingRequests: action.outgoing, pendingChallenges: action.challenges, blockedUsers: action.blockedUsers, error: null };
    case "ACTIVITY": return { ...state, activity: action.activity };
    case "PROFILE": return { ...state, displayName: action.displayName };
    case "PRESENCE": return { ...state, friends: state.friends.map((friend) => friend.address === action.address ? { ...friend, online: action.online } : friend) };
    case "REQUEST": return { ...state, incomingRequests: [...state.incomingRequests.filter((request) => request.address !== action.address), { address: action.address, displayName: action.name }] };
    case "REQUEST_ACCEPTED": return { ...state, friends: [...state.friends.filter((friend) => friend.address !== action.address), { address: action.address, displayName: action.name, online: true }], outgoingRequests: state.outgoingRequests.filter((address) => address !== action.address) };
    case "REMOVED": return { ...state, friends: state.friends.filter((friend) => friend.address !== action.address) };
    case "CHALLENGE": return { ...state, pendingChallenges: [...state.pendingChallenges.filter((challenge) => challenge.challengeId !== action.challenge.challengeId), action.challenge] };
    case "CHALLENGE_SENT": return { ...state, outgoingChallenges: [...state.outgoingChallenges.filter((challenge) => challenge.challengeId !== action.challenge.challengeId), action.challenge], error: null };
    case "CHALLENGE_ACCEPTED": return { ...state, acceptedGameId: action.gameId, pendingChallenges: state.pendingChallenges.filter((challenge) => challenge.challengeId !== action.challengeId), outgoingChallenges: state.outgoingChallenges.filter((challenge) => challenge.challengeId !== action.challengeId) };
    case "CHALLENGE_DECLINED": return {
      ...state,
      pendingChallenges: state.pendingChallenges.filter((challenge) => challenge.challengeId !== action.challengeId),
      outgoingChallenges: state.outgoingChallenges.map((challenge) => challenge.challengeId === action.challengeId ? { ...challenge, status: "declined" } : challenge),
    };
    case "CLEAR_ACCEPTED": return { ...state, acceptedGameId: null };
    case "DISMISS": return { ...state, pendingChallenges: state.pendingChallenges.filter((challenge) => challenge.challengeId !== action.challengeId) };
    case "USERNAME": return { ...state, username: action.username, usernameError: "" };
    case "USERNAME_ERROR": return { ...state, usernameError: action.message };
    case "SEARCH": return { ...state, searchResults: action.results };
    case "ERROR": return { ...state, error: action.message };
    case "BLOCK_REQUEST": return { ...state, error: null, blockActions: { ...state.blockActions, [action.address]: { status: "pending", error: undefined, receiptId: action.requestId } } };
    case "REPORT_REQUEST": return { ...state, error: null, reportActions: { ...state.reportActions, [action.address]: { status: "pending", error: undefined, receiptId: action.requestId } } };
    case "BLOCKED": {
      const pending = state.blockActions[action.address];
      if (pending?.status !== "pending" || pending.receiptId !== action.requestId) return state;
      return {
        ...state,
        blockedUsers: [...new Set([...state.blockedUsers, action.address])],
        friends: state.friends.filter((friend) => friend.address !== action.address),
        blockActions: { ...state.blockActions, [action.address]: { status: "success" } },
      };
    }
    case "UNBLOCKED": return { ...state, blockedUsers: state.blockedUsers.filter((address) => address !== action.address), error: null };
    case "REPORTED": {
      const pending = state.reportActions[action.address];
      if (pending?.status !== "pending" || pending.receiptId !== action.requestId) return state;
      return {
        ...state,
        reportReceipt: { targetAddress: action.address, reportId: action.reportId },
        reportActions: { ...state.reportActions, [action.address]: { status: "success", receiptId: action.reportId } },
      };
    }
    case "SOCIAL_ERROR": {
      const markFailed = (actions: Record<string, SocialActionStatus>) => Object.fromEntries(
        Object.entries(actions).map(([address, actionStatus]) => [
          address,
          actionStatus.status === "pending" ? { status: "error" as const, error: action.message } : actionStatus,
        ]),
      );
      return { ...state, error: action.message, blockActions: markFailed(state.blockActions), reportActions: markFailed(state.reportActions) };
    }
    case "EXPIRE_CHALLENGES": return {
      ...state,
      pendingChallenges: state.pendingChallenges.filter((challenge) => challenge.expiresAt > action.now),
      outgoingChallenges: state.outgoingChallenges.map((challenge) =>
        challenge.status === "sent" && challenge.expiresAt <= action.now
          ? { ...challenge, status: "expired" }
          : challenge
      ),
    };
    case "CONNECTED": return { ...state, connected: action.value };
  }
}

export function useSocial(wsUrl: string, address: string | null) {
  const { connect, disconnect, sendMessage, connected, on } = useWebSocket(wsUrl);
  const secureSession = useServerSession();
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (address && secureSession.status === "ready") connect();
    else disconnect();
  }, [address, connect, disconnect, secureSession.status]);

  useEffect(() => {
    dispatch({ type: "CONNECTED", value: connected && secureSession.status === "ready" });
    if (connected && secureSession.status === "ready") {
      sendMessage({ type: "get_friends" });
      sendMessage({ type: "get_activity" });
    }
  }, [connected, secureSession.status, sendMessage]);

  useEffect(() => {
    const timer = window.setInterval(() => dispatch({ type: "EXPIRE_CHALLENGES", now: Date.now() }), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const unsubs = [
      on("friends_list", (message) => dispatch({
        type: "FRIENDS",
        friends: Array.isArray(message.friends) ? message.friends as FriendEntry[] : [],
        incoming: Array.isArray(message.incoming_requests) ? message.incoming_requests as FriendRequestEntry[] : [],
        outgoing: Array.isArray(message.outgoing_requests) ? message.outgoing_requests as string[] : [],
        blockedUsers: Array.isArray(message.blocked_users) ? message.blocked_users.map(String) : [],
        challenges: Array.isArray(message.pending_challenges) ? (message.pending_challenges as Array<{ challenge_id: string; from_address: string; from_name: string; created_at: number; expires_at: number; config: { version: "free-challenge-v1"; mode: "free"; match_length: 1 | 3 | 5 | 7; doubling_cube: boolean; time_control: number } }>).map((challenge) => ({
          challengeId: challenge.challenge_id,
          fromAddress: challenge.from_address,
          fromName: challenge.from_name,
          createdAt: challenge.created_at,
          expiresAt: challenge.expires_at,
          config: {
            version: challenge.config.version,
            mode: challenge.config.mode,
            matchLength: challenge.config.match_length,
            doublingCube: challenge.config.doubling_cube,
            timeControl: challenge.config.time_control,
          },
        })) : [],
      })),
      on("activity_feed", (message) => dispatch({ type: "ACTIVITY", activity: Array.isArray(message.items) ? message.items as ActivityItem[] : [] })),
      on("profile_updated", (message) => dispatch({ type: "PROFILE", displayName: typeof message.display_name === "string" ? message.display_name : "" })),
      on("friend_online", (message) => dispatch({ type: "PRESENCE", address: String(message.address), online: true })),
      on("friend_offline", (message) => dispatch({ type: "PRESENCE", address: String(message.address), online: false })),
      on("friend_request_received", (message) => dispatch({ type: "REQUEST", address: String(message.from_address), name: String(message.from_name) })),
      on("friend_request_accepted", (message) => dispatch({ type: "REQUEST_ACCEPTED", address: String(message.address), name: String(message.display_name) })),
      on("friend_removed", (message) => dispatch({ type: "REMOVED", address: String(message.address) })),
      on("challenge_received", (message) => {
        const config = message.config as { version: "free-challenge-v1"; mode: "free"; match_length: 1 | 3 | 5 | 7; doubling_cube: boolean; time_control: number };
        dispatch({ type: "CHALLENGE", challenge: {
          challengeId: String(message.challenge_id),
          fromAddress: String(message.from_address),
          fromName: String(message.from_name),
          createdAt: Number(message.created_at),
          expiresAt: Number(message.expires_at),
          config: { version: config.version, mode: config.mode, matchLength: config.match_length, doublingCube: config.doubling_cube, timeControl: config.time_control },
        } });
      }),
      on("challenge_sent", (message) => {
        const config = message.config as { version: "free-challenge-v1"; mode: "free"; match_length: 1 | 3 | 5 | 7; doubling_cube: boolean; time_control: number };
        dispatch({ type: "CHALLENGE_SENT", challenge: {
          challengeId: String(message.challenge_id),
          toAddress: String(message.to_address),
          toName: String(message.to_name),
          status: "sent",
          createdAt: Number(message.created_at),
          expiresAt: Number(message.expires_at),
          config: { version: config.version, mode: config.mode, matchLength: config.match_length, doublingCube: config.doubling_cube, timeControl: config.time_control },
        } });
      }),
      on("challenge_accepted", (message) => dispatch({ type: "CHALLENGE_ACCEPTED", challengeId: String(message.challenge_id), gameId: String(message.game_id) })),
      on("challenge_declined", (message) => dispatch({ type: "CHALLENGE_DECLINED", challengeId: String(message.challenge_id) })),
      on("username_set", (message) => dispatch({ type: "USERNAME", username: String(message.username) })),
      on("username_error", (message) => dispatch({ type: "USERNAME_ERROR", message: String(message.message) })),
      on("search_results", (message) => dispatch({ type: "SEARCH", results: Array.isArray(message.results) ? message.results as SearchResult[] : [] })),
      on("user_blocked", (message) => dispatch({ type: "BLOCKED", address: String(message.target_address), requestId: String(message.request_id) })),
      on("user_unblocked", (message) => dispatch({ type: "UNBLOCKED", address: String(message.target_address) })),
      on("user_reported", (message) => dispatch({ type: "REPORTED", address: String(message.target_address), reportId: String(message.report_id), requestId: String(message.request_id) })),
      on("error", (message) => dispatch({ type: "SOCIAL_ERROR", message: typeof message.message === "string" ? message.message : "Request failed" })),
    ];
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [on]);

  const request = useCallback((message: Record<string, unknown>) => {
    const sent = sendMessage(message);
    if (!sent) dispatch({ type: "SOCIAL_ERROR", message: "Reconnect your wallet session to use social features" });
    return sent;
  }, [sendMessage]);

  return {
    ...state,
    setDisplayName: (displayName: string) => request({ type: "set_profile", display_name: displayName }),
    setUsername: (username: string) => request({ type: "set_username", username }),
    searchPlayers: (query: string) => request({ type: "search_players", query }),
    sendFriendRequest: (toAddress: string) => request({ type: "send_friend_request", to_address: toAddress }),
    acceptFriendRequest: (fromAddress: string) => request({ type: "accept_friend_request", from_address: fromAddress }),
    rejectFriendRequest: (fromAddress: string) => request({ type: "reject_friend_request", from_address: fromAddress }),
    removeFriend: (friendAddress: string) => request({ type: "remove_friend", address: friendAddress }),
    challengeFriend: (toAddress: string, config: ChallengeConfig) => request({
      type: "challenge_friend",
      to_address: toAddress,
      config: {
        version: config.version,
        mode: config.mode,
        match_length: config.matchLength,
        doubling_cube: config.doublingCube,
        time_control: config.timeControl,
      },
    }),
    acceptChallenge: (challengeId: string) => request({ type: "accept_challenge", challenge_id: challengeId }),
    declineChallenge: (challengeId: string) => request({ type: "decline_challenge", challenge_id: challengeId }),
    blockUser: (targetAddress: string) => {
      const requestId = crypto.randomUUID();
      dispatch({ type: "BLOCK_REQUEST", address: targetAddress, requestId });
      if (!request({ type: "block_user", target_address: targetAddress, request_id: requestId })) {
        dispatch({ type: "SOCIAL_ERROR", message: "Reconnect your wallet session to use social features" });
      }
    },
    unblockUser: (targetAddress: string) => request({ type: "unblock_user", target_address: targetAddress }),
    reportUser: (targetAddress: string, reason: string) => {
      const requestId = crypto.randomUUID();
      dispatch({ type: "REPORT_REQUEST", address: targetAddress, requestId });
      if (!request({
        type: "report_user",
        target_address: targetAddress,
        category: ({
          Cheating: "cheating",
          Harassment: "harassment",
          "Inappropriate name": "inappropriate_name",
          Other: "other",
        } as Record<string, string>)[reason] ?? "other",
        request_id: requestId,
      })) {
        dispatch({ type: "SOCIAL_ERROR", message: "Reconnect your wallet session to use social features" });
      }
    },
    refreshFriends: () => request({ type: "get_friends" }),
    refreshActivity: () => request({ type: "get_activity" }),
    clearAcceptedGame: () => dispatch({ type: "CLEAR_ACCEPTED" }),
  };
}
