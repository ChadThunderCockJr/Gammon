import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_MESSAGES, WS_MAX_PAYLOAD_BYTES, INTER_GAME_DELAY_MS, ONLINE_CLEANUP_INTERVAL_MS } from "./config.js";
import { GAME_RUNTIME_INSTANCE_ID, GameManager } from "./game-manager.js";
import { Matchmaker } from "./matchmaking.js";
import { MatchManager } from "./match-manager.js";
import {
  assignMatchContinuationOwner,
  claimPendingMatchContinuations,
  completeMatchContinuation,
  listUnscoredDurableMatchGames,
  releaseMatchContinuation,
  releaseOwnedMatchContinuations,
  routePendingMatchContinuation,
  type DurableMatchContinuation,
} from "./match-store.js";
import { SocialManager } from "./social-manager.js";
import { getRedis } from "./redis.js";
import { closePubSub, initPubSub, onMessage, subscribeGlobal } from "./pubsub.js";
import {
  claimConcurrencyLease,
  consumeDistributedRateLimit,
  consumeRateLimit,
  createRateLimiter,
  releaseConcurrencyLease,
  trustedWebSocketClientIp,
} from "./rate-limit.js";
import * as socialStore from "./social-store.js";
import * as durableSocialStore from "./social-store-pg.js";
import type { ClientMessage, PlayerConnection, ServerGame, ServerMessage } from "./types.js";
import { logger } from "./logger.js";
import { sendWebSocketJson } from "./ws-send.js";
import { getLegalFirstMoves, createGameState } from "@xion-beginner/backgammon-core";
import type { Player, ResultType } from "@xion-beginner/backgammon-core";
import { checkDatabase, closeDatabase, initDatabase } from "./db.js";
import {
  enqueueDueCashRefunds,
  getCashQuote,
  quoteForGame,
  reconcileFinishedCashSettlements,
  reconcileLegacyCashReserves,
  requestCashSettlement,
} from "./cash-game-store.js";
import { cashGameRouter, publicCashGameConfig } from "./cash-game-router.js";
import { attestFundsEnvironment } from "./funds-attestation.js";
import { DRAND_CHAIN_HASH } from "./drand.js";
import {
  financeRouter,
  mountBraleWebhook,
  reconcileExpiredCashOutIntents,
} from "./finance-router.js";
import { startFinanceReconciliationScheduler, startFinanceWorker } from "./finance-worker.js";
import { fundsGate } from "./funds-config.js";
import {
  createSessionChallenge,
  createFinanceStepUpChallenge,
  logoutSession,
  requestOriginAllowed,
  requireCsrf,
  requireSession,
  revalidateSession,
  rotateSession,
  sessionFromRequest,
  verifySessionChallenge,
  type AuthenticatedRequest,
  type SessionRecord,
} from "./session.js";
import { parseClientMessage } from "./message-schema.js";
import { expireOrphanWaitingGames, gameOwnerInstanceId, getGameAuditSummary, getGameDiceRolls } from "./game-store.js";
import { createSupportCase, getSupportCase, listSupportCases, SUPPORT_CATEGORIES, type SupportCategory } from "./support-store.js";
import { moderationRouter } from "./moderation-router.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
let recoveryComplete = false;
let draining = false;
getRedis();
const databaseReady = await initDatabase();
if (databaseReady && fundsGate.config.mode !== "free") {
  try {
    await attestFundsEnvironment();
  } catch (error) {
    logger.error("Initial funds environment attestation failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  }
}
let fundsAttestationRunning = false;
async function refreshFundsAttestation(): Promise<void> {
  if (fundsAttestationRunning) return;
  fundsAttestationRunning = true;
  try {
    await attestFundsEnvironment();
  } finally {
    fundsAttestationRunning = false;
  }
}
const fundsAttestationTimer =
  databaseReady && fundsGate.config.mode !== "free"
    ? setInterval(() => {
        void refreshFundsAttestation().catch((error: unknown) => {
          logger.error("Funds environment re-attestation failed", {
            errorCode: error instanceof Error ? error.name : "unknown",
          });
        });
      }, 30_000)
    : null;
const financeRoutesEnabled = databaseReady && fundsGate.config.mode !== "free";
const cashRoutesEnabled = databaseReady && fundsGate.config.mode !== "free";

const wsRateLimits = new Map<WebSocket, { count: number; resetAt: number }>();

function checkRateLimit(ws: WebSocket): boolean {
  const now = Date.now();
  let entry = wsRateLimits.get(ws);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    wsRateLimits.set(ws, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_MESSAGES) {
    send(ws, { type: "error", message: "Rate limit exceeded" });
    ws.close(1008, "Rate limit exceeded");
    return false;
  }
  return true;
}

const webhookRateLimit = createRateLimiter({ scope: "webhook", max: 300, windowMs: 60_000 });
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
if (financeRoutesEnabled) mountBraleWebhook(app, webhookRateLimit);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || requestOriginAllowed(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-Support-Token"],
}));
app.use((_request, response, next) => {
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "64kb" }));
const generalApiRateLimit = createRateLimiter({ scope: "api", max: 240, windowMs: 60_000 });
const sessionRateLimit = createRateLimiter({ scope: "session", max: 20, windowMs: 5 * 60_000 });
const financialApiRateLimit = createRateLimiter({ scope: "financial", max: 90, windowMs: 60_000 });
const supportApiRateLimit = createRateLimiter({ scope: "support", max: 12, windowMs: 60 * 60_000 });
app.use("/api", generalApiRateLimit);
app.post("/api/session/challenge", sessionRateLimit, createSessionChallenge);
app.post("/api/session/verify", sessionRateLimit, verifySessionChallenge);
app.post(
  "/api/session/finance-step-up",
  sessionRateLimit,
  requireSession,
  requireCsrf,
  createFinanceStepUpChallenge,
);
app.get("/api/session/current", requireSession, (request, response) => {
  const session = (request as AuthenticatedRequest).session;
  response.json({ principal: session?.principal, expiresAt: session ? new Date(session.expiresAt).toISOString() : null });
});
app.post("/api/session/logout", requireSession, requireCsrf, async (request, response) => {
  await logoutSession(request, response);
  response.status(204).end();
});
app.post("/api/session/rotate", requireSession, requireCsrf, async (request, response) => {
  const session = await rotateSession(request, response);
  if (!session) {
    response.status(401).json({ error: "authentication_required" });
    return;
  }
  response.json({
    principal: session.principal,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
});
if (databaseReady) app.use("/api/moderation", generalApiRateLimit, moderationRouter);
app.get("/api/funds/config", (_request, response) => {
  response.json(fundsGate.publicState());
});
app.get("/api/cash-games/config", async (_request, response) => {
  response.json(await publicCashGameConfig());
});
if (databaseReady) app.use("/api/funds", financialApiRateLimit, financeRouter);
if (cashRoutesEnabled) app.use("/api/cash-games", financialApiRateLimit, cashGameRouter);

function parseSupportRequest(body: unknown): {
  category: SupportCategory;
  description: string;
  contactEmail: string | null;
  reference: string | null;
} | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const category = typeof value.category === "string" ? value.category : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const contactEmail = typeof value.contactEmail === "string" ? value.contactEmail.trim().toLowerCase() : null;
  const reference = typeof value.reference === "string" && value.reference.trim()
    ? value.reference.trim().slice(0, 128)
    : null;
  if (
    !SUPPORT_CATEGORIES.includes(category as SupportCategory) ||
    description.length < 20 ||
    description.length > 5_000 ||
    (contactEmail !== null && !/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(contactEmail))
  ) {
    return null;
  }
  return { category: category as SupportCategory, description, contactEmail, reference };
}

app.post("/api/support/cases/public", supportApiRateLimit, async (request, response) => {
  const parsed = parseSupportRequest(request.body);
  if (!parsed || !parsed.contactEmail) {
    response.status(400).json({ error: "invalid_support_case" });
    return;
  }
  try {
    const created = await createSupportCase({ principal: null, ...parsed });
    response.status(201).json(created);
  } catch {
    response.status(503).json({ error: "support_unavailable" });
  }
});

app.post("/api/support/cases", supportApiRateLimit, requireSession, requireCsrf, async (request, response) => {
  const parsed = parseSupportRequest(request.body);
  const principal = (request as AuthenticatedRequest).session?.principal;
  if (!parsed || !principal) {
    response.status(400).json({ error: "invalid_support_case" });
    return;
  }
  try {
    const created = await createSupportCase({ principal, ...parsed });
    response.status(201).json({ supportCase: created.supportCase });
  } catch {
    response.status(503).json({ error: "support_unavailable" });
  }
});

app.get("/api/support/cases", requireSession, async (request, response) => {
  const principal = (request as AuthenticatedRequest).session?.principal;
  if (!principal) {
    response.status(401).json({ error: "authentication_required" });
    return;
  }
  try {
    response.json({ cases: await listSupportCases(principal) });
  } catch {
    response.status(503).json({ error: "support_unavailable" });
  }
});

app.get("/api/support/cases/:id", supportApiRateLimit, async (request, response) => {
  const id = typeof request.params.id === "string" ? request.params.id : "";
  const accessToken = request.get("x-support-token") ?? null;
  try {
    const session = await sessionFromRequest(request);
    const supportCase = await getSupportCase(id, session?.principal ?? null, accessToken);
    if (!supportCase) {
      response.status(404).json({ error: "support_case_not_found" });
      return;
    }
    response.json({ supportCase });
  } catch {
    response.status(503).json({ error: "support_unavailable" });
  }
});

// Helper: resolve address to display name
async function getDisplayName(address: string): Promise<string> {
  try {
    const profile = await socialStore.getProfile(address);
    return profile?.displayName || profile?.username || address;
  } catch {
    return address;
  }
}

app.get("/live", (_request, response) => {
  response.status(draining ? 503 : 200).json({ status: draining ? "draining" : "alive" });
});

app.get("/ready", async (_request, response) => {
  const database = await checkDatabase();
  const funds = fundsGate.publicState();
  const attestationReady = funds.mode === "free" || funds.attestationCycleFresh;
  const recoveryReady = funds.mode === "free" || funds.recoveryEnabled;
  const ready = !draining && recoveryComplete && database.connected && database.migrated && attestationReady && recoveryReady;
  response.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    draining,
    recoveryComplete,
    database,
    funds: {
      mode: funds.mode,
      entryEnabled: funds.entryEnabled,
      recoveryEnabled: funds.recoveryEnabled,
      recoveryReady,
      attestationCycleFresh: funds.attestationCycleFresh,
      attestationCycleCompletedAt: funds.attestationCycleCompletedAt,
    },
  });
});

// Health check
app.get("/health", async (_req, res) => {
  const database = await checkDatabase();
  const funds = fundsGate.publicState();
  const attestationReady = funds.mode === "free" || funds.attestationCycleFresh;
  const recoveryReady = funds.mode === "free" || funds.recoveryEnabled;
  const healthy = database.connected && database.migrated && attestationReady && recoveryReady;
  const health: Record<string, unknown> = {
    status: healthy ? "ok" : "degraded",
    uptime: process.uptime(),
    recoveryComplete,
    database,
    funds: {
      mode: funds.mode,
      entryEnabled: funds.entryEnabled,
      recoveryEnabled: funds.recoveryEnabled,
      attestationCycleFresh: funds.attestationCycleFresh,
      attestationCycleCompletedAt: funds.attestationCycleCompletedAt,
      recoveryReady,
      actionBlockers: funds.actionBlockers,
    },
  };
  try {
    const r = getRedis();
    if (r) {
      await r.ping();
      health.redis = "ok";
    } else {
      health.redis = "unavailable";
    }
  } catch {
    health.redis = "error";
    health.status = "degraded";
  }
  res.status(health.status === "ok" ? 200 : 503).json(health);
});

// Profile REST endpoint
app.get("/api/profile/:address", async (request, response) => {
  try {
    const address = typeof request.params.address === "string" ? request.params.address : null;
    if (!address) {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    const profile = await durableSocialStore.getProfile(address);
    if (!profile) {
      response.status(404).json({ error: "profile_not_found" });
      return;
    }
    response.json(profile);
  } catch {
    response.status(503).json({ error: "profile_unavailable" });
  }
});

// Match history REST endpoints
app.get("/api/matches/:address", async (request, response) => {
  try {
    const address = typeof request.params.address === "string" ? request.params.address : null;
    if (!address) {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    if (!await durableSocialStore.getProfile(address)) {
      response.status(404).json({ error: "profile_not_found" });
      return;
    }
    const matches = await durableSocialStore.getMatchResults(address);
    response.json({ matches });
  } catch {
    response.status(503).json({ error: "match_history_unavailable" });
  }
});

// Stats + rating merged
app.get("/api/stats/:address", async (request, response) => {
  try {
    const address = typeof request.params.address === "string" ? request.params.address : null;
    if (!address) {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    if (!await durableSocialStore.getProfile(address)) {
      response.status(404).json({ error: "profile_not_found" });
      return;
    }
    const [stats, rating] = await Promise.all([
      durableSocialStore.getStats(address),
      durableSocialStore.getRating(address),
    ]);
    response.json({ ...stats, ...rating });
  } catch {
    response.status(503).json({ error: "player_stats_unavailable" });
  }
});

// Leaderboard
app.get("/api/leaderboard", async (request, response) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? "50"), 10) || 50, 1), 100);
    const offset = Math.max(Number.parseInt(String(request.query.offset ?? "0"), 10) || 0, 0);
    const [durableEntries, total] = await Promise.all([
      durableSocialStore.getLeaderboard(limit, offset),
      durableSocialStore.getLeaderboardSize(),
    ]);
    const entries = await Promise.all(durableEntries.map(async (entry) => ({
      ...entry,
      online: await socialStore.isOnline(entry.address),
    })));
    response.json({ entries, total });
  } catch {
    response.status(503).json({ error: "leaderboard_unavailable" });
  }
});

// Player rank
app.get("/api/rank/:address", async (request, response) => {
  try {
    const address = typeof request.params.address === "string" ? request.params.address : null;
    if (!address) {
      response.status(400).json({ error: "invalid_address" });
      return;
    }
    const rank = await durableSocialStore.getPlayerRank(address);
    response.json({ rank });
  } catch {
    response.status(503).json({ error: "rank_unavailable" });
  }
});

// Friend relationships and presence are private to the authenticated owner.
app.get("/api/leaderboard/friends/:address", requireSession, async (request, response) => {
  const principal = (request as AuthenticatedRequest).session?.principal;
  if (!principal || request.params.address !== principal) {
    response.status(403).json({ error: "forbidden" });
    return;
  }
  try {
    const entries = await socialStore.getFriendsLeaderboard(principal);
    response.json({ entries });
  } catch {
    response.status(503).json({ error: "friends_leaderboard_unavailable" });
  }
});

// Online count
app.get("/api/online-count", async (_req, res) => {
  const count = await socialStore.getOnlineCount();
  res.json({ count });
});


app.get("/api/game/:gameId/dice-proofs", requireSession, async (request, response) => {
  try {
    const gameId = typeof request.params.gameId === "string" ? request.params.gameId : null;
    if (!gameId) {
      response.status(400).json({ error: "invalid_game_id" });
      return;
    }
    const principal = (request as AuthenticatedRequest).session?.principal;
    const summary = principal ? await getGameAuditSummary(principal, gameId) : null;
    if (!summary) {
      response.status(404).json({ error: "game_audit_not_found" });
      return;
    }
    const durableRolls = await getGameDiceRolls(gameId);
    if (durableRolls.length > 0) {
      const firstProof = durableRolls.find((roll) => roll.proof)?.proof;
      response.json({
        gameId,
        drandChain: DRAND_CHAIN_HASH,
        playerWhite: firstProof?.playerWhite ?? summary.white,
        playerBlack: firstProof?.playerBlack ?? summary.black,
        rolls: durableRolls.map((roll) => roll.proof ?? {
          turnNumber: roll.turnNumber,
          player: roll.player,
          dice: [roll.die1, roll.die2],
          proofStatus: "unverifiable",
        }),
      });
      return;
    }
    response.json({ gameId, drandChain: DRAND_CHAIN_HASH, playerWhite: summary.white, playerBlack: summary.black, rolls: [] });
  } catch {
    response.status(503).json({ error: "game_audit_unavailable" });
  }
});

app.get("/api/game/:gameId/history", requireSession, async (request, response) => {
  try {
    const principal = (request as AuthenticatedRequest).session?.principal;
    const gameId = typeof request.params.gameId === "string" ? request.params.gameId : null;
    if (!gameId) {
      response.status(400).json({ error: "invalid_game_id" });
      return;
    }
    const summary = principal ? await getGameAuditSummary(principal, gameId) : null;
    if (!summary) {
      response.status(404).json({ error: "game_audit_not_found" });
      return;
    }
    response.json(summary);
  } catch {
    response.status(503).json({ error: "game_audit_unavailable" });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES }); // 16KB max

interface WebSocketUpgradeContext {
  readonly session: SessionRecord;
  readonly connectionIp: string;
  readonly leaseToken: string;
}

const WS_UPGRADE_ATTEMPTS_PER_MINUTE = 60;
const WS_CONNECTIONS_PER_PRINCIPAL = 5;
const WS_CONNECTIONS_PER_IP = 50;
const WS_CONNECTION_LEASE_MS = 90_000;
const WS_HEARTBEAT_MS = 30_000;
const webSocketUpgradeContexts = new WeakMap<WebSocket, WebSocketUpgradeContext>();

function rejectWebSocketUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function claimWebSocketCapacity(
  session: SessionRecord,
  connectionIp: string,
): Promise<WebSocketUpgradeContext | null> {
  const leaseToken = randomUUID();
  const ipClaimed = await claimConcurrencyLease({
    scope: "ws_connections_ip",
    identity: connectionIp,
    token: leaseToken,
    max: WS_CONNECTIONS_PER_IP,
    ttlMs: WS_CONNECTION_LEASE_MS,
  });
  if (!ipClaimed) return null;
  const principalClaimed = await claimConcurrencyLease({
    scope: "ws_connections_principal",
    identity: session.principal,
    token: leaseToken,
    max: WS_CONNECTIONS_PER_PRINCIPAL,
    ttlMs: WS_CONNECTION_LEASE_MS,
  });
  if (!principalClaimed) {
    await releaseConcurrencyLease({
      scope: "ws_connections_ip",
      identity: connectionIp,
      token: leaseToken,
    });
    return null;
  }
  return { session, connectionIp, leaseToken };
}

async function renewWebSocketCapacity(context: WebSocketUpgradeContext): Promise<boolean> {
  const [ipRenewed, principalRenewed] = await Promise.all([
    claimConcurrencyLease({
      scope: "ws_connections_ip",
      identity: context.connectionIp,
      token: context.leaseToken,
      max: WS_CONNECTIONS_PER_IP,
      ttlMs: WS_CONNECTION_LEASE_MS,
    }),
    claimConcurrencyLease({
      scope: "ws_connections_principal",
      identity: context.session.principal,
      token: context.leaseToken,
      max: WS_CONNECTIONS_PER_PRINCIPAL,
      ttlMs: WS_CONNECTION_LEASE_MS,
    }),
  ]);
  return ipRenewed && principalRenewed;
}

async function releaseWebSocketCapacity(context: WebSocketUpgradeContext): Promise<void> {
  await Promise.all([
    releaseConcurrencyLease({
      scope: "ws_connections_ip",
      identity: context.connectionIp,
      token: context.leaseToken,
    }),
    releaseConcurrencyLease({
      scope: "ws_connections_principal",
      identity: context.session.principal,
      token: context.leaseToken,
    }),
  ]);
}

const financeWorker = financeRoutesEnabled ? startFinanceWorker() : null;
const financeReconciliationScheduler = financeRoutesEnabled ? startFinanceReconciliationScheduler() : null;
const cashOutIntentReconciliationTimer = financeRoutesEnabled
  ? setInterval(() => {
      void reconcileExpiredCashOutIntents().catch((error: unknown) => {
        logger.error("Cash-out intent reconciliation failed", {
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      });
    }, 30_000)
  : null;
if (financeRoutesEnabled) {
  void reconcileExpiredCashOutIntents().catch((error: unknown) => {
    logger.error("Initial cash-out intent reconciliation failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  });
}

async function routeWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  if (draining) {
    rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    rejectWebSocketUpgrade(socket, 404, "Not Found");
    return;
  }
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  if ((process.env.NODE_ENV === "production" && !origin) || (origin && !requestOriginAllowed(origin))) {
    rejectWebSocketUpgrade(socket, 403, "Forbidden");
    return;
  }
  const connectionIp = trustedWebSocketClientIp(request);
  const upgradeLimit = await consumeDistributedRateLimit({
    scope: "ws_upgrade_ip",
    identity: connectionIp,
    max: WS_UPGRADE_ATTEMPTS_PER_MINUTE,
    windowMs: 60_000,
  });
  if (!upgradeLimit.allowed) {
    rejectWebSocketUpgrade(socket, 429, "Too Many Requests");
    return;
  }

  let session: SessionRecord | null;
  try {
    session = await sessionFromRequest(request as unknown as AuthenticatedRequest);
  } catch (error) {
    logger.error("WebSocket session lookup failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
    return;
  }
  if (!session) {
    rejectWebSocketUpgrade(socket, 401, "Unauthorized");
    return;
  }

  const requestedGameId = url.searchParams.get("game_id");
  let routedGameId = requestedGameId;
  let continuationOwner: string | null = null;
  try {
    routedGameId ??= await gameManager.getAuthoritativePlayerGame(session.principal) ?? null;
    continuationOwner = await routePendingMatchContinuation(
      session.principal,
      GAME_RUNTIME_INSTANCE_ID,
      requestedGameId,
    );
    if (continuationOwner) routedGameId = null;
  } catch (error) {
    logger.error("WebSocket routing failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
      reason: error instanceof Error ? error.message : "unknown",
    });
    rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
    return;
  }
  if (continuationOwner && continuationOwner !== GAME_RUNTIME_INSTANCE_ID) {
    if (!/^[A-Za-z0-9_-]+$/.test(continuationOwner)) {
      rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    socket.end(`HTTP/1.1 409 Conflict\r\nfly-replay: instance=${continuationOwner}\r\nConnection: close\r\n\r\n`);
    return;
  }
  if (routedGameId) {
    let owner: string | null;
    try {
      owner = await gameOwnerInstanceId(routedGameId);
    } catch {
      rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (owner && owner !== GAME_RUNTIME_INSTANCE_ID) {
      if (!/^[A-Za-z0-9_-]+$/.test(owner)) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      socket.end(`HTTP/1.1 409 Conflict\r\nfly-replay: instance=${owner}\r\nConnection: close\r\n\r\n`);
      return;
    }
  }

  const upgradeContext = await claimWebSocketCapacity(session, connectionIp);
  if (!upgradeContext) {
    rejectWebSocketUpgrade(socket, 429, "Too Many Requests");
    return;
  }
  try {
    wss.handleUpgrade(request, socket, head, (ws) => {
      webSocketUpgradeContexts.set(ws, upgradeContext);
      wss.emit("connection", ws, request);
    });
  } catch {
    await releaseWebSocketCapacity(upgradeContext);
    if (!socket.destroyed) rejectWebSocketUpgrade(socket, 400, "Bad Request");
  }
}

server.on("upgrade", (request, socket, head) => {
  void routeWebSocketUpgrade(request, socket, head);
});

const gameManager = new GameManager();
const matchmaker = new Matchmaker(gameManager, GAME_RUNTIME_INSTANCE_ID);
const matchManager = new MatchManager();
const localContinuationAssignments = new Set<string>();

// Tournament financial and bracket state machines are intentionally not launched.
app.get("/api/tournaments", (_request, response) => {
  response.json({ tournaments: [], registrationAvailable: false });
});
app.post("/api/tournaments/:id/register", requireSession, requireCsrf, (_request, response) => {
  response.status(409).json({ error: "tournaments_unavailable" });
});

// Track authenticated connections
const connections = new Map<WebSocket, { address: string; rating: number }>();

const socialManager = new SocialManager(connections, GAME_RUNTIME_INSTANCE_ID);
if (await initPubSub()) {
  await subscribeGlobal();
  onMessage((channel, message) => {
    if (channel !== "global") return;
    try {
      socialManager.deliverDistributedChallenge(JSON.parse(message));
    } catch {
      // Cross-replica notifications are hints; the PostgreSQL inbox is replayed on reconnect.
    }
  });
}


function send(ws: WebSocket, msg: ServerMessage): void {
  sendWebSocketJson(ws, msg);
}

const READ_ONLY_WS_MESSAGES: Partial<Record<ClientMessage["type"], true>> = {
  search_players: true,
  get_friends: true,
  get_activity: true,
};
function mutationCommand(message: { type: string; command_id?: string; expected_revision?: number }) {
  return message.command_id && message.expected_revision !== undefined
    ? { commandId: message.command_id, expectedRevision: message.expected_revision, commandType: message.type }
    : undefined;
}
function gameDecisionFields(game: ServerGame) {
  const doublePlayer = game.pendingDoubleOffer
    ? gameManager.getPlayerColor(game, game.pendingDoubleOffer.doubler)
    : null;
  const resignationPlayer = game.pendingResignation
    ? gameManager.getPlayerColor(game, game.pendingResignation.player)
    : null;
  return {
    phase: game.phase,
    deadline_at: game.deadlineAt === null ? null : new Date(game.deadlineAt).toISOString(),
    pending_double: game.pendingDoubleOffer && doublePlayer ? {
      player: doublePlayer,
      cube_value: game.pendingDoubleOffer.offeredCube,
      deadline_at: new Date(game.pendingDoubleOffer.deadlineAt).toISOString(),
      offer_revision: game.pendingDoubleOffer.offerRevision,
    } : null,
    pending_resignation: game.pendingResignation && resignationPlayer ? {
      player: resignationPlayer,
      resign_type: game.pendingResignation.resignType,
      deadline_at: new Date(game.pendingResignation.deadlineAt).toISOString(),
      offer_revision: game.pendingResignation.offerRevision,
    } : null,
  };
}


/** Handle game over: broadcast, score match, and start next game if match continues */
async function handleGameOver(gameId: string, winner: Player, resultType: ResultType) {
  const game = gameManager.getGame(gameId);
  if (!game) return;

  const cubeValue = game.gameState.cubeValue ?? 1;

  const matchResult = await matchManager.scoreGame(gameId, winner, resultType, cubeValue);
  if (matchResult?.continuationDurable) {
    localContinuationAssignments.add(gameId);
    try {
      const owner = await assignMatchContinuationOwner(gameId, GAME_RUNTIME_INSTANCE_ID);
      if (owner) localContinuationAssignments.delete(gameId);
    } catch (error) {
      logger.error("Match continuation ownership assignment failed", {
        gameId,
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (matchResult && !matchResult.applied) {
    gameManager.releaseTerminalGame(gameId);
    return;
  }

  const cashQuote = await quoteForGame(gameId);
  if (cashQuote) {
    await requestCashSettlement({
      gameId,
      winner: winner === "white" ? game.playerWhite?.address ?? "" : game.playerBlack?.address ?? "",
      cubeValue: cubeValue as 1 | 2 | 4 | 8,
      resultMultiplier: resultType === "normal" ? 1 : resultType === "gammon" ? 2 : 3,
      cubeWasTurned: cubeValue > 1,
    });
  }
  // Broadcast only after a cash settlement intent is durable.
  gameManager.broadcastToGame(game, {
    type: "game_over",
    game_id: gameId,
    revision: game.revision,
    winner,
    result_type: resultType,
    game_state: game.gameState,
    ...(cashQuote ? { settlement_pending: true } : {}),
    ...(matchResult ? { match_state: matchResult.matchState, match_over: matchResult.matchOver } : {}),
  });

  try {
    await socialManager.recordMatchResult(game, winner, resultType);
  } catch (error) {
    logger.error("Durable social result failed", {
      gameId,
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  }
  await socialStore.saveGameHistory(game.id, game.gameState.moveHistory);

  // Persist drand dice proofs
  const diceProofs = gameManager.getDiceHistory(gameId);
  if (diceProofs.length > 0) {
    await socialStore.saveDiceProofs(gameId, {
      gameId,
      drandChain: DRAND_CHAIN_HASH,
      playerWhite: game.playerWhite?.address || "",
      playerBlack: game.playerBlack?.address || "",
      rolls: diceProofs,
    });
  }

  // Database-backed matches are continued exclusively by the leased reconciler below.
  if (matchResult && !matchResult.matchOver && !matchResult.continuationDurable) {
    const matchId = matchManager.getMatchForGame(gameId)?.id;
    if (!matchId) return;

    setTimeout(() => {
      void (async () => {
      const match = matchManager.getMatch(matchId);
      if (!match || match.status !== "playing") return;

      // Create a new game for the match
      const newGame = gameManager.createGame(match.wagerAmount);
      await matchManager.setCurrentGame(matchId, newGame.id);

      // Re-join the players (swap colors each game)
      const isEvenGame = match.matchState.gameNumber % 2 === 0;
      const whiteAddr = isEvenGame ? match.playerBlackAddress : match.playerWhiteAddress;
      const blackAddr = isEvenGame ? match.playerWhiteAddress : match.playerBlackAddress;

      // Find existing WebSocket connections for these players
      const whiteWs = findPlayerWs(whiteAddr);
      const blackWs = findPlayerWs(blackAddr);

      if (whiteWs && blackWs) {
        const whiteConn = connections.get(whiteWs);
        const blackConn = connections.get(blackWs);
        if (whiteConn && blackConn) {
          await gameManager.joinGame(newGame.id, { ws: whiteWs, address: whiteAddr, rating: whiteConn.rating, connectedAt: Date.now() });
          await gameManager.joinGame(newGame.id, { ws: blackWs, address: blackAddr, rating: blackConn.rating, connectedAt: Date.now() });

          const updatedGame = gameManager.getGame(newGame.id)!;
          const [wN, bN] = await Promise.all([
            getDisplayName(whiteAddr),
            getDisplayName(blackAddr),
          ]);

          gameManager.broadcastToGame(updatedGame, {
            type: "next_game",
            game_id: newGame.id,
            match_state: match.matchState,
            game_state: updatedGame.gameState,
            white: whiteAddr,
            black: blackAddr,
          });

          // Also send game_start so the client knows color assignments
          gameManager.broadcastToGame(updatedGame, {
            type: "game_start",
            game_id: newGame.id,
            white: whiteAddr,
            black: blackAddr,
            white_name: wN,
            black_name: bN,
            game_state: updatedGame.gameState,
            match_state: match.matchState,
            turn_time_limit: updatedGame.turnTimeLimit,
            ...gameDecisionFields(updatedGame),
          });
        }
      }
      })().catch((error: unknown) => {
        logger.error("Next match game creation failed", {
          matchId,
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      });
    }, INTER_GAME_DELAY_MS); // 3 second delay between games
  }
  gameManager.releaseTerminalGame(gameId);
}
gameManager.setTerminalHandler(handleGameOver);

async function sendGameSnapshot(ws: WebSocket, address: string, game: ServerGame): Promise<void> {
  const color = gameManager.getPlayerColor(game, address);
  if (!color || game.status !== "playing") return;
  const [whiteName, blackName] = await Promise.all([
    getDisplayName(game.playerWhite?.address || ""),
    getDisplayName(game.playerBlack?.address || ""),
  ]);
  const isPendingConfirmation = game.pendingConfirmation === address;
  const isMyTurn = game.gameState.currentPlayer === color;
  const hasDice = game.gameState.dice !== null;
  const legalMoves = isMyTurn && hasDice && game.gameState.movesRemaining.length > 0
    ? getLegalFirstMoves(game.gameState.board, color, game.gameState.movesRemaining)
    : [];
  const match = matchManager.getMatchForGame(game.id);
  send(ws, {
    type: "game_start",
    game_id: game.id,
    revision: game.revision,
    white: game.playerWhite?.address || "",
    black: game.playerBlack?.address || "",
    white_name: whiteName,
    black_name: blackName,
    game_state: game.gameState,
    legal_moves: legalMoves,
    ...(match ? { match_state: match.matchState } : {}),
    turn_time_limit: game.turnTimeLimit,
    needs_confirmation: isPendingConfirmation,
    ...gameDecisionFields(game),
  });
}

async function authenticateConnection(
  ws: WebSocket,
  address: string,
  presenceConnectionId: string,
): Promise<void> {
  const ratingInfo = await socialStore.getRating(address);
  connections.set(ws, { address, rating: ratingInfo.rating });

  void socialStore.ensureProfile(address).then(() => socialManager.sendProfile(ws, address));
  const becameOnline = await socialStore.markOnline(
    address,
    presenceConnectionId,
    GAME_RUNTIME_INSTANCE_ID,
  );
  await socialManager.replayChallenges(ws, address);
  if (becameOnline) void socialManager.broadcastPresence(address, "online");

  const existingGameId = await gameManager.getAuthoritativePlayerGame(address);
  if (!existingGameId) return;
  if (!matchManager.getMatchForGame(existingGameId)) await matchManager.restoreMatches();
  const reconnected = await gameManager.handleReconnect(existingGameId, {
    ws,
    address,
    rating: ratingInfo.rating,
    connectedAt: Date.now(),
  });
  if (!reconnected) return;
  const game = gameManager.getGame(existingGameId);
  if (!game) return;
  if (game.status === "playing") await sendGameSnapshot(ws, address, game);
  else if (game.phase === "review") {
    send(ws, {
      type: "game_review",
      game_id: game.id,
      reason: game.reviewReason ?? "platform_recovery",
      funds_status: "held_for_review",
      revision: game.revision,
    });
  }
}

/** Find the WebSocket for a player by address */
function findPlayerWs(address: string): WebSocket | null {
  for (const [ws, conn] of connections) {
    if (conn.address === address && ws.readyState === WebSocket.OPEN) return ws;
  }
  return null;
}
async function processMatchContinuation(continuation: DurableMatchContinuation): Promise<boolean> {
  const match = matchManager.getMatch(continuation.matchId) ?? await matchManager.hydrateMatch(continuation.matchId);
  if (!match || match.status !== "playing") return false;
  const whiteWs = findPlayerWs(continuation.playerWhiteAddress);
  const blackWs = findPlayerWs(continuation.playerBlackAddress);
  const whiteConnection = whiteWs ? connections.get(whiteWs) : undefined;
  const blackConnection = blackWs ? connections.get(blackWs) : undefined;
  if (!whiteWs || !blackWs || !whiteConnection || !blackConnection) return false;

  const game = await gameManager.hydrateGameForParticipant(
    continuation.nextGameId,
    continuation.playerWhiteAddress,
  );
  if (!game) throw new Error("MATCH_CONTINUATION_RESERVATION_NOT_FOUND");
  const white = await gameManager.joinGame(game.id, {
    ws: whiteWs,
    address: continuation.playerWhiteAddress,
    rating: whiteConnection.rating,
    connectedAt: Date.now(),
  });
  const black = await gameManager.joinGame(game.id, {
    ws: blackWs,
    address: continuation.playerBlackAddress,
    rating: blackConnection.rating,
    connectedAt: Date.now(),
  });
  if (white?.color !== "white" || black?.color !== "black") {
    throw new Error("MATCH_CONTINUATION_PLAYER_CONFLICT");
  }
  await matchManager.setCurrentGame(continuation.matchId, game.id);
  const [whiteName, blackName] = await Promise.all([
    getDisplayName(continuation.playerWhiteAddress),
    getDisplayName(continuation.playerBlackAddress),
  ]);
  gameManager.broadcastToGame(game, {
    type: "next_game",
    game_id: game.id,
    match_state: match.matchState,
    game_state: game.gameState,
    white: continuation.playerWhiteAddress,
    black: continuation.playerBlackAddress,
  });
  gameManager.broadcastToGame(game, {
    type: "game_start",
    game_id: game.id,
    revision: game.revision,
    white: continuation.playerWhiteAddress,
    black: continuation.playerBlackAddress,
    white_name: whiteName,
    black_name: blackName,
    game_state: game.gameState,
    match_state: match.matchState,
    turn_time_limit: game.turnTimeLimit,
    ...gameDecisionFields(game),
  });
  return true;
}

let matchContinuationRunning = false;
async function reconcileMatchContinuations(): Promise<void> {
  if (!databaseReady || !recoveryComplete || draining || matchContinuationRunning) return;
  matchContinuationRunning = true;
  try {
    for (const terminal of await listUnscoredDurableMatchGames()) {
      const recovered = await matchManager.scoreGame(
        terminal.gameId,
        terminal.winner,
        terminal.resultType,
        terminal.cubeValue,
      );
      if (recovered?.continuationDurable) {
        await assignMatchContinuationOwner(terminal.gameId, GAME_RUNTIME_INSTANCE_ID);
      }
    }
    for (const completedGameId of localContinuationAssignments) {
      const owner = await assignMatchContinuationOwner(completedGameId, GAME_RUNTIME_INSTANCE_ID);
      if (owner) localContinuationAssignments.delete(completedGameId);
    }
    const continuations = await claimPendingMatchContinuations(GAME_RUNTIME_INSTANCE_ID);
    for (const continuation of continuations) {
      try {
        if (!(await processMatchContinuation(continuation))) {
          await releaseMatchContinuation(continuation, GAME_RUNTIME_INSTANCE_ID);
          continue;
        }
        await completeMatchContinuation(continuation, GAME_RUNTIME_INSTANCE_ID);
      } catch (error) {
        await releaseMatchContinuation(continuation, GAME_RUNTIME_INSTANCE_ID).catch(() => undefined);
        logger.error("Durable next match game creation failed", {
          matchId: continuation.matchId,
          completedGameId: continuation.completedGameId,
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  } finally {
    matchContinuationRunning = false;
  }
}


function hasAnotherConnection(address: string, closingSocket: WebSocket): boolean {
  for (const [socket, connection] of connections) {
    if (socket !== closingSocket && connection.address === address && socket.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

wss.on("connection", async (ws: WebSocket) => {
  const upgradeContext = webSocketUpgradeContexts.get(ws);
  webSocketUpgradeContexts.delete(ws);
  if (!upgradeContext) {
    ws.terminate();
    return;
  }
  let activeSession = upgradeContext.session;
  const connectionIp = upgradeContext.connectionIp;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let revalidationTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let capacityReleased = false;
  let pongReceived = true;
  let heartbeatRunning = false;

  const releaseCapacity = (): void => {
    if (capacityReleased) return;
    capacityReleased = true;
    void releaseWebSocketCapacity(upgradeContext).catch(() => undefined);
  };

  ws.on("pong", () => {
    pongReceived = true;
    const conn = connections.get(ws);
    if (!conn) return;
    void socialStore.refreshOnlineHeartbeat(
      conn.address,
      upgradeContext.leaseToken,
      GAME_RUNTIME_INSTANCE_ID,
    ).then((renewed) => {
      if (!renewed && ws.readyState === WebSocket.OPEN) ws.close(1013, "Presence lease unavailable");
    }).catch(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1013, "Presence lease unavailable");
    });
  });
  ws.on("close", () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    if (revalidationTimer) clearInterval(revalidationTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    releaseCapacity();
    wsRateLimits.delete(ws);
    const conn = connections.get(ws);
    if (!conn) return;
    connections.delete(ws);
    void socialStore.markOffline(
      conn.address,
      upgradeContext.leaseToken,
      GAME_RUNTIME_INSTANCE_ID,
    ).then((becameOffline) => {
      if (becameOffline) void socialManager.broadcastPresence(conn.address, "offline");
    }).catch(() => undefined);
    if (hasAnotherConnection(conn.address, ws)) return;
    if (!draining) {
      const result = gameManager.handleDisconnect(conn.address);
      if (result) {
        const { game } = result;
        if (game.status === "playing" && !game.gameState.gameOver) {
          void gameManager.startDisconnectGracePeriod(game, conn.address, (gameId, winner, resultType) => {
            void handleGameOver(gameId, winner, resultType);
          }).catch(() => {
            logger.error("Failed to persist disconnect grace period", { gameId: game.id });
          });
        }
      }
    }
    void matchmaker.removeFromQueue(conn.address);
  });

  try {
    await authenticateConnection(ws, activeSession.principal, upgradeContext.leaseToken);
  } catch {
    ws.close(1013, "Authentication setup failed");
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  expiryTimer = setTimeout(() => {
    ws.close(1008, "Session expired");
  }, Math.max(0, activeSession.expiresAt - Date.now()));
  revalidationTimer = setInterval(() => {
    void revalidateSession(activeSession).then((current) => {
      if (!current) {
        ws.close(1008, "Session revoked");
        return;
      }
      activeSession = current;
    }).catch(() => {
      ws.close(1013, "Session validation unavailable");
    });
  }, 60_000);
  heartbeatTimer = setInterval(() => {
    if (heartbeatRunning) return;
    if (!pongReceived) {
      ws.terminate();
      return;
    }
    void Promise.all([
      renewWebSocketCapacity(upgradeContext),
      socialStore.refreshOnlineHeartbeat(
        activeSession.principal,
        upgradeContext.leaseToken,
        GAME_RUNTIME_INSTANCE_ID,
      ),
    ])
      .then(([capacityRenewed, presenceRenewed]) => {
        if (!capacityRenewed || !presenceRenewed) {
          ws.close(1013, "Connection lease unavailable");
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        pongReceived = false;
        ws.ping();
      })
      .catch(() => ws.close(1013, "Connection lease unavailable"))
      .finally(() => {
        heartbeatRunning = false;
      });
  }, WS_HEARTBEAT_MS);
  pongReceived = false;
  ws.ping();

  let messageQueue = Promise.resolve();
  let queuedMessages = 0;

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (Date.now() >= activeSession.expiresAt) {
      ws.close(1008, "Session expired");
      return;
    }
    if (!checkRateLimit(ws)) return;
    if (isBinary) {
      send(ws, { type: "error", message: "Binary messages are not accepted" });
      ws.close(1003, "Binary messages are not accepted");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString("utf8"));
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }
    const msg = parseClientMessage(raw);
    if (!msg) {
      send(ws, { type: "error", message: "Invalid message schema" });
      return;
    }
    if (queuedMessages >= RATE_LIMIT_MAX_MESSAGES) {
      send(ws, { type: "error", message: "Too many queued commands" });
      ws.close(1013, "Too many queued commands");
      return;
    }
    queuedMessages += 1;
    messageQueue = messageQueue
      .then(async () => {
        const [principalLimit, ipLimit] = await Promise.all([
          consumeRateLimit({
            scope: "ws_principal",
            identity: activeSession.principal,
            max: RATE_LIMIT_MAX_MESSAGES,
            windowMs: RATE_LIMIT_WINDOW_MS,
          }),
          consumeRateLimit({
            scope: "ws_ip",
            identity: connectionIp,
            max: RATE_LIMIT_MAX_MESSAGES * 4,
            windowMs: RATE_LIMIT_WINDOW_MS,
          }),
        ]);
        if (!principalLimit.allowed || !ipLimit.allowed) {
          send(ws, { type: "error", message: "Rate limit exceeded" });
          ws.close(1008, "Rate limit exceeded");
          return;
        }
        if (!READ_ONLY_WS_MESSAGES[msg.type]) {
          const current = await revalidateSession(activeSession);
          if (!current) {
            send(ws, { type: "error", message: "Unauthorized" });
            ws.close(1008, "Unauthorized");
            return;
          }
          activeSession = current;
        }
        await handleMessage(ws, msg);
      })
      .catch(async (error: unknown) => {
        const code = error instanceof Error ? error.message : "REQUEST_FAILED";
        const recoverable: Record<string, true> = {
          GAME_REVISION_CONFLICT: true,
          COMMAND_ID_REUSE: true,
          COMMAND_IN_PROGRESS: true,
          DATABASE_UNAVAILABLE: true,
          DURABLE_DICE_COMMITMENT_REQUIRED: true,
          GAME_OWNER_ROUTING_REQUIRED: true,
          GAME_OWNERSHIP_LOST: true,
          CASH_GAME_NOT_FUNDED: true,
          CASH_GAME_START_ACK_REQUIRED: true,
          CASH_GAME_REALITY_CHECK_REQUIRED: true,
          CASH_GAME_REVIEW: true,
        };
        if (!recoverable[code]) {
          logger.error("WebSocket request failed", {
            messageType: msg.type,
            errorCode: error instanceof Error ? error.name : "unknown",
            reason: code,
          });
        }
        if (code === "GAME_REVISION_CONFLICT" && "game_id" in msg) {
          const game = gameManager.getGame(msg.game_id);
          if (game?.status === "playing") await sendGameSnapshot(ws, activeSession.principal, game);
          else if (game?.phase === "review") {
            send(ws, {
              type: "game_review",
              game_id: game.id,
              reason: game.reviewReason ?? "platform_recovery",
              funds_status: "held_for_review",
              revision: game.revision,
            });
          }
        }
        const message = code === "GAME_REVISION_CONFLICT"
          ? "The game changed before this command committed. The latest state is being restored."
          : code === "CASH_GAME_START_ACK_REQUIRED"
            ? "Acknowledge the funded-game start before playing."
            : code === "CASH_GAME_REALITY_CHECK_REQUIRED"
              ? "Complete the required reality check before playing."
              : code === "CASH_GAME_REVIEW"
                ? "This cash game is paused for review."
                : code === "GAME_OWNER_ROUTING_REQUIRED" || code === "GAME_OWNERSHIP_LOST"
                  ? "Reconnect through the current game session to continue."
                  : "Request could not be processed";
        send(ws, {
          type: "error",
          code: recoverable[code] ? code : "REQUEST_FAILED",
          message,
        });
      })
      .finally(() => {
        queuedMessages -= 1;
      });
  });

});

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  if (
    "game_id" in msg &&
    msg.type !== "join_game" &&
    msg.type !== "rejoin_game" &&
    databaseReady
  ) {
    const owner = await gameOwnerInstanceId(msg.game_id);
    if (owner && owner !== GAME_RUNTIME_INSTANCE_ID) throw new Error("GAME_OWNER_ROUTING_REQUIRED");
  }

  switch (msg.type) {
    case "create_game": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const turnTimeLimit = msg.time_control && msg.time_control > 0 ? msg.time_control : 60;
      const game = gameManager.createGame(msg.wager_amount, turnTimeLimit);
      const matchLength = msg.match_length ?? 1;
      if (matchLength > 1) game.pendingMatchLength = matchLength;
      const player: PlayerConnection = {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      };
      const result = await gameManager.joinGame(game.id, player);
      if (result) {
        logger.info("Game created", { gameId: game.id, address: conn.address });
        send(ws, { type: "game_created", game_id: game.id, revision: game.revision, color: result.color });
      } else {
        gameManager.discardUnjoinedGame(game.id);
        send(ws, { type: "error", message: "Cannot create game", code: "CANNOT_CREATE" });
      }

      // Match settings were persisted with the creator join above.
      break;
    }

    case "join_cash_game": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      const quote = await getCashQuote(conn.address, msg.quote_id);
      if (!quote || quote.state !== "active") {
        send(ws, { type: "error", message: "Cash game is not funded", code: "CASH_GAME_NOT_ACTIVE" });
        return;
      }
      const existingGame = gameManager.getGame(quote.gameId);
      const existingCashParticipants = [existingGame?.playerWhite?.address, existingGame?.playerBlack?.address]
        .filter((address): address is string => Boolean(address));
      if (
        !existingCashParticipants.includes(conn.address) &&
        existingCashParticipants.length === 1 &&
        await socialStore.isBlockedEitherDirection(conn.address, existingCashParticipants[0])
      ) {
        send(ws, { type: "error", message: "This game is unavailable", code: "PLAYER_BLOCKED" });
        return;
      }
      const player: PlayerConnection = {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      };
      const result = await gameManager.joinCashGame(quote.gameId, player, quote.id);
      if (!result) {
        send(ws, { type: "error", message: "Cannot join cash game", code: "CANNOT_JOIN" });
        return;
      }
      const game = gameManager.getGame(quote.gameId);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      const opponent = result.color === "white" ? game.playerBlack : game.playerWhite;
      if (game.status !== "playing" || !game.playerWhite || !game.playerBlack) {
        send(ws, { type: "game_created", game_id: game.id, revision: game.revision, color: result.color });
        break;
      }
      send(ws, {
        type: "game_joined",
        game_id: game.id,
        revision: game.revision,
        color: result.color,
        opponent: opponent?.address ?? "",
        opponent_name: opponent ? await getDisplayName(opponent.address) : "",
      });
      const [whiteName, blackName] = await Promise.all([
        getDisplayName(game.playerWhite.address),
        getDisplayName(game.playerBlack.address),
      ]);
      gameManager.broadcastToGame(game, {
        type: "game_start",
        game_id: game.id,
        revision: game.revision,
        white: game.playerWhite.address,
        black: game.playerBlack.address,
        white_name: whiteName,
        black_name: blackName,
        game_state: game.gameState,
        turn_time_limit: game.turnTimeLimit,
        ...gameDecisionFields(game),
      });
      break;
    }

    case "join_game": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      let game = gameManager.getGame(msg.game_id) ?? await gameManager.hydrateGameForParticipant(msg.game_id, conn.address);
      if (await quoteForGame(msg.game_id)) {
        send(ws, { type: "error", message: "Use the funded cash-game join flow", code: "CASH_GAME_JOIN_REQUIRED" });
        return;
      }
      if (!game) { send(ws, { type: "error", message: "Game not found", code: "GAME_NOT_FOUND" }); return; }
      const existingParticipants = [game.playerWhite?.address, game.playerBlack?.address]
        .filter((address): address is string => Boolean(address));
      if (
        !existingParticipants.includes(conn.address) &&
        existingParticipants.length === 1 &&
        await socialStore.isBlockedEitherDirection(conn.address, existingParticipants[0])
      ) {
        send(ws, { type: "error", message: "This game is unavailable", code: "PLAYER_BLOCKED" });
        return;
      }

      const player: PlayerConnection = {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      };
      const result = await gameManager.joinGame(msg.game_id, player);
      if (!result) { send(ws, { type: "error", message: "Cannot join game", code: "CANNOT_JOIN" }); return; }
      await matchmaker.acknowledgeGameJoin(conn.address, msg.game_id);

      // Notify joiner
      const opponentConn = result.color === "white" ? game.playerBlack : game.playerWhite;
      const opponentAddr = opponentConn?.address || game.playerWhite?.address || "";
      const opponentName = await getDisplayName(opponentAddr);
      send(ws, {
        type: "game_joined",
        game_id: msg.game_id,
        revision: game.revision,
        color: result.color,
        opponent: opponentAddr,
        opponent_name: opponentName,
      });

      // Notify both players game is starting
      if (game.playerWhite && game.playerBlack) {
        // Create match if pending from create_game
        if (game.pendingMatchLength && game.pendingMatchLength > 1) {
          await matchManager.createMatch(
            game.id,
            game.pendingMatchLength,
            game.playerWhite.address,
            game.playerBlack.address,
            game.id,
            game.wagerAmount,
          );
          delete game.pendingMatchLength;
        }

        const match = matchManager.getMatchForGame(game.id);
        const [wN, bN] = await Promise.all([
          getDisplayName(game.playerWhite.address),
          getDisplayName(game.playerBlack.address),
        ]);
        const startMsg: ServerMessage = {
          type: "game_start",
          game_id: game.id,
          revision: game.revision,
          white: game.playerWhite.address,
          black: game.playerBlack.address,
          white_name: wN,
          black_name: bN,
          game_state: game.gameState,
          ...(match ? { match_state: match.matchState } : {}),
          turn_time_limit: game.turnTimeLimit,
          ...gameDecisionFields(game),
        };
        gameManager.broadcastToGame(game, startMsg);
      }
      break;
    }

    case "join_queue": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const matchLength = (msg as { match_length?: number }).match_length ?? 1;
      const result = await matchmaker.addToQueue({
        address: conn.address,
        ws,
        rating: conn.rating,
        wagerAmount: msg.wager_amount,
        matchLength,
        joinedAt: Date.now(),
      });

      if (result.matched && result.gameId) {
        const game = gameManager.getGame(result.gameId) ?? await gameManager.hydrateGameForParticipant(result.gameId, conn.address);
        if (!game) {
          send(ws, { type: "error", message: "Game not found", code: "GAME_NOT_FOUND" });
          return;
        }
        const joined = await gameManager.joinGame(result.gameId, {
          ws,
          address: conn.address,
          rating: conn.rating,
          connectedAt: Date.now(),
        });
        if (!joined) {
          send(ws, { type: "error", message: "Cannot join game", code: "CANNOT_JOIN" });
          return;
        }
        await matchmaker.acknowledgeGameJoin(conn.address, result.gameId);
        if (!game.playerWhite || !game.playerBlack) {
          send(ws, {
            type: "game_created",
            game_id: result.gameId,
            revision: game.revision,
            color: result.color ?? "white",
          });
          break;
        }

        // Create a match if matchLength > 1
        const ml = result.matchLength ?? matchLength;
        if (ml > 1) {
          await matchManager.createMatch(
            result.gameId, // use first gameId as matchId
            ml,
            game.playerWhite!.address,
            game.playerBlack!.address,
            result.gameId,
            msg.wager_amount,
          );
        }

        const [wN, bN] = await Promise.all([
          getDisplayName(game.playerWhite!.address),
          getDisplayName(game.playerBlack!.address),
        ]);
        const match = matchManager.getMatchForGame(result.gameId);
        const startMsg: ServerMessage = {
          type: "game_start",
          game_id: result.gameId,
          revision: game.revision,
          white: game.playerWhite!.address,
          black: game.playerBlack!.address,
          white_name: wN,
          black_name: bN,
          game_state: game.gameState,
          ...(match ? { match_state: match.matchState } : {}),
          turn_time_limit: game.turnTimeLimit,
          ...gameDecisionFields(game),
        };
        gameManager.broadcastToGame(game, startMsg);
      } else {
        send(ws, { type: "queue_joined", position: result.position ?? 1 });
      }
      break;
    }

    case "leave_queue": {
      const conn = connections.get(ws);
      if (!conn) return;
      await matchmaker.removeFromQueue(conn.address);
      send(ws, { type: "queue_left" });
      break;
    }

    case "rejoin_game": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      const priorGame = gameManager.getGame(msg.game_id);
      const wasDisconnected = priorGame?.disconnectedPlayer === conn.address;
      const reconnected = await gameManager.handleReconnect(msg.game_id, {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      });
      const game = gameManager.getGame(msg.game_id);
      if (!reconnected || !game) {
        send(ws, { type: "error", message: "Reconnect through the current game session.", code: "GAME_RECONNECT_REQUIRED" });
        return;
      }
      const color = gameManager.getPlayerColor(game, conn.address);
      if (!color) {
        send(ws, { type: "error", message: "Reconnect through the current game session.", code: "GAME_RECONNECT_REQUIRED" });
        return;
      }
      if (game.status === "playing") {
        await sendGameSnapshot(ws, conn.address, game);
      } else if (game.phase === "review") {
        send(ws, {
          type: "game_review",
          game_id: game.id,
          reason: game.reviewReason ?? "platform_recovery",
          funds_status: "held_for_review",
          revision: game.revision,
        });
      }
      if (wasDisconnected && game.status === "playing") {
        const opponent = color === "white" ? game.playerBlack : game.playerWhite;
        gameManager.sendToPlayer(opponent, {
          type: "opponent_reconnected",
          game_id: msg.game_id,
        });
      }
      break;
    }

    case "roll_dice": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = await gameManager.rollDiceLocked(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot roll dice", code: "CANNOT_ROLL" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      const activePlayer = result.player;

      // Always send dice roll — never auto-end. Player must confirm.
      {
        const currentPlayer = activePlayer === "white" ? game.playerWhite : game.playerBlack;
        const opponentPlayer = activePlayer === "white" ? game.playerBlack : game.playerWhite;

        gameManager.sendToPlayer(currentPlayer, {
          type: "dice_rolled",
          game_id: msg.game_id,
          revision: game.revision,
          dice: result.dice,
          player: activePlayer,
          game_state: result.gameState,
          legal_moves: result.legalMoves,
          needs_confirmation: result.legalMoves.length === 0,
          drand_proof: result.drandProof,
          drand_failed: result.drandFailed,
        });
        gameManager.sendToPlayer(opponentPlayer, {
          type: "dice_rolled",
          game_id: msg.game_id,
          revision: game.revision,
          dice: result.dice,
          player: activePlayer,
          game_state: result.gameState,
          legal_moves: [],
          drand_proof: result.drandProof,
          drand_failed: result.drandFailed,
        });
      }
      break;
    }

    case "move": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const from = Number(msg.from);
      const to = Number(msg.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 25 || to < 0 || to > 25) {
        send(ws, { type: "error", message: "Invalid move coordinates" });
        return;
      }

      const result = await gameManager.applyMoveLocked(msg.game_id, conn.address, from, to, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Invalid move", code: "INVALID_MOVE" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      const playerColor = gameManager.getPlayerColor(game, conn.address)!;

      if (result.turnAutoEnded) {
        // Send move_made with needs_confirmation to the moving player
        const currentPlayer = playerColor === "white" ? game.playerWhite : game.playerBlack;
        const opponentPlayer = playerColor === "white" ? game.playerBlack : game.playerWhite;

        gameManager.sendToPlayer(currentPlayer, {
          type: "move_made",
          game_id: msg.game_id,
          revision: game.revision,
          move: result.move,
          player: result.playerColor,
          game_state: result.gameState,
          legal_moves: [],
          needs_confirmation: true,
        });
        gameManager.sendToPlayer(opponentPlayer, {
          type: "move_made",
          game_id: msg.game_id,
          revision: game.revision,
          move: result.move,
          player: result.playerColor,
          game_state: result.gameState,
          legal_moves: [],
        });
        // DON'T broadcast turn_ended — wait for explicit end_turn
      } else {
        gameManager.broadcastToGame(game, {
          type: "move_made",
          game_id: msg.game_id,
          revision: game.revision,
          move: result.move,
          player: result.playerColor,
          game_state: result.gameState,
          legal_moves: result.legalMoves,
        });
      }

      // Check if game is over
      if (result.gameState.gameOver) {
        logger.info("Game over", { gameId: msg.game_id, winner: result.gameState.winner!, resultType: result.gameState.resultType! });
        await handleGameOver(msg.game_id, result.gameState.winner!, result.gameState.resultType!);
      }
      break;
    }

    case "end_turn": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = await gameManager.handleEndTurnLocked(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot end turn", code: "CANNOT_END_TURN" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, {
        type: "turn_ended",
        game_id: msg.game_id,
        revision: game.revision,
        next_player: result.currentPlayer,
        game_state: result,
      });
      break;
    }

    case "undo_move": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = await gameManager.handleUndoLocked(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot undo", code: "CANNOT_UNDO" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, {
        type: "move_undone",
        game_id: msg.game_id,
        revision: game.revision,
        game_state: result.gameState,
        legal_moves: result.legalMoves,
      });
      break;
    }

    case "resign": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const resignType = msg.resign_type || "normal";
      const result = await gameManager.handleResignationTyped(msg.game_id, conn.address, resignType, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot resign", code: "CANNOT_RESIGN" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      if (result.offered) {
        // Gammon/backgammon resignation offered — opponent must accept/reject
        const playerColor = gameManager.getPlayerColor(game, conn.address)!;
        gameManager.broadcastToGame(game, {
          type: "resign_offered",
          game_id: msg.game_id,
          revision: game.revision,
          player: playerColor,
          resign_type: resignType,
          deadline_at: new Date(result.deadlineAt!).toISOString(),
          offer_revision: result.offerRevision!,
        });
      } else {
        // Normal resignation — immediate game over
        logger.info("Game over", { gameId: msg.game_id, winner: result.winner!, reason: "resignation" });
        await handleGameOver(msg.game_id, result.winner!, "normal");
      }
      break;
    }

    case "accept_resign": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = await gameManager.handleAcceptResignation(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot accept resignation" }); return; }

      logger.info("Game over", { gameId: msg.game_id, winner: result.winner, reason: "resignation accepted" });
      await handleGameOver(msg.game_id, result.winner, result.resultType);
      break;
    }

    case "reject_resign": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const rejected = await gameManager.handleRejectResignation(msg.game_id, conn.address, mutationCommand(msg));
      if (!rejected) { send(ws, { type: "error", message: "Cannot reject resignation" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, { type: "resign_rejected", game_id: msg.game_id, revision: game.revision });
      break;
    }

    case "offer_double": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      if (matchManager.getMatchForGame(msg.game_id)?.matchState.isCrawford) {
        send(ws, { type: "error", message: "Doubling is disabled during the Crawford game", code: "CANNOT_DOUBLE" });
        return;
      }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = await gameManager.handleOfferDouble(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot double", code: "CANNOT_DOUBLE" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, {
        type: "double_offered",
        game_id: msg.game_id,
        revision: game.revision,
        player: result.player,
        cube_value: result.cubeValue,
        deadline_at: new Date(result.deadlineAt).toISOString(),
        offer_revision: result.offerRevision,
      });
      break;
    }

    case "accept_double": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found" }); return; }

      // Cash games pre-fund the quoted maximum exposure. Accepting a double
      // never creates a mid-game deposit or a cancellation escape hatch.
      const result = await gameManager.handleAcceptDoubleFree(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot accept double", code: "CANNOT_ACCEPT" }); return; }

      gameManager.broadcastToGame(game, {
        type: "double_accepted",
        game_id: msg.game_id,
        revision: game.revision,
        cube_value: result.cubeValue,
        cube_owner: result.cubeOwner,
      });
      break;
    }

    case "reject_double": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found" }); return; }

      const result = await gameManager.handleRejectDouble(msg.game_id, conn.address, mutationCommand(msg));
      if (!result) { send(ws, { type: "error", message: "Cannot reject double", code: "CANNOT_REJECT" }); return; }

      gameManager.broadcastToGame(game, {
        type: "double_rejected",
        game_id: msg.game_id,
        revision: game.revision,
        winner: result.winner,
      });
      await handleGameOver(msg.game_id, result.winner, "normal");
      break;
    }


    case "submit_client_seed" as string: {
      // Deprecated: drand-based dice no longer needs client seeds
      break;
    }

    case "request_cash_review": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      const reviewed = await gameManager.requestCashReview(msg.game_id, conn.address, mutationCommand(msg)!);
      if (!reviewed) { send(ws, { type: "error", message: "Cash review is unavailable", code: "CANNOT_REVIEW" }); return; }
      break;
    }

    case "reaction": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found" }); return; }
      const opponent = game.playerWhite?.address === conn.address
        ? game.playerBlack?.address
        : game.playerBlack?.address === conn.address
          ? game.playerWhite?.address
          : null;
      if (!opponent) { send(ws, { type: "error", message: "Only players can react" }); return; }
      if (await socialStore.isBlockedEitherDirection(conn.address, opponent)) {
        send(ws, { type: "error", message: "You cannot contact this player" });
        return;
      }
      gameManager.broadcastToGame(game, {
        type: "reaction",
        game_id: msg.game_id,
        emoji: msg.emoji,
        from: conn.address,
      });
      break;
    }


    // Social message routing
    case "set_profile":
    case "set_username":
    case "search_players":
    case "get_friends":
    case "send_friend_request":
    case "accept_friend_request":
    case "reject_friend_request":
    case "remove_friend":
    case "get_activity":
    case "challenge_friend":
    case "accept_challenge":
    case "decline_challenge":
    case "block_user":
    case "unblock_user":
    case "report_user": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      await socialManager.handle(ws, conn.address, msg);
      break;
    }
  }
}
let matchmakingNotificationRunning = false;
const matchmakingNotificationTimer = setInterval(() => {
  if (!databaseReady || matchmakingNotificationRunning) return;
  matchmakingNotificationRunning = true;
  void matchmaker.takeMatchedNotifications()
    .then(async (notifications) => {
      for (const notification of notifications) {
        send(notification.ws, {
          type: "game_created",
          game_id: notification.gameId,
          revision: 0,
          color: notification.color,
        });
        await matchmaker.markNotified(notification.address);
      }
    })
    .catch((error: unknown) => {
      logger.error("Matchmaking notification reconciliation failed", {
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    })
    .finally(() => {
      matchmakingNotificationRunning = false;
    });
}, 500);
let waitingGameExpiryRunning = false;
const waitingGameExpiryTimer = setInterval(() => {
  if (!databaseReady || waitingGameExpiryRunning) return;
  waitingGameExpiryRunning = true;
  void expireOrphanWaitingGames()
    .catch((error: unknown) => logger.error("Waiting-game expiry failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    }))
    .finally(() => { waitingGameExpiryRunning = false; });
}, 60_000);

const matchmakingRecoveryTimer = setInterval(() => {
  if (!databaseReady || draining) return;
  void matchmaker.sweepStaleReservations().catch((error: unknown) => {
    logger.error("Matchmaking reservation recovery failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  });
}, 5_000);



// Periodically remove expired per-connection presence leases.
const onlineCleanupTimer = setInterval(async () => {
  try {
    await socialStore.cleanupStaleOnlinePlayers();
  } catch { /* Expired leases are retried on the next interval. */ }
}, ONLINE_CLEANUP_INTERVAL_MS);

try {
  if (!databaseReady) throw new Error("DATABASE_UNAVAILABLE");
  const restoredMatches = await matchManager.restoreMatches();
  if (restoredMatches > 0) logger.info("Restored active matches", { count: restoredMatches });
  const restoredGames = await gameManager.restoreGames();
  if (restoredGames > 0) logger.info("Restored active games", { count: restoredGames });
  recoveryComplete = true;
} catch (error) {
  logger.error("Active-game recovery failed; readiness remains disabled", {
    errorCode: error instanceof Error ? error.name : "unknown",
  });
}
await reconcileMatchContinuations();
const matchContinuationTimer = setInterval(() => {
  void reconcileMatchContinuations().catch((error: unknown) => {
    logger.error("Match continuation reconciliation failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  });
}, 1_000);


async function reconcileSocialEffects(): Promise<void> {
  if (!databaseReady) return;
  const result = await durableSocialStore.reconcileCompletedGameEffects();
  if (result.applied > 0 || result.failed > 0) {
    logger.info("Reconciled completed game social effects", { ...result });
  }
}
await reconcileSocialEffects();
const socialReconciliationTimer = setInterval(() => {
  void reconcileSocialEffects().catch((error: unknown) => {
    logger.error("Social effect reconciliation failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  });
}, 30_000);

async function reconcileCashLifecycle(): Promise<void> {
  if (!databaseReady || fundsGate.config.mode === "free") return;
  const legacy = await reconcileLegacyCashReserves();
  const [refunds, settlements] = await Promise.all([
    enqueueDueCashRefunds(),
    reconcileFinishedCashSettlements(),
  ]);
  if (legacy.reconciled > 0 || legacy.pending > 0 || legacy.manual > 0) {
    logger.info("Reconciled legacy cash reserves", { ...legacy });
  }
  if (refunds > 0) logger.info("Enqueued expired cash-game refunds", { count: refunds });
  if (settlements.enqueued > 0 || settlements.reviewed > 0 || settlements.failed > 0) {
    logger.info("Reconciled finished cash games", { ...settlements });
  }
}
await reconcileCashLifecycle();
const cashLifecycleTimer = setInterval(() => {
  void reconcileCashLifecycle().catch((error: unknown) => {
    logger.error("Cash-game lifecycle reconciliation failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
  });
}, 30_000);


server.listen(PORT, () => {
  logger.info("Server started", { port: PORT, ws: "/ws", health: "/health" });
});

let shutdownPromise: Promise<void> | null = null;
async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  draining = true;
  shutdownPromise = (async () => {
    financeReconciliationScheduler?.stop();
    logger.info("Server draining", { signal });
    financeWorker?.stop();
    clearInterval(onlineCleanupTimer);
    clearInterval(matchmakingNotificationTimer);
    clearInterval(matchmakingRecoveryTimer);
    clearInterval(waitingGameExpiryTimer);
    clearInterval(matchContinuationTimer);
    clearInterval(socialReconciliationTimer);
    await releaseOwnedMatchContinuations(GAME_RUNTIME_INSTANCE_ID);
    await gameManager.prepareForDrain();
    clearInterval(cashLifecycleTimer);
    clearInterval(cashOutIntentReconciliationTimer ?? undefined);
    await closePubSub();
    clearInterval(fundsAttestationTimer ?? undefined);
    for (const socket of wss.clients) socket.close(1012, "Server restarting");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
    process.exit(0);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
