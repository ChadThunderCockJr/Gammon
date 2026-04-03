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

export interface MatchResult {
  gameId: string;
  opponent: string;
  opponentName: string;
  result: "W" | "L";
  resultType: string;
  timestamp: number;
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

export async function fetchStats(address: string): Promise<PlayerStats> {
  const res = await fetch(`${API_BASE}/api/stats/${address}`);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

export async function fetchMatches(address: string, limit = 20): Promise<MatchResult[]> {
  const res = await fetch(`${API_BASE}/api/matches/${address}`);
  if (!res.ok) throw new Error("Failed to fetch matches");
  const data = await res.json();
  return (data.matches as MatchResult[]).slice(0, limit);
}

export async function fetchProfile(address: string): Promise<PlayerProfile> {
  const res = await fetch(`${API_BASE}/api/profile/${address}`);
  if (!res.ok) throw new Error("Failed to fetch profile");
  return res.json();
}

export async function fetchLeaderboard(limit = 50, offset = 0): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  const res = await fetch(`${API_BASE}/api/leaderboard?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error("Failed to fetch leaderboard");
  return res.json();
}

export async function fetchFriendsLeaderboard(address: string): Promise<{ entries: LeaderboardEntry[] }> {
  const res = await fetch(`${API_BASE}/api/leaderboard/friends/${address}`);
  if (!res.ok) throw new Error("Failed to fetch friends leaderboard");
  return res.json();
}

export async function fetchRank(address: string): Promise<number | null> {
  const res = await fetch(`${API_BASE}/api/rank/${address}`);
  if (!res.ok) throw new Error("Failed to fetch rank");
  const data = await res.json();
  return data.rank;
}

export async function fetchOnlineCount(): Promise<number> {
  const res = await fetch(`${API_BASE}/api/online-count`);
  if (!res.ok) return 0;
  const data = await res.json();
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
