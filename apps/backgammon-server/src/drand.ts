import { quicknetClient, fetchBeacon as drandFetchBeacon, type RandomnessBeacon } from "drand-client";

// ── drand quicknet constants ──────────────────────────────────────
export const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

// ── LRU cache ─────────────────────────────────────────────────────

const LRU_MAX = 100;
const cache = new Map<number, RandomnessBeacon>();

function cacheSet(round: number, beacon: RandomnessBeacon): void {
  if (cache.size >= LRU_MAX) {
    // Delete oldest entry (first key)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(round, beacon);
}

// ── Singleton client ──────────────────────────────────────────────

let client: ReturnType<typeof quicknetClient> | null = null;

function getClient() {
  if (!client) {
    client = quicknetClient();
  }
  return client;
}

// ── Public API ────────────────────────────────────────────────────

export interface DrandBeacon {
  round: number;
  randomness: string;
  signature: string;
}

/** Fetch the latest drand beacon (quicknet, 3s period, BLS-verified by drand-client) */
export async function latestBeacon(): Promise<DrandBeacon> {
  const c = getClient();
  const beacon = await drandFetchBeacon(c);
  const result: DrandBeacon = {
    round: beacon.round,
    randomness: beacon.randomness,
    signature: beacon.signature,
  };
  cacheSet(result.round, beacon);
  return result;
}

/** Fetch a specific drand beacon by round number */
export async function fetchBeacon(round: number): Promise<DrandBeacon> {
  const cached = cache.get(round);
  if (cached) {
    return { round: cached.round, randomness: cached.randomness, signature: cached.signature };
  }
  const c = getClient();
  const beacon = await drandFetchBeacon(c, round);
  const result: DrandBeacon = {
    round: beacon.round,
    randomness: beacon.randomness,
    signature: beacon.signature,
  };
  cacheSet(result.round, beacon);
  return result;
}
