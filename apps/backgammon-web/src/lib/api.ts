import { WS_URL } from "./ws-config";

// Derive HTTP API base from WebSocket URL, trimming /ws path and any whitespace
export const API_BASE = WS_URL.trim().replace(/^ws(s?):/, "http$1:").replace(/\/ws\s*$/, "").replace(/\/+$/, "");

// ── Types ──────────────────────────────────────────────────────

export interface PlayerStats {
  wins: number;
  losses: number;
  totalGames: number;
  currentStreak: number;
  currentStreakType: "W" | "L" | "";
  rating: number;
  ratingChange: number;
}

export interface CashSettlementReceipt {
  cubeValue: number;
  cubeWasTurned: boolean;
  gameId: string;
  quoteId: string;
  resultMultiplier: number;
  settlementId: string;
  winner: string;
  settlement: {
    liabilityMicroUsd: string;
    loserRefundMicroUsd: string;
    rakeMicroUsd: string;
    totalDepositedMicroUsd: string;
    winnerPayoutMicroUsd: string;
  };
}

export interface CashRefundReceipt {
  kind: "refund";
  gameId: string;
  quoteId: string;
  refundId: string;
  reason: string;
  refundedAt: string;
}

export interface CashQuoteHistoryItem {
  id: string;
  gameId: string;
  state: string;
  playerA?: string;
  playerB?: string;
  stakeMicroUsd: string;
  reservePerPlayerMicroUsd: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  cashSessionStartedAt?: string | null;
  realityCheckAcknowledgedAt?: string | null;
  recovery?: {
    fundedStartDeadline?: string | null;
    reviewDeadline?: string | null;
    resolutionState?: string | null;
    resolutionReason?: string | null;
  } | null;
  receipt?: CashSettlementReceipt | CashRefundReceipt | null;
  settlementTxHash?: string | null;
}

export interface MatchResult {
  gameId: string;
  opponent: string;
  opponentName: string;
  result: "W" | "L";
  resultType: string;
  timestamp: number;
  wagerAmount?: number | string | null;
  cashQuoteId?: string | null;
  cashState?: string | null;
  stakeMicroUsd?: string | null;
  reserveMicroUsd?: string | null;
  assetDenom?: string | null;
  settlementTxHash?: string | null;
  terminalId?: string | null;
  terminalReceipt?: CashSettlementReceipt | CashRefundReceipt | Record<string, unknown> | null;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName: string;
  rating: number;
  wins: number;
  losses: number;
  totalGames: number;
  online: boolean;
}

export interface PlayerProfile {
  address: string;
  displayName: string;
  username?: string;
  createdAt: number;
}

// ── Fetch Helpers ──────────────────────────────────────────────
export class ApiResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiResponseError";
  }
}

async function requestJson<T>(url: string, message: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new ApiResponseError(response.status, message);
  return response.json() as Promise<T>;
}


export async function fetchStats(address: string): Promise<PlayerStats> {
  return requestJson<PlayerStats>(`${API_BASE}/api/stats/${address}`, "Failed to fetch stats");
}

export async function fetchMatches(address: string, limit = 20): Promise<MatchResult[]> {
  const data = await requestJson<{ matches: MatchResult[] }>(
    `${API_BASE}/api/matches/${address}`,
    "Failed to fetch matches",
  );
  return data.matches.slice(0, limit);
}

export async function fetchProfile(address: string): Promise<PlayerProfile> {
  return requestJson<PlayerProfile>(`${API_BASE}/api/profile/${address}`, "Failed to fetch profile");
}

export async function fetchLeaderboard(limit = 50, offset = 0): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  return requestJson(
    `${API_BASE}/api/leaderboard?limit=${limit}&offset=${offset}`,
    "Failed to fetch leaderboard",
  );
}

export async function fetchFriendsLeaderboard(address: string): Promise<{ entries: LeaderboardEntry[] }> {
  return requestJson(
    `${API_BASE}/api/leaderboard/friends/${address}`,
    "Failed to fetch friends leaderboard",
  );
}

export async function fetchRank(address: string): Promise<number | null> {
  const data = await requestJson<{ rank: number | null }>(
    `${API_BASE}/api/rank/${address}`,
    "Failed to fetch rank",
  );
  return data.rank;
}

export async function fetchOnlineCount(): Promise<number> {
  const data = await requestJson<{ count: number }>(
    `${API_BASE}/api/online-count`,
    "Failed to fetch online count",
  );
  return data.count;
}

// ── Utilities ──────────────────────────────────────────────────

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
