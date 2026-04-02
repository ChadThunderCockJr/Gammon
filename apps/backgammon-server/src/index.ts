import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_MESSAGES, WS_MAX_PAYLOAD_BYTES, INTER_GAME_DELAY_MS, ONLINE_CLEANUP_INTERVAL_MS } from "./config.js";
import { GameManager } from "./game-manager.js";
import { Matchmaker } from "./matchmaking.js";
import { MatchManager } from "./match-manager.js";
import { SocialManager } from "./social-manager.js";
import { getRedis } from "./redis.js";
import * as socialStore from "./social-store.js";
import type { ClientMessage, PlayerConnection, ServerMessage } from "./types.js";
import { logger } from "./logger.js";
import { getLegalFirstMoves, createGameState } from "@xion-beginner/backgammon-core";
import type { Player, ResultType } from "@xion-beginner/backgammon-core";

const PORT = parseInt(process.env.PORT || "3001", 10);

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

const app = express();
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
  credentials: true,
  methods: ["GET"],
  allowedHeaders: ["Content-Type"],
}));
app.use(express.json());

// Helper: resolve address to display name
async function getDisplayName(address: string): Promise<string> {
  try {
    const profile = await socialStore.getProfile(address);
    return profile?.displayName || profile?.username || address;
  } catch {
    return address;
  }
}

// Health check
app.get("/health", async (_req, res) => {
  const health: Record<string, unknown> = { status: "ok", uptime: process.uptime() };
  try {
    const { getRedis: getR } = await import("./redis.js");
    const r = getR();
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
app.get("/api/profile/:address", async (req, res) => {
  const profile = await socialStore.getProfile(req.params.address);
  if (!profile) {
    res.json({ address: req.params.address, displayName: "", createdAt: 0 });
  } else {
    res.json({ address: req.params.address, ...profile });
  }
});

// Match history REST endpoints
app.get("/api/matches/:address", async (req, res) => {
  const matches = await socialStore.getMatchResults(req.params.address);
  res.json({ matches });
});

// Stats + rating merged
app.get("/api/stats/:address", async (req, res) => {
  const [stats, rating] = await Promise.all([
    socialStore.getStats(req.params.address),
    socialStore.getRating(req.params.address),
  ]);
  res.json({ ...stats, ...rating });
});

// Leaderboard
app.get("/api/leaderboard", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const result = await socialStore.getLeaderboard(limit, offset);
  res.json(result);
});

// Player rank
app.get("/api/rank/:address", async (req, res) => {
  const rank = await socialStore.getPlayerRank(req.params.address);
  res.json({ rank });
});

// Friends leaderboard
app.get("/api/leaderboard/friends/:address", async (req, res) => {
  const entries = await socialStore.getFriendsLeaderboard(req.params.address);
  res.json({ entries });
});

// Online count
app.get("/api/online-count", async (_req, res) => {
  const count = await socialStore.getOnlineCount();
  res.json({ count });
});

app.get("/api/game/:gameId/dice-proofs", async (req, res) => {
  const proofs = await socialStore.getDiceProofs(req.params.gameId);
  if (!proofs) {
    // Try in-memory from active game
    const inMemory = gameManager.getDiceHistory(req.params.gameId);
    if (inMemory.length === 0) {
      res.status(404).json({ error: "Dice proofs not found" });
    } else {
      res.json({
        gameId: req.params.gameId,
        drandChain: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
        rolls: inMemory,
      });
    }
  } else {
    res.json(proofs);
  }
});

app.get("/api/game/:gameId/history", async (req, res) => {
  const moveHistory = await socialStore.getGameHistory(req.params.gameId);
  if (!moveHistory) {
    res.status(404).json({ error: "Game history not found" });
  } else {
    res.json({ gameId: req.params.gameId, moveHistory });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: WS_MAX_PAYLOAD_BYTES }); // 16KB max

// Initialize Redis
getRedis();

const gameManager = new GameManager();
const matchmaker = new Matchmaker(gameManager);
const matchManager = new MatchManager();

// Track authenticated connections
const connections = new Map<WebSocket, { address: string; rating: number }>();

const socialManager = new SocialManager(connections, gameManager);

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Handle game over: broadcast, score match, and start next game if match continues */
async function handleGameOver(gameId: string, winner: Player, resultType: ResultType) {
  const game = gameManager.getGame(gameId);
  if (!game) return;

  const cubeValue = game.gameState.cubeValue ?? 1;
  const matchResult = matchManager.scoreGame(gameId, winner, resultType, cubeValue);

  // Broadcast game_over with match state
  gameManager.broadcastToGame(game, {
    type: "game_over",
    game_id: gameId,
    winner,
    result_type: resultType,
    game_state: game.gameState,
    ...(matchResult ? { match_state: matchResult.matchState, match_over: matchResult.matchOver } : {}),
  });

  socialManager.recordMatchResult(game, winner, resultType);
  socialStore.saveGameHistory(game.id, game.gameState.moveHistory);

  // Persist drand dice proofs
  const diceProofs = gameManager.getDiceHistory(gameId);
  if (diceProofs.length > 0) {
    socialStore.saveDiceProofs(gameId, {
      gameId,
      drandChain: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
      playerWhite: game.playerWhite?.address || "",
      playerBlack: game.playerBlack?.address || "",
      rolls: diceProofs,
    });
  }

  // If match continues, start next game after a delay
  if (matchResult && !matchResult.matchOver) {
    const matchId = matchManager.getMatchForGame(gameId)?.id;
    if (!matchId) return;

    setTimeout(async () => {
      const match = matchManager.getMatch(matchId);
      if (!match || match.status !== "playing") return;

      // Create a new game for the match
      const newGame = gameManager.createGame(match.wagerAmount);
      matchManager.setCurrentGame(matchId, newGame.id);

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
          gameManager.joinGame(newGame.id, { ws: whiteWs, address: whiteAddr, rating: whiteConn.rating, connectedAt: Date.now() });
          gameManager.joinGame(newGame.id, { ws: blackWs, address: blackAddr, rating: blackConn.rating, connectedAt: Date.now() });

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
          });
        }
      }
    }, INTER_GAME_DELAY_MS); // 3 second delay between games
  }
}

/** Find the WebSocket for a player by address */
function findPlayerWs(address: string): WebSocket | null {
  for (const [ws, conn] of connections) {
    if (conn.address === address && ws.readyState === WebSocket.OPEN) {
      return ws;
    }
  }
  return null;
}

wss.on("connection", async (ws: WebSocket) => {
  logger.info("WebSocket connected");

  // Send auth challenge nonce
  const { generateNonce } = await import("./auth.js");
  const nonce = generateNonce();
  send(ws, { type: "auth_challenge" as const, nonce });

  ws.on("message", (data: Buffer) => {
    if (!checkRateLimit(ws)) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      logger.warn("Invalid JSON received from client");
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on("close", () => {
    wsRateLimits.delete(ws);
    const conn = connections.get(ws);
    if (conn) {
      // Handle disconnect from active game — start grace period
      const result = gameManager.handleDisconnect(conn.address);
      if (result) {
        const { game } = result;
        if (game.status === "playing" && !game.gameState.gameOver) {
          gameManager.startDisconnectGracePeriod(game, conn.address, (gId, winner, resultType) => {
            void handleGameOver(gId, winner, resultType);
          });
        }
      }

      // Remove from matchmaking
      matchmaker.removeFromQueue(conn.address);

      // Social: mark offline, notify friends
      socialStore.markOffline(conn.address);
      socialManager.broadcastPresence(conn.address, "offline");

      connections.delete(ws);
    }
  });
});

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  // Refresh online heartbeat for every message from an authenticated connection
  const authedConn = connections.get(ws);
  if (authedConn) {
    socialStore.refreshOnlineHeartbeat(authedConn.address);
  }

  switch (msg.type) {
    case "auth": {
      // Allow multiple connections per address (game + social use separate WebSockets)

      // Verify wallet signature
      const { verifySignature } = await import("./auth.js");
      if (!msg.signature || !msg.pubkey || !msg.nonce) {
        send(ws, { type: "error", message: "Missing signature, pubkey, or nonce" });
        return;
      }
      const valid = await verifySignature(msg.address, msg.nonce, msg.signature, msg.pubkey, msg.signer_address);
      if (!valid) {
        send(ws, { type: "error", message: "Invalid signature" });
        ws.close(1008, "Authentication failed");
        return;
      }

      const ratingInfo = await socialStore.getRating(msg.address);
      connections.set(ws, { address: msg.address, rating: ratingInfo.rating });
      logger.info("Player authenticated", { address: msg.address });
      send(ws, { type: "auth_ok", address: msg.address });

      // Social: ensure profile, send it, mark online, notify friends
      socialStore.ensureProfile(msg.address).then(() => {
        socialManager.sendProfile(ws, msg.address);
      });
      socialStore.markOnline(msg.address);
      socialManager.broadcastPresence(msg.address, "online");

      // Notify this WebSocket about an existing active game (don't update
      // the game's player WS here — that happens via rejoin_game to avoid
      // the social WebSocket overwriting the game WebSocket).
      const existingGameId = gameManager.getPlayerGame(msg.address);
      if (existingGameId) {
        const game = gameManager.getGame(existingGameId);
        if (game && game.status === "playing") {
          const color = gameManager.getPlayerColor(game, msg.address);
          if (color) {
            const [wName, bName] = await Promise.all([
              getDisplayName(game.playerWhite?.address || ""),
              getDisplayName(game.playerBlack?.address || ""),
            ]);
            // Include legal_moves so the client can resume mid-turn
            const isPendingConfirmation = game.pendingConfirmation === msg.address;
            const isMyTurn = game.gameState.currentPlayer === color;
            const hasDice = game.gameState.dice !== null;
            const legalMoves = (isMyTurn && hasDice && game.gameState.movesRemaining.length > 0)
              ? getLegalFirstMoves(game.gameState.board, color, game.gameState.movesRemaining)
              : [];
            send(ws, {
              type: "game_start",
              game_id: existingGameId,
              white: game.playerWhite?.address || "",
              black: game.playerBlack?.address || "",
              white_name: wName,
              black_name: bName,
              game_state: game.gameState,
              legal_moves: legalMoves,
              turn_time_limit: game.turnTimeLimit,
              needs_confirmation: isPendingConfirmation,
            });
          }
        }
      }
      break;
    }

    case "create_game": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const turnTimeLimit = msg.time_control && msg.time_control > 0 ? msg.time_control : 60;
      const game = gameManager.createGame(msg.wager_amount, turnTimeLimit);
      const player: PlayerConnection = {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      };
      const result = gameManager.joinGame(game.id, player);
      if (result) {
        logger.info("Game created", { gameId: game.id, address: conn.address });
        send(ws, { type: "game_created", game_id: game.id, color: result.color });
      }

      // Store match settings on the game for deferred match creation when second player joins
      const matchLength = msg.match_length ?? 1;
      if (matchLength > 1) {
        game.pendingMatchLength = matchLength;
      }
      break;
    }

    case "join_game": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found", code: "GAME_NOT_FOUND" }); return; }

      const player: PlayerConnection = {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      };
      const result = gameManager.joinGame(msg.game_id, player);
      if (!result) { send(ws, { type: "error", message: "Cannot join game", code: "CANNOT_JOIN" }); return; }

      // Notify joiner
      const opponentConn = result.color === "white" ? game.playerBlack : game.playerWhite;
      const opponentAddr = opponentConn?.address || game.playerWhite?.address || "";
      const opponentName = await getDisplayName(opponentAddr);
      send(ws, {
        type: "game_joined",
        game_id: msg.game_id,
        color: result.color,
        opponent: opponentAddr,
        opponent_name: opponentName,
      });

      // Notify both players game is starting
      if (game.playerWhite && game.playerBlack) {
        // Create match if pending from create_game
        if (game.pendingMatchLength && game.pendingMatchLength > 1) {
          matchManager.createMatch(
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
          white: game.playerWhite.address,
          black: game.playerBlack.address,
          white_name: wN,
          black_name: bN,
          game_state: game.gameState,
          ...(match ? { match_state: match.matchState } : {}),
          turn_time_limit: game.turnTimeLimit,
        };
        gameManager.broadcastToGame(game, startMsg);
      }
      break;
    }

    case "join_queue": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const matchLength = (msg as { match_length?: number }).match_length ?? 1;
      const result = matchmaker.addToQueue({
        address: conn.address,
        ws,
        rating: conn.rating,
        wagerAmount: msg.wager_amount,
        matchLength,
        joinedAt: Date.now(),
      });

      if (result.matched && result.gameId) {
        const game = gameManager.getGame(result.gameId)!;

        // Create a match if matchLength > 1
        const ml = result.matchLength ?? matchLength;
        if (ml > 1) {
          matchManager.createMatch(
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
          white: game.playerWhite!.address,
          black: game.playerBlack!.address,
          white_name: wN,
          black_name: bN,
          game_state: game.gameState,
          ...(match ? { match_state: match.matchState } : {}),
          turn_time_limit: game.turnTimeLimit,
        };
        gameManager.broadcastToGame(game, startMsg);
      } else {
        send(ws, { type: "queue_joined", position: matchmaker.getQueuePosition(conn.address) });
      }
      break;
    }

    case "leave_queue": {
      const conn = connections.get(ws);
      if (!conn) return;
      matchmaker.removeFromQueue(conn.address);
      send(ws, { type: "queue_left" });
      break;
    }

    case "rejoin_game": {
      // Client sends this after receiving game_start to register its game WebSocket.
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      const game = gameManager.getGame(msg.game_id);
      if (!game || game.status !== "playing") break;
      const color = gameManager.getPlayerColor(game, conn.address);
      if (!color) break;
      const player: PlayerConnection = {
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      };
      gameManager.handleReconnect(msg.game_id, player);
      // Cancel disconnect grace period if active
      if (game.disconnectedPlayer === conn.address) {
        gameManager.cancelDisconnectGracePeriod(game);
      }
      // Notify opponent
      const opponent = color === "white" ? game.playerBlack : game.playerWhite;
      if (opponent) {
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

      const result = await gameManager.rollDiceLocked(msg.game_id, conn.address);
      if (!result) { send(ws, { type: "error", message: "Cannot roll dice", code: "CANNOT_ROLL" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      const playerColor = gameManager.getPlayerColor(game, conn.address)!;

      // Always send dice roll — never auto-end. Player must confirm.
      {
        const currentPlayer = playerColor === "white" ? game.playerWhite : game.playerBlack;
        const opponentPlayer = playerColor === "white" ? game.playerBlack : game.playerWhite;

        gameManager.sendToPlayer(currentPlayer, {
          type: "dice_rolled",
          game_id: msg.game_id,
          dice: result.dice,
          player: playerColor,
          game_state: result.gameState,
          legal_moves: result.legalMoves,
          needs_confirmation: result.legalMoves.length === 0,
          drand_proof: result.drandProof,
        });
        gameManager.sendToPlayer(opponentPlayer, {
          type: "dice_rolled",
          game_id: msg.game_id,
          dice: result.dice,
          player: playerColor,
          game_state: result.gameState,
          legal_moves: [],
          drand_proof: result.drandProof,
        });
        for (const spec of game.spectators) {
          gameManager.sendToPlayer(spec, {
            type: "dice_rolled",
            game_id: msg.game_id,
            dice: result.dice,
            player: playerColor,
            game_state: result.gameState,
            legal_moves: [],
            drand_proof: result.drandProof,
          });
        }
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

      const result = await gameManager.applyMoveLocked(msg.game_id, conn.address, from, to);
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
          move: result.move,
          player: result.playerColor,
          game_state: result.gameState,
          legal_moves: [],
          needs_confirmation: true,
        });
        gameManager.sendToPlayer(opponentPlayer, {
          type: "move_made",
          game_id: msg.game_id,
          move: result.move,
          player: result.playerColor,
          game_state: result.gameState,
          legal_moves: [],
        });
        for (const spec of game.spectators) {
          gameManager.sendToPlayer(spec, {
            type: "move_made",
            game_id: msg.game_id,
            move: result.move,
            player: result.playerColor,
            game_state: result.gameState,
            legal_moves: [],
          });
        }
        // DON'T broadcast turn_ended — wait for explicit end_turn
      } else {
        gameManager.broadcastToGame(game, {
          type: "move_made",
          game_id: msg.game_id,
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

      const result = await gameManager.handleEndTurnLocked(msg.game_id, conn.address);
      if (!result) { send(ws, { type: "error", message: "Cannot end turn", code: "CANNOT_END_TURN" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, {
        type: "turn_ended",
        game_id: msg.game_id,
        next_player: result.currentPlayer,
        game_state: result,
      });
      break;
    }

    case "undo_move": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = await gameManager.handleUndoLocked(msg.game_id, conn.address);
      if (!result) { send(ws, { type: "error", message: "Cannot undo", code: "CANNOT_UNDO" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, {
        type: "move_undone",
        game_id: msg.game_id,
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
      const result = gameManager.handleResignationTyped(msg.game_id, conn.address, resignType);
      if (!result) { send(ws, { type: "error", message: "Cannot resign", code: "CANNOT_RESIGN" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      if (result.offered) {
        // Gammon/backgammon resignation offered — opponent must accept/reject
        const playerColor = gameManager.getPlayerColor(game, conn.address)!;
        gameManager.broadcastToGame(game, {
          type: "resign_offered",
          game_id: msg.game_id,
          player: playerColor,
          resign_type: resignType,
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

      const result = gameManager.handleAcceptResignation(msg.game_id, conn.address);
      if (!result) { send(ws, { type: "error", message: "Cannot accept resignation" }); return; }

      logger.info("Game over", { gameId: msg.game_id, winner: result.winner, reason: "resignation accepted" });
      await handleGameOver(msg.game_id, result.winner, result.resultType);
      break;
    }

    case "reject_resign": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const rejected = gameManager.handleRejectResignation(msg.game_id, conn.address);
      if (!rejected) { send(ws, { type: "error", message: "Cannot reject resignation" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, { type: "resign_rejected", game_id: msg.game_id });
      break;
    }

    case "offer_double": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const result = gameManager.handleOfferDouble(msg.game_id, conn.address);
      if (!result) { send(ws, { type: "error", message: "Cannot double", code: "CANNOT_DOUBLE" }); return; }

      const game = gameManager.getGame(msg.game_id)!;
      gameManager.broadcastToGame(game, {
        type: "double_offered",
        game_id: msg.game_id,
        player: result.player,
        cube_value: result.cubeValue,
      });
      break;
    }

    case "accept_double": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found" }); return; }

      if (game.wagerAmount > 0) {
        // Wagered game: initiate escrow deposit flow
        const result = await gameManager.handleAcceptDoubleWagered(msg.game_id, conn.address);
        if (!result) { send(ws, { type: "error", message: "Cannot accept double", code: "CANNOT_ACCEPT" }); return; }

        // Tell both players to deposit additional funds
        gameManager.broadcastToGame(game, {
          type: "double_awaiting_deposits",
          game_id: msg.game_id,
          new_cube_value: result.cubeValue,
          additional_deposit: result.additionalDeposit,
          doubler: result.doubler,
          responder: result.responder,
        });

        // Start 120s deposit timeout
        gameManager.startDoubleDepositTimer(game, (gId) => {
          const g = gameManager.getGame(gId);
          if (g) {
            gameManager.broadcastToGame(g, {
              type: "double_deposit_timeout",
              game_id: gId,
              message: "Double deposit timed out. Reverting to pre-double state.",
            });
            void gameManager.handleDoubleDepositTimeout(gId);
          }
        });
      } else {
        // Free game: immediate accept, no escrow
        const result = gameManager.handleAcceptDoubleFree(msg.game_id, conn.address);
        if (!result) { send(ws, { type: "error", message: "Cannot accept double", code: "CANNOT_ACCEPT" }); return; }

        gameManager.broadcastToGame(game, {
          type: "double_accepted",
          game_id: msg.game_id,
          cube_value: result.cubeValue,
          cube_owner: result.cubeOwner,
        });
      }
      break;
    }

    case "reject_double": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      gameManager.updatePlayerWs(msg.game_id, conn.address, ws);

      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found" }); return; }

      let result: { winner: Player } | null;
      if (game.wagerAmount > 0) {
        // Wagered game: settle escrow to doubler
        result = await gameManager.handleRejectDoubleWagered(msg.game_id, conn.address);
      } else {
        result = gameManager.handleRejectDouble(msg.game_id, conn.address);
      }

      if (!result) { send(ws, { type: "error", message: "Cannot reject double", code: "CANNOT_REJECT" }); return; }

      gameManager.broadcastToGame(game, {
        type: "double_rejected",
        game_id: msg.game_id,
        winner: result.winner,
      });
      // Score in match context (double rejection = normal win at current cube value)
      await handleGameOver(msg.game_id, result.winner, "normal");
      break;
    }

    case "double_deposit_confirmed": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const game = gameManager.getGame(msg.game_id);
      if (!game || !game.pendingDoubleDeposit) {
        send(ws, { type: "error", message: "No pending double deposit" });
        return;
      }

      // Verify deposit on-chain
      const depositResult = await gameManager.verifyDoubleDeposit(msg.game_id, conn.address);
      if (!depositResult) {
        send(ws, { type: "error", message: "Failed to verify deposit" });
        return;
      }

      if (depositResult.playerDeposited) {
        // Notify both players about deposit progress
        gameManager.broadcastToGame(game, {
          type: "double_deposit_received",
          game_id: msg.game_id,
          player: conn.address,
          deposits_complete: depositResult.depositsComplete,
        });
      }

      if (depositResult.depositsComplete) {
        // Both deposited — game resumes with new cube value
        const playerColor = gameManager.getPlayerColor(game, game.pendingDoubleDeposit?.responder || conn.address);
        gameManager.broadcastToGame(game, {
          type: "double_deposits_complete",
          game_id: msg.game_id,
          new_cube_value: game.gameState.cubeValue,
          cube_owner: playerColor || "white",
        });
      }
      break;
    }

    case "submit_client_seed" as string: {
      // Deprecated: drand-based dice no longer needs client seeds
      break;
    }

    case "spectate": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }

      const game = gameManager.getGame(msg.game_id);
      if (!game) { send(ws, { type: "error", message: "Game not found" }); return; }

      game.spectators.push({
        ws,
        address: conn.address,
        rating: conn.rating,
        connectedAt: Date.now(),
      });

      send(ws, {
        type: "spectate_joined",
        game_id: msg.game_id,
        game_state: game.gameState,
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
    case "decline_challenge": {
      const conn = connections.get(ws);
      if (!conn) { send(ws, { type: "error", message: "Not authenticated" }); return; }
      socialManager.handle(ws, conn.address, msg);
      break;
    }
  }
}

// Periodically clean up stale online players whose heartbeat keys have expired
setInterval(async () => {
  try {
    await socialStore.cleanupStaleOnlinePlayers();
  } catch { /* ignore */ }
}, ONLINE_CLEANUP_INTERVAL_MS); // Every minute

server.listen(PORT, () => {
  logger.info("Server started", { port: PORT, ws: `/ws`, health: `/health` });

  gameManager.restoreGames().then((count) => {
    if (count > 0) console.log(`Restored ${count} active games from Redis`);
  });

  // Start Gammon token redemption service (NFT burn → token mint)
  import("./gammon-redemption.js").then(({ startRedemptionService }) => {
    startRedemptionService();
  }).catch((err) => {
    logger.warn("Gammon redemption service not started", { error: String(err) });
  });
});
