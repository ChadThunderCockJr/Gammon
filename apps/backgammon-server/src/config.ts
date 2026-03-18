// Chain
export const CHAIN_ADDRESS_PREFIX = process.env.ADDRESS_PREFIX || "xion";
export const GAS_PRICE = process.env.GAS_PRICE || "0.025uxion";
export const DEFAULT_DENOM = process.env.GAMMON_DENOM || "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "1000", 10);
export const RATE_LIMIT_MAX_MESSAGES = parseInt(process.env.RATE_LIMIT_MAX_MESSAGES || "30", 10);

// WebSocket
export const WS_MAX_PAYLOAD_BYTES = parseInt(process.env.WS_MAX_PAYLOAD_BYTES || "16384", 10);

// Timeouts
export const DISCONNECT_GRACE_SEC = parseInt(process.env.DISCONNECT_GRACE_SEC || "30", 10);
export const DISCONNECT_GRACE_DOUBLE_SEC = parseInt(process.env.DISCONNECT_GRACE_DOUBLE_SEC || "120", 10);
export const DISCONNECT_CHECK_INTERVAL_MS = parseInt(process.env.DISCONNECT_CHECK_INTERVAL_MS || "5000", 10);
export const DOUBLE_DEPOSIT_TIMEOUT_MS = parseInt(process.env.DOUBLE_DEPOSIT_TIMEOUT_MS || "120000", 10);
export const DEFAULT_TURN_TIME_LIMIT_SEC = parseInt(process.env.DEFAULT_TURN_TIME_LIMIT_SEC || "60", 10);
export const INTER_GAME_DELAY_MS = parseInt(process.env.INTER_GAME_DELAY_MS || "3000", 10);

// Auth
export const NONCE_TTL_MS = parseInt(process.env.NONCE_TTL_MS || "300000", 10);
export const NONCE_CLEANUP_INTERVAL_MS = parseInt(process.env.NONCE_CLEANUP_INTERVAL_MS || "60000", 10);

// Clock defaults
export const DEFAULT_CLOCK_TIME_MS = parseInt(process.env.DEFAULT_CLOCK_TIME_MS || "180000", 10);
export const DEFAULT_CLOCK_INCREMENT_MS = parseInt(process.env.DEFAULT_CLOCK_INCREMENT_MS || "10000", 10);

// Matchmaking
export const MATCHMAKING_RATING_RANGE = parseInt(process.env.MATCHMAKING_RATING_RANGE || "200", 10);

// Social/Redis
export const ONLINE_HEARTBEAT_TTL_SEC = parseInt(process.env.ONLINE_HEARTBEAT_TTL_SEC || "300", 10);
export const ONLINE_CLEANUP_INTERVAL_MS = parseInt(process.env.ONLINE_CLEANUP_INTERVAL_MS || "60000", 10);
export const CHALLENGE_EXPIRY_SEC = parseInt(process.env.CHALLENGE_EXPIRY_SEC || "300", 10);
export const MAX_ACTIVITY_ITEMS = parseInt(process.env.MAX_ACTIVITY_ITEMS || "50", 10);
export const MAX_MATCH_HISTORY = parseInt(process.env.MAX_MATCH_HISTORY || "100", 10);
export const GAME_HISTORY_TTL_SEC = parseInt(process.env.GAME_HISTORY_TTL_SEC || String(365 * 24 * 60 * 60), 10);
export const MAX_SEARCH_RESULTS = parseInt(process.env.MAX_SEARCH_RESULTS || "10", 10);
export const REDIS_SCAN_BATCH_SIZE = parseInt(process.env.REDIS_SCAN_BATCH_SIZE || "200", 10);

// Rating
export const RATING_K_PROVISIONAL = parseInt(process.env.RATING_K_PROVISIONAL || "40", 10);
export const RATING_K_INTERMEDIATE = parseInt(process.env.RATING_K_INTERMEDIATE || "20", 10);
export const RATING_K_ESTABLISHED = parseInt(process.env.RATING_K_ESTABLISHED || "10", 10);
export const RATING_PROVISIONAL_THRESHOLD = parseInt(process.env.RATING_PROVISIONAL_THRESHOLD || "20", 10);
export const RATING_ESTABLISHED_THRESHOLD = parseInt(process.env.RATING_ESTABLISHED_THRESHOLD || "100", 10);
export const RATING_MIN = parseInt(process.env.RATING_MIN || "100", 10);
export const RATING_DEFAULT = parseInt(process.env.RATING_DEFAULT || "1500", 10);

// Stalling detection
export const STALLING_MIN_MOVES = parseInt(process.env.STALLING_MIN_MOVES || "3", 10);
export const STALLING_THRESHOLD_PCTG = parseFloat(process.env.STALLING_THRESHOLD_PCTG || "0.8");

// Redemption
export const REDEMPTION_POLL_INTERVAL_MS = parseInt(process.env.REDEMPTION_POLL_INTERVAL_MS || "10000", 10);
export const NFT_QUERY_LIMIT = parseInt(process.env.NFT_QUERY_LIMIT || "30", 10);

// drand (League of Entropy verifiable randomness)
export const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const DRAND_PUBLIC_KEY = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
export const DRAND_ENDPOINTS = ["https://api.drand.sh", "https://drand.cloudflare.com"];

// Redis connection
export const REDIS_MAX_RETRIES = parseInt(process.env.REDIS_MAX_RETRIES || "3", 10);
export const REDIS_RETRY_DELAY_MIN_MS = parseInt(process.env.REDIS_RETRY_DELAY_MIN_MS || "500", 10);
export const REDIS_RETRY_DELAY_MAX_MS = parseInt(process.env.REDIS_RETRY_DELAY_MAX_MS || "2000", 10);
