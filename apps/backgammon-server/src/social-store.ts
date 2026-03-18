import { getRedis } from "./redis.js";
import type { MoveRecord } from "@xion-beginner/backgammon-core";
import { MAX_SEARCH_RESULTS, REDIS_SCAN_BATCH_SIZE, CHAIN_ADDRESS_PREFIX, ONLINE_HEARTBEAT_TTL_SEC, MAX_ACTIVITY_ITEMS, MAX_MATCH_HISTORY, CHALLENGE_EXPIRY_SEC, RATING_K_PROVISIONAL, RATING_K_INTERMEDIATE, RATING_K_ESTABLISHED, RATING_PROVISIONAL_THRESHOLD, RATING_ESTABLISHED_THRESHOLD, RATING_MIN, RATING_DEFAULT, GAME_HISTORY_TTL_SEC } from "./config.js";

// ── Profile ────────────────────────────────────────────────────

export interface Profile {
  displayName: string;
  username: string;
  createdAt: number;
}

export async function getProfile(address: string): Promise<Profile | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.hgetall(`profile:${address}`);
    if (!data.createdAt) return null;
    return {
      displayName: data.displayName || "",
      username: data.username || "",
      createdAt: parseInt(data.createdAt),
    };
  } catch { return null; }
}

export async function setProfile(address: string, displayName: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    const exists = await r.exists(`profile:${address}`);
    if (exists) {
      await r.hset(`profile:${address}`, "displayName", displayName);
    } else {
      await r.hset(`profile:${address}`, "displayName", displayName, "username", "", "createdAt", String(Date.now()));
    }
    return true;
  } catch { return false; }
}

export async function setUsername(address: string, username: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = getRedis();
    if (!r) return { ok: false, error: "Redis unavailable" };

    // Validate format: 3-20 chars, alphanumeric + underscores
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return { ok: false, error: "Username must be 3-20 characters (letters, numbers, underscores)" };
    }

    const lowerUsername = username.toLowerCase();

    // Check uniqueness via the username->address mapping
    const existing = await r.get(`username:${lowerUsername}`);
    if (existing && existing !== address) {
      return { ok: false, error: "Username already taken" };
    }

    // Remove old username mapping if changing
    const profile = await r.hgetall(`profile:${address}`);
    if (profile.username) {
      await r.del(`username:${profile.username.toLowerCase()}`);
    }

    // Set new username
    await r.hset(`profile:${address}`, "username", username);
    await r.set(`username:${lowerUsername}`, address);

    // If no display name set yet, use username as display name
    if (!profile.displayName) {
      await r.hset(`profile:${address}`, "displayName", username);
    }

    return { ok: true };
  } catch { return { ok: false, error: "Failed to set username" }; }
}

export async function lookupByUsername(username: string): Promise<string | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    return await r.get(`username:${username.toLowerCase()}`);
  } catch { return null; }
}

export async function searchPlayers(query: string): Promise<Array<{ address: string; username: string; displayName: string }>> {
  try {
    const r = getRedis();
    if (!r) return [];

    const lowerQuery = query.toLowerCase();
    const results: Array<{ address: string; username: string; displayName: string }> = [];
    const seen = new Set<string>();

    // Exact username match first
    const exactAddr = await r.get(`username:${lowerQuery}`);
    if (exactAddr) {
      const profile = await getProfile(exactAddr);
      if (profile) {
        results.push({ address: exactAddr, username: profile.username, displayName: profile.displayName });
        seen.add(exactAddr);
      }
    }

    // Prefix search via SCAN on username:* keys — run full scan to avoid SCAN misses
    if (results.length < MAX_SEARCH_RESULTS) {
      let cursor = "0";
      const pattern = `username:${lowerQuery}*`;
      do {
        const [nextCursor, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", REDIS_SCAN_BATCH_SIZE);
        cursor = nextCursor;
        for (const key of keys) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          const addr = await r.get(key);
          if (addr && !seen.has(addr)) {
            seen.add(addr);
            const profile = await getProfile(addr);
            if (profile) {
              results.push({ address: addr, username: profile.username, displayName: profile.displayName });
            }
          }
        }
      } while (cursor !== "0" && results.length < MAX_SEARCH_RESULTS);
    }

    // Also scan profile:* keys to match by display name
    if (results.length < MAX_SEARCH_RESULTS) {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await r.scan(cursor, "MATCH", "profile:*", "COUNT", REDIS_SCAN_BATCH_SIZE);
        cursor = nextCursor;
        for (const key of keys) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          const addr = key.replace("profile:", "");
          if (seen.has(addr)) continue;
          const profile = await getProfile(addr);
          if (profile) {
            const nameMatch = profile.displayName.toLowerCase().includes(lowerQuery);
            const userMatch = profile.username.toLowerCase().includes(lowerQuery);
            if (nameMatch || userMatch) {
              results.push({ address: addr, username: profile.username, displayName: profile.displayName });
              seen.add(addr);
            }
          }
        }
      } while (cursor !== "0" && results.length < MAX_SEARCH_RESULTS);
    }

    // If query looks like an address, try direct lookup
    if (query.startsWith(CHAIN_ADDRESS_PREFIX + "1") && !seen.has(query)) {
      const profile = await getProfile(query);
      if (profile) {
        results.push({ address: query, username: profile.username, displayName: profile.displayName });
      }
    }

    return results;
  } catch { return []; }
}

export async function ensureProfile(address: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const exists = await r.exists(`profile:${address}`);
    if (!exists) {
      await r.hset(`profile:${address}`, "displayName", "", "username", "", "createdAt", String(Date.now()));
    }
  } catch { /* ignore */ }
}

// ── Friends ────────────────────────────────────────────────────

export async function getFriends(address: string): Promise<string[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    return await r.smembers(`friends:${address}`);
  } catch { return []; }
}

export async function addFriend(a: string, b: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    await r.sadd(`friends:${a}`, b);
    await r.sadd(`friends:${b}`, a);
    return true;
  } catch { return false; }
}

export async function removeFriend(a: string, b: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    await r.srem(`friends:${a}`, b);
    await r.srem(`friends:${b}`, a);
    return true;
  } catch { return false; }
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    return (await r.sismember(`friends:${a}`, b)) === 1;
  } catch { return false; }
}

// ── Friend Requests ────────────────────────────────────────────

export async function sendFriendRequest(from: string, to: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    await r.sadd(`friend_requests_in:${to}`, from);
    await r.sadd(`friend_requests_out:${from}`, to);
    return true;
  } catch { return false; }
}

export async function getIncomingRequests(address: string): Promise<string[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    return await r.smembers(`friend_requests_in:${address}`);
  } catch { return []; }
}

export async function getOutgoingRequests(address: string): Promise<string[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    return await r.smembers(`friend_requests_out:${address}`);
  } catch { return []; }
}

export async function removeFriendRequest(from: string, to: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    await r.srem(`friend_requests_in:${to}`, from);
    await r.srem(`friend_requests_out:${from}`, to);
    return true;
  } catch { return false; }
}

export async function hasPendingRequest(from: string, to: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    return (await r.sismember(`friend_requests_out:${from}`, to)) === 1;
  } catch { return false; }
}

// ── Presence ───────────────────────────────────────────────────

export async function markOnline(address: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.sadd("online_players", address);
    await r.set(`online_heartbeat:${address}`, "1", "EX", ONLINE_HEARTBEAT_TTL_SEC); // 5 min TTL
  } catch { /* ignore */ }
}

export async function refreshOnlineHeartbeat(address: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.set(`online_heartbeat:${address}`, "1", "EX", ONLINE_HEARTBEAT_TTL_SEC);
  } catch { /* ignore */ }
}

export async function cleanupStaleOnlinePlayers(): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const members = await r.smembers("online_players");
    for (const addr of members) {
      const alive = await r.exists(`online_heartbeat:${addr}`);
      if (!alive) {
        await r.srem("online_players", addr);
      }
    }
  } catch { /* ignore */ }
}

export async function markOffline(address: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.srem("online_players", address);
    await r.del(`online_heartbeat:${address}`);
  } catch { /* ignore */ }
}

export async function isOnline(address: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    return (await r.sismember("online_players", address)) === 1;
  } catch { return false; }
}

export async function getOnlinePlayers(): Promise<string[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    return await r.smembers("online_players");
  } catch { return []; }
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
  timestamp: number;
}

export async function recordMatchResult(address: string, result: MatchResult): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const key = `matches:${address}`;
    await r.zadd(key, result.timestamp, JSON.stringify(result));
    const count = await r.zcard(key);
    if (count > MAX_MATCH_HISTORY) {
      await r.zremrangebyrank(key, 0, count - MAX_MATCH_HISTORY - 1);
    }
  } catch { /* ignore */ }
}

export async function getMatchResults(address: string, limit = 20): Promise<MatchResult[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    const items = await r.zrevrange(`matches:${address}`, 0, limit - 1);
    return items.map((s) => JSON.parse(s) as MatchResult);
  } catch { return []; }
}

// ── Challenges ─────────────────────────────────────────────────

export interface Challenge {
  id: string;
  from: string;
  fromName: string;
  to: string;
  createdAt: number;
}

export async function createChallenge(challenge: Challenge): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    // 60 second TTL
    await r.setex(`challenge:${challenge.id}`, CHALLENGE_EXPIRY_SEC, JSON.stringify(challenge));
    // Index by recipient so we can fetch on reconnect
    await r.sadd(`challenges:to:${challenge.to}`, challenge.id);
    await r.expire(`challenges:to:${challenge.to}`, CHALLENGE_EXPIRY_SEC);
    return true;
  } catch { return false; }
}

export async function getChallenge(id: string): Promise<Challenge | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.get(`challenge:${id}`);
    if (!data) return null;
    return JSON.parse(data) as Challenge;
  } catch { return null; }
}

export async function deleteChallenge(id: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const challenge = await getChallenge(id);
    await r.del(`challenge:${id}`);
    if (challenge) {
      await r.srem(`challenges:to:${challenge.to}`, id);
    }
  } catch { /* ignore */ }
}

export async function getPendingChallengesFor(address: string): Promise<Challenge[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    const ids = await r.smembers(`challenges:to:${address}`);
    if (!ids.length) return [];
    const results: Challenge[] = [];
    for (const id of ids) {
      const data = await r.get(`challenge:${id}`);
      if (data) {
        results.push(JSON.parse(data) as Challenge);
      } else {
        // Expired — clean up the set
        await r.srem(`challenges:to:${address}`, id);
      }
    }
    return results;
  } catch { return []; }
}

// ── Ratings ───────────────────────────────────────────────────

export interface RatingInfo {
  rating: number;
  ratingChange: number;
}

export async function getRating(address: string): Promise<RatingInfo> {
  try {
    const r = getRedis();
    if (!r) return { rating: RATING_DEFAULT, ratingChange: 0 };
    const data = await r.hgetall(`rating:${address}`);
    return {
      rating: data.rating ? parseInt(data.rating) : RATING_DEFAULT,
      ratingChange: data.ratingChange ? parseInt(data.ratingChange) : 0,
    };
  } catch { return { rating: RATING_DEFAULT, ratingChange: 0 }; }
}

/** Get K-factor based on number of games played */
function getKFactor(totalGames: number): number {
  if (totalGames < RATING_PROVISIONAL_THRESHOLD) return RATING_K_PROVISIONAL;
  if (totalGames < RATING_ESTABLISHED_THRESHOLD) return RATING_K_INTERMEDIATE;
  return RATING_K_ESTABLISHED;
}

export async function updateRatings(
  winnerAddr: string,
  loserAddr: string,
  resultType: string,
): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;

    const [winnerData, loserData, winnerStats, loserStats] = await Promise.all([
      r.hgetall(`rating:${winnerAddr}`),
      r.hgetall(`rating:${loserAddr}`),
      getStats(winnerAddr),
      getStats(loserAddr),
    ]);
    const winnerRating = winnerData.rating ? parseInt(winnerData.rating) : RATING_DEFAULT;
    const loserRating = loserData.rating ? parseInt(loserData.rating) : RATING_DEFAULT;

    // Variable K-factor based on game count
    const winnerK = getKFactor(winnerStats.totalGames);
    const loserK = getKFactor(loserStats.totalGames);

    // Result multiplier for gammon/backgammon
    const multiplier = resultType === "backgammon" ? 2 : resultType === "gammon" ? 1.5 : 1;

    // Expected scores
    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    const expectedLoser = 1 - expectedWinner;

    // Rating changes (each player uses their own K-factor)
    const winnerChange = Math.round(winnerK * multiplier * (1 - expectedWinner));
    const loserChange = Math.round(loserK * multiplier * (0 - expectedLoser));

    const newWinnerRating = Math.max(RATING_MIN, winnerRating + winnerChange);
    const newLoserRating = Math.max(RATING_MIN, loserRating + loserChange);

    await r.hset(`rating:${winnerAddr}`, "rating", String(newWinnerRating), "ratingChange", String(winnerChange));
    await r.hset(`rating:${loserAddr}`, "rating", String(newLoserRating), "ratingChange", String(loserChange));

    // Update leaderboard sorted set
    await r.zadd("leaderboard", newWinnerRating, winnerAddr);
    await r.zadd("leaderboard", newLoserRating, loserAddr);
  } catch { /* ignore */ }
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
  try {
    const r = getRedis();
    if (!r) return { wins: 0, losses: 0, totalGames: 0, currentStreak: 0, currentStreakType: "" };
    const data = await r.hgetall(`stats:${address}`);
    if (data.totalGames) {
      return {
        wins: parseInt(data.wins || "0"),
        losses: parseInt(data.losses || "0"),
        totalGames: parseInt(data.totalGames || "0"),
        currentStreak: parseInt(data.currentStreak || "0"),
        currentStreakType: (data.currentStreakType || "") as "W" | "L" | "",
      };
    }
    // Backfill from match history
    const matches = await getMatchResults(address, 100);
    let wins = 0, losses = 0;
    for (const m of matches) {
      if (m.result === "W") wins++;
      else losses++;
    }
    // Compute current streak from most recent
    let streak = 0;
    let streakType: "W" | "L" | "" = "";
    for (const m of matches) {
      if (streakType === "") {
        streakType = m.result;
        streak = 1;
      } else if (m.result === streakType) {
        streak++;
      } else {
        break;
      }
    }
    const stats: PlayerStats = {
      wins, losses, totalGames: wins + losses,
      currentStreak: streak, currentStreakType: streakType,
    };
    // Persist backfilled stats
    if (stats.totalGames > 0) {
      await r.hset(`stats:${address}`,
        "wins", String(stats.wins),
        "losses", String(stats.losses),
        "totalGames", String(stats.totalGames),
        "currentStreak", String(stats.currentStreak),
        "currentStreakType", stats.currentStreakType,
      );
    }
    return stats;
  } catch { return { wins: 0, losses: 0, totalGames: 0, currentStreak: 0, currentStreakType: "" }; }
}

export async function updateStats(address: string, result: "W" | "L"): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const key = `stats:${address}`;
    const exists = await r.exists(key);
    if (!exists) {
      // Initialize
      await r.hset(key,
        "wins", result === "W" ? "1" : "0",
        "losses", result === "L" ? "1" : "0",
        "totalGames", "1",
        "currentStreak", "1",
        "currentStreakType", result,
      );
      return;
    }
    if (result === "W") {
      await r.hincrby(key, "wins", 1);
    } else {
      await r.hincrby(key, "losses", 1);
    }
    await r.hincrby(key, "totalGames", 1);

    // Update streak
    const streakType = await r.hget(key, "currentStreakType");
    if (streakType === result) {
      await r.hincrby(key, "currentStreak", 1);
    } else {
      await r.hset(key, "currentStreak", "1", "currentStreakType", result);
    }
  } catch { /* ignore */ }
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
  try {
    const r = getRedis();
    if (!r) return { entries: [], total: 0 };
    const total = await r.zcard("leaderboard");
    const members = await r.zrevrange("leaderboard", offset, offset + limit - 1, "WITHSCORES");
    const entries: LeaderboardEntry[] = [];
    for (let i = 0; i < members.length; i += 2) {
      const address = members[i];
      const rating = parseInt(members[i + 1]);
      const [profile, stats, online] = await Promise.all([
        getProfile(address),
        getStats(address),
        isOnline(address),
      ]);
      entries.push({
        rank: offset + (i / 2) + 1,
        address,
        displayName: profile?.displayName || profile?.username || address.slice(0, 12),
        rating,
        wins: stats.wins,
        losses: stats.losses,
        totalGames: stats.totalGames,
        online,
      });
    }
    return { entries, total };
  } catch { return { entries: [], total: 0 }; }
}

export async function getPlayerRank(address: string): Promise<number | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const rank = await r.zrevrank("leaderboard", address);
    return rank !== null ? rank : null;
  } catch { return null; }
}

export async function getLeaderboardSize(): Promise<number> {
  try {
    const r = getRedis();
    if (!r) return 0;
    return await r.zcard("leaderboard");
  } catch { return 0; }
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
  try {
    const r = getRedis();
    if (!r) return 0;
    return await r.scard("online_players");
  } catch { return 0; }
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
