import { getRedis } from "./redis.js";
import type { MoveRecord } from "@xion-beginner/backgammon-core";
import type { ChallengeTerms } from "./types.js";
import { ONLINE_HEARTBEAT_TTL_SEC, MAX_ACTIVITY_ITEMS, GAME_HISTORY_TTL_SEC } from "./config.js";
import * as durableStore from "./social-store-pg.js";
import type { EncryptedPayload } from "./finance-crypto.js";

// ── Profile ────────────────────────────────────────────────────

export interface Profile {
  displayName: string;
  username: string;
  createdAt: number;
}

export async function getProfile(address: string): Promise<Profile | null> {
  const profile = await durableStore.getProfile(address);
  if (!profile) return null;
  return {
    displayName: profile.displayName,
    username: profile.username ?? "",
    createdAt: profile.createdAt,
  };
}

export async function setProfile(address: string, displayName: string): Promise<boolean> {
  return durableStore.setProfile(address, displayName);
}

export async function setUsername(address: string, username: string): Promise<{ ok: boolean; error?: string }> {
  return durableStore.setUsername(address, username);
}

export async function lookupByUsername(username: string): Promise<string | null> {
  return durableStore.lookupByUsername(username);
}

export async function searchPlayers(query: string, viewer?: string): Promise<Array<{ address: string; username: string; displayName: string }>> {
  return durableStore.searchPlayers(query, viewer);
}

export async function ensureProfile(address: string): Promise<void> {
  await durableStore.ensureProfile(address);
}

// ── Friends ────────────────────────────────────────────────────

export async function getFriends(address: string): Promise<string[]> {
  return durableStore.getFriends(address);
}

export async function addFriend(a: string, b: string): Promise<boolean> {
  return durableStore.addFriend(a, b);
}

export async function removeFriend(a: string, b: string): Promise<boolean> {
  return durableStore.removeFriend(a, b);
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  return durableStore.areFriends(a, b);
}

// ── Friend Requests ────────────────────────────────────────────

export async function sendFriendRequest(from: string, to: string): Promise<boolean> {
  return durableStore.sendFriendRequest(from, to);
}

export async function getIncomingRequests(address: string): Promise<string[]> {
  return durableStore.getIncomingRequests(address);
}

export async function getOutgoingRequests(address: string): Promise<string[]> {
  return durableStore.getOutgoingRequests(address);
}

export async function removeFriendRequest(from: string, to: string): Promise<boolean> {
  return durableStore.removeFriendRequest(from, to);
}

export async function hasPendingRequest(from: string, to: string): Promise<boolean> {
  return durableStore.hasPendingRequest(from, to);
}
export async function acceptFriendRequest(from: string, to: string): Promise<boolean> {
  return durableStore.acceptFriendRequest(from, to);
}
export async function isBlockedEitherDirection(a: string, b: string): Promise<boolean> {
  return durableStore.isBlockedEitherDirection(a, b);
}

export async function getBlockedUsers(blocker: string): Promise<string[]> {
  return durableStore.getBlockedUsers(blocker);
}

export async function blockUser(blocker: string, blocked: string): Promise<boolean> {
  return durableStore.blockUser(blocker, blocked);
}

export async function unblockUser(blocker: string, blocked: string): Promise<boolean> {
  return durableStore.unblockUser(blocker, blocked);
}

export async function createUserReport(input: {
  id: string;
  reporter: string;
  requestId: string;
  target: string;
  category: "cheating" | "harassment" | "inappropriate_name" | "other";
  payloadHash: string;
  descriptionEncrypted: EncryptedPayload;
}): Promise<{ id: string } | null> {
  return durableStore.createUserReport(input);
}

// ── Presence ───────────────────────────────────────────────────

/**
 * Presence is represented by one durable lease per WebSocket.  `connectionId`
 * is generated for the upgraded socket, so closing or renewing one tab cannot
 * change another tab's lease for the same principal.
 */
export async function markOnline(
  address: string,
  connectionId: string,
  instanceId: string,
): Promise<boolean> {
  return durableStore.claimPresenceLease({
    principal: address,
    connectionId,
    instanceId,
    ttlSeconds: ONLINE_HEARTBEAT_TTL_SEC,
  });
}

export async function refreshOnlineHeartbeat(
  address: string,
  connectionId: string,
  instanceId: string,
): Promise<boolean> {
  return durableStore.renewPresenceLease({
    principal: address,
    connectionId,
    instanceId,
    ttlSeconds: ONLINE_HEARTBEAT_TTL_SEC,
  });
}

export async function cleanupStaleOnlinePlayers(): Promise<void> {
  await durableStore.cleanupExpiredPresenceLeases();
}

/** Returns whether this close made the principal offline everywhere. */
export async function markOffline(
  address: string,
  connectionId: string,
  instanceId: string,
): Promise<boolean> {
  return durableStore.releasePresenceLease({
    principal: address,
    connectionId,
    instanceId,
  });
}

export async function isOnline(address: string): Promise<boolean> {
  return durableStore.isPresenceOnline(address);
}

export async function getOnlinePlayers(): Promise<string[]> {
  return durableStore.getOnlinePresencePrincipals();
}

// ── Activity Feed ──────────────────────────────────────────────

export interface ActivityItem {
  type: "match" | "friend_added" | "friend_online";
  text: string;
  result?: "W" | "L";
  timestamp: number;
}

export async function addActivity(address: string, item: ActivityItem): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const key = `activity:${address}`;
    await r.zadd(key, item.timestamp, JSON.stringify(item));
    // Cap at most recent
    const count = await r.zcard(key);
    if (count > MAX_ACTIVITY_ITEMS) {
      await r.zremrangebyrank(key, 0, count - MAX_ACTIVITY_ITEMS - 1);
    }
  } catch { /* ignore */ }
}

export async function getActivity(address: string, limit = 20): Promise<ActivityItem[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    const items = await r.zrevrange(`activity:${address}`, 0, limit - 1);
    return items.map((s) => JSON.parse(s) as ActivityItem);
  } catch { return []; }
}

// ── Match Results ──────────────────────────────────────────────

export interface MatchResult {
  gameId: string;
  opponent: string;
  opponentName: string;
  result: "W" | "L";
  resultType: string;
  wagerAmount: string;
  timestamp: number;
  cashQuoteId: string | null;
  cashState: string | null;
  stakeMicroUsd: string | null;
  reserveMicroUsd: string | null;
  assetDenom: string | null;
  settlementTxHash: string | null;
  terminalId: string | null;
  terminalReceipt: Record<string, unknown> | null;
}


export async function getMatchResults(address: string, limit = 20): Promise<MatchResult[]> {
  const results = await durableStore.getMatchResults(address, limit);
  return results.map((result) => ({
    gameId: result.gameId,
    opponent: result.opponent,
    opponentName: result.opponentName,
    result: result.result === "W" ? "W" : "L",
    resultType: result.resultType,
    wagerAmount: result.wagerAmount,
    timestamp: result.timestamp,
    cashQuoteId: result.cashQuoteId,
    cashState: result.cashState,
    stakeMicroUsd: result.stakeMicroUsd,
    reserveMicroUsd: result.reserveMicroUsd,
    assetDenom: result.assetDenom,
    settlementTxHash: result.settlementTxHash,
    terminalId: result.terminalId,
    terminalReceipt: result.terminalReceipt,
  }));
}

// ── Challenges ─────────────────────────────────────────────────

export interface Challenge {
  id: string;
  from: string;
  fromName: string;
  to: string;
  createdAt: number;
  expiresAt: number;
  config: ChallengeTerms;
  gameId?: string | null;
}

export async function createChallenge(challenge: Challenge): Promise<boolean> {
  return durableStore.createFriendChallenge({
    id: challenge.id,
    from: challenge.from,
    to: challenge.to,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    config: challenge.config,
    gameId: null,
  });
}

export async function getChallenge(id: string): Promise<Challenge | null> {
  const challenge = await durableStore.getFriendChallenge(id);
  if (!challenge) return null;
  const profile = await getProfile(challenge.from);
  return { ...challenge, fromName: profile?.displayName || "" };
}

export async function deleteChallenge(id: string, recipient?: string): Promise<void> {
  if (!recipient) return;
  await durableStore.declineFriendChallenge(id, recipient);
}

export async function getPendingChallengesFor(address: string): Promise<Challenge[]> {
  const challenges = await durableStore.getPendingFriendChallenges(address);
  return Promise.all(challenges.map(async (challenge) => {
    const profile = await getProfile(challenge.from);
    return { ...challenge, fromName: profile?.displayName || "" };
  }));
}

export async function getAcceptedChallengesFor(address: string): Promise<Challenge[]> {
  const challenges = await durableStore.getAcceptedFriendChallenges(address);
  return Promise.all(challenges.map(async (challenge) => {
    const profile = await getProfile(challenge.from);
    return { ...challenge, fromName: profile?.displayName || "" };
  }));
}

export async function acceptChallenge(id: string, recipient: string, ownerInstanceId: string): Promise<Challenge | null> {
  const challenge = await durableStore.acceptFriendChallenge({ id, recipient, ownerInstanceId });
  if (!challenge) return null;
  const profile = await getProfile(challenge.from);
  return { ...challenge, fromName: profile?.displayName || "" };
}

// ── Ratings ───────────────────────────────────────────────────

export interface RatingInfo {
  rating: number;
  ratingChange: number;
}

export async function getRating(address: string): Promise<RatingInfo> {
  return durableStore.getRating(address);
}


// ── Stats ─────────────────────────────────────────────────────

export interface PlayerStats {
  wins: number;
  losses: number;
  totalGames: number;
  currentStreak: number;
  currentStreakType: "W" | "L" | "";
}

export async function getStats(address: string): Promise<PlayerStats> {
  const stats = await durableStore.getStats(address);
  return {
    wins: stats.wins,
    losses: stats.losses,
    totalGames: stats.totalGames,
    currentStreak: stats.currentStreak,
    currentStreakType: stats.currentStreakType === "W" || stats.currentStreakType === "L"
      ? stats.currentStreakType
      : "",
  };
}


// ── Leaderboard ───────────────────────────────────────────────

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

export async function getLeaderboard(limit = 50, offset = 0): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  const [durableEntries, total] = await Promise.all([
    durableStore.getLeaderboard(limit, offset),
    durableStore.getLeaderboardSize(),
  ]);
  const entries = await Promise.all(durableEntries.map(async (entry) => ({
    ...entry,
    online: await isOnline(entry.address),
  })));
  return { entries, total };
}

export async function getPlayerRank(address: string): Promise<number | null> {
  return durableStore.getPlayerRank(address);
}

export async function getLeaderboardSize(): Promise<number> {
  return durableStore.getLeaderboardSize();
}

export async function getFriendsLeaderboard(address: string): Promise<LeaderboardEntry[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    const friendAddrs = await getFriends(address);
    const allAddrs = [...friendAddrs, address]; // include self
    const entries: LeaderboardEntry[] = [];
    for (const addr of allAddrs) {
      const [ratingInfo, profile, stats, online] = await Promise.all([
        getRating(addr),
        getProfile(addr),
        getStats(addr),
        isOnline(addr),
      ]);
      entries.push({
        rank: 0, // will be assigned after sort
        address: addr,
        displayName: profile?.displayName || profile?.username || addr.slice(0, 12),
        rating: ratingInfo.rating,
        wins: stats.wins,
        losses: stats.losses,
        totalGames: stats.totalGames,
        online,
      });
    }
    entries.sort((a, b) => b.rating - a.rating);
    entries.forEach((e, i) => { e.rank = i + 1; });
    return entries;
  } catch { return []; }
}

// ── Online Count ──────────────────────────────────────────────

export async function getOnlineCount(): Promise<number> {
  return durableStore.getOnlinePresenceCount();
}

// ── Game History ───────────────────────────────────────────────

const GAME_HISTORY_TTL = GAME_HISTORY_TTL_SEC;

export async function saveGameHistory(gameId: string, moveHistory: MoveRecord[]): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(`game_history:${gameId}`, GAME_HISTORY_TTL, JSON.stringify(moveHistory));
  } catch { /* ignore */ }
}

export async function getGameHistory(gameId: string): Promise<MoveRecord[] | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.get(`game_history:${gameId}`);
    if (!data) return null;
    return JSON.parse(data) as MoveRecord[];
  } catch { return null; }
}

// ── Dice Proofs (drand) ────────────────────────────────────────────

export interface StoredDiceProofs {
  gameId: string;
  drandChain: string;
  playerWhite: string;
  playerBlack: string;
  rolls: Array<{
    drandRound: number;
    drandRandomness: string;
    drandSignature: string;
    playerWhite: string;
    playerBlack: string;
    turnNumber: number;
    dice: [number, number];
  }>;
}

export async function saveDiceProofs(gameId: string, proofs: StoredDiceProofs): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(`dice_proofs:${gameId}`, GAME_HISTORY_TTL, JSON.stringify(proofs));
  } catch { /* ignore */ }
}

export async function getDiceProofs(gameId: string): Promise<StoredDiceProofs | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.get(`dice_proofs:${gameId}`);
    if (!data) return null;
    return JSON.parse(data) as StoredDiceProofs;
  } catch { return null; }
}
