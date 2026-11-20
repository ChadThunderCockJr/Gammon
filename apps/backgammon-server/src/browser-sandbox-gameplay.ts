import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getLegalFirstMoves, type Player, type ResultType } from "@xion-beginner/backgammon-core";
import { getCashQuote, quoteForGame, requestCashSettlement } from "./cash-game-store.js";
import { GameManager } from "./game-manager.js";
import { parseClientMessage } from "./message-schema.js";
import { sessionFromRequest, type AuthenticatedRequest, type SessionRecord } from "./session.js";
import type { ClientMessage, PlayerConnection, ServerGame, ServerMessage } from "./types.js";
import { sendWebSocketJson } from "./ws-send.js";
import { SocialManager } from "./social-manager.js";

const SANDBOX_ORIGIN = "http://127.0.0.1:3421";

type MutationCommand = {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly commandType: string;
};

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

function mutationCommand(message: { type: string; command_id?: string; expected_revision?: number }): MutationCommand | undefined {
  return message.command_id && message.expected_revision !== undefined
    ? { commandId: message.command_id, expectedRevision: message.expected_revision, commandType: message.type }
    : undefined;
}

function send(ws: WebSocket, message: ServerMessage): void {
  sendWebSocketJson(ws, message);
}

function gameDecisionFields(gameManager: GameManager, game: ServerGame) {
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

function sendGameSnapshot(ws: WebSocket, principal: string, gameManager: GameManager, game: ServerGame): void {
  const color = gameManager.getPlayerColor(game, principal);
  if (!color || game.status !== "playing") return;
  const canSeeLegalMoves = game.gameState.currentPlayer === color
    && game.gameState.dice !== null
    && game.gameState.movesRemaining.length > 0;
  send(ws, {
    type: "game_start",
    game_id: game.id,
    revision: game.revision,
    white: game.playerWhite?.address ?? "",
    black: game.playerBlack?.address ?? "",
    white_name: game.playerWhite?.address ?? "",
    black_name: game.playerBlack?.address ?? "",
    game_state: game.gameState,
    legal_moves: canSeeLegalMoves
      ? getLegalFirstMoves(game.gameState.board, color, game.gameState.movesRemaining)
      : [],
    turn_time_limit: game.turnTimeLimit,
    needs_confirmation: game.pendingConfirmation === principal,
    ...gameDecisionFields(gameManager, game),
  });
}

async function settleAndBroadcast(gameManager: GameManager, gameId: string, winner: Player, resultType: ResultType): Promise<void> {
  const game = gameManager.getGame(gameId);
  if (!game) return;
  const quote = await quoteForGame(gameId);
  if (!quote) throw new Error("CASH_GAME_QUOTE_NOT_FOUND");
  const winnerAddress = winner === "white" ? game.playerWhite?.address : game.playerBlack?.address;
  if (!winnerAddress) throw new Error("CASH_GAME_WINNER_NOT_FOUND");
  const cubeValue = game.gameState.cubeValue ?? 1;
  if (cubeValue !== 1 && cubeValue !== 2 && cubeValue !== 4 && cubeValue !== 8) throw new Error("INVALID_CASH_CUBE");
  await requestCashSettlement({
    gameId,
    winner: winnerAddress,
    cubeValue,
    resultMultiplier: resultType === "normal" ? 1 : resultType === "gammon" ? 2 : 3,
    cubeWasTurned: cubeValue > 1,
  });
  gameManager.broadcastToGame(game, {
    type: "game_over",
    game_id: gameId,
    revision: game.revision,
    winner,
    result_type: resultType,
    game_state: game.gameState,
    settlement_pending: true,
  });
  gameManager.releaseTerminalGame(gameId);
}

function playerConnection(ws: WebSocket, principal: string): PlayerConnection {
  return { ws, address: principal, rating: 0, connectedAt: Date.now() };
}

/**
 * Attaches the local browser-sandbox cash-game protocol to an already-listening HTTP server.
 * It accepts only authenticated sessions from the local browser app and never enables gameplay
 * in production.
 */
export function attachBrowserSandboxGameplay(server: Server): void {
  if (process.env.GAMMON_BROWSER_FINANCE_SANDBOX !== "1" || process.env.NODE_ENV === "production") {
    throw new Error("Browser sandbox gameplay is disabled outside explicit non-production fixture mode");
  }

  const gameManager = new GameManager();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const sessions = new WeakMap<WebSocket, SessionRecord>();
  const connections = new Map<string, Set<WebSocket>>();
  const socialConnections = new Map<WebSocket, { address: string; rating: number }>();
  const social = new SocialManager(socialConnections, "browser-sandbox");

  gameManager.setTerminalHandler((gameId, winner, resultType) => settleAndBroadcast(gameManager, gameId, winner, resultType));

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      if (request.headers.origin !== SANDBOX_ORIGIN) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      let session: SessionRecord | null;
      try {
        session = await sessionFromRequest(request as unknown as AuthenticatedRequest);
      } catch {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      if (!session) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        sessions.set(ws, session!);
        wss.emit("connection", ws, request);
      });
    })().catch(() => {
      if (!socket.destroyed) rejectUpgrade(socket, 400, "Bad Request");
    });
  };

  server.on("upgrade", upgrade);
  server.once("close", () => {
    server.off("upgrade", upgrade);
    wss.close();
  });

  wss.on("connection", (ws: WebSocket) => {
    const session = sessions.get(ws);
    if (!session) {
      ws.close(1011, "Session unavailable");
      return;
    }
    const principal = session.principal;
    socialConnections.set(ws, { address: principal, rating: 1500 });
    void social.sendProfile(ws, principal).catch(() => ws.close(1011, "Profile unavailable"));
    const principalConnections = connections.get(principal) ?? new Set<WebSocket>();
    principalConnections.add(ws);
    connections.set(principal, principalConnections);

    const expiryTimer = setTimeout(() => {
      ws.close(1008, "Session expired");
    }, Math.max(0, session.expiresAt - Date.now()));

    let queue = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        send(ws, { type: "error", code: "INVALID_MESSAGE", message: "Binary messages are not accepted" });
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        send(ws, { type: "error", code: "INVALID_MESSAGE", message: "Invalid JSON" });
        return;
      }
      const message = parseClientMessage(raw);
      if (!message) {
        send(ws, { type: "error", code: "INVALID_MESSAGE", message: "Invalid message schema" });
        return;
      }
      queue = queue
        .then(() => message.type === "set_username" || message.type === "get_friends" || message.type === "get_activity"
          ? social.handle(ws, principal, message)
          : handleSandboxMessage(ws, principal, message, gameManager))
        .catch((error: unknown) => {
          const code = error instanceof Error ? error.message : "REQUEST_FAILED";
          const gameId = "game_id" in message ? message.game_id : null;
          if (code === "GAME_REVISION_CONFLICT" && gameId) {
            const game = gameManager.getGame(gameId);
            if (game) sendGameSnapshot(ws, principal, gameManager, game);
          }
          send(ws, {
            type: "error",
            code,
            message: code === "GAME_REVISION_CONFLICT"
              ? "The game changed before this command committed. The latest state is being restored."
              : "Request could not be processed",
          });
        });
    });

    ws.on("close", () => {
      socialConnections.delete(ws);
      clearTimeout(expiryTimer);
      principalConnections.delete(ws);
      if (principalConnections.size > 0) return;
      connections.delete(principal);
      const active = gameManager.handleDisconnect(principal);
      if (!active || active.game.status !== "playing" || active.game.gameState.gameOver) return;
      void gameManager.startDisconnectGracePeriod(active.game, principal, (gameId, winner, resultType) => {
        void settleAndBroadcast(gameManager, gameId, winner, resultType);
      }).catch(() => undefined);
    });

    void (async () => {
      const gameId = await gameManager.getAuthoritativePlayerGame(principal);
      if (!gameId) return;
      if (!await gameManager.handleReconnect(gameId, playerConnection(ws, principal))) return;
      const game = gameManager.getGame(gameId);
      if (game && game.status !== "waiting") sendGameSnapshot(ws, principal, gameManager, game);
    })().catch(() => ws.close(1011, "Game recovery unavailable"));
  });
}

async function handleSandboxMessage(
  ws: WebSocket,
  principal: string,
  message: ClientMessage,
  gameManager: GameManager,
): Promise<void> {
  switch (message.type) {
    case "join_cash_game": {
      const quote = await getCashQuote(principal, message.quote_id);
      if (!quote || quote.state !== "active") {
        send(ws, { type: "error", code: "CASH_GAME_NOT_ACTIVE", message: "Cash game is not funded" });
        return;
      }
      const result = await gameManager.joinCashGame(quote.gameId, playerConnection(ws, principal), quote.id);
      if (!result) {
        send(ws, { type: "error", code: "CANNOT_JOIN", message: "Cannot join cash game" });
        return;
      }
      const game = gameManager.getGame(quote.gameId);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      if (game.status !== "playing" || !game.playerWhite || !game.playerBlack) {
        send(ws, { type: "game_created", game_id: game.id, revision: game.revision, color: result.color });
        return;
      }
      const opponent = result.color === "white" ? game.playerBlack : game.playerWhite;
      send(ws, {
        type: "game_joined",
        game_id: game.id,
        revision: game.revision,
        color: result.color,
        opponent: opponent?.address ?? "",
        opponent_name: opponent?.address ?? "",
      });
      for (const player of [game.playerWhite, game.playerBlack]) sendGameSnapshot(player.ws, player.address, gameManager, game);
      return;
    }

    case "rejoin_game": {
      if (!await gameManager.handleReconnect(message.game_id, playerConnection(ws, principal))) {
        send(ws, { type: "error", code: "GAME_RECONNECT_REQUIRED", message: "Reconnect through the current game session." });
        return;
      }
      const game = gameManager.getGame(message.game_id);
      if (game) sendGameSnapshot(ws, principal, gameManager, game);
      return;
    }

    case "roll_dice": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.rollDiceLocked(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_ROLL", message: "Cannot roll dice" });
      const game = gameManager.getGame(message.game_id);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      const current = result.player === "white" ? game.playerWhite : game.playerBlack;
      const opponent = result.player === "white" ? game.playerBlack : game.playerWhite;
      gameManager.sendToPlayer(current, {
        type: "dice_rolled", game_id: game.id, revision: game.revision, dice: result.dice, player: result.player,
        game_state: result.gameState, legal_moves: result.legalMoves, needs_confirmation: result.legalMoves.length === 0,
        drand_proof: result.drandProof, drand_failed: result.drandFailed,
      });
      gameManager.sendToPlayer(opponent, {
        type: "dice_rolled", game_id: game.id, revision: game.revision, dice: result.dice, player: result.player,
        game_state: result.gameState, legal_moves: [], drand_proof: result.drandProof, drand_failed: result.drandFailed,
      });
      return;
    }

    case "move": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.applyMoveLocked(message.game_id, principal, message.from, message.to, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "INVALID_MOVE", message: "Invalid move" });
      const game = gameManager.getGame(message.game_id);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      if (result.turnAutoEnded) {
        const player = result.playerColor === "white" ? game.playerWhite : game.playerBlack;
        const opponent = result.playerColor === "white" ? game.playerBlack : game.playerWhite;
        gameManager.sendToPlayer(player, {
          type: "move_made", game_id: game.id, revision: game.revision, move: result.move, player: result.playerColor,
          game_state: result.gameState, legal_moves: [], needs_confirmation: true,
        });
        gameManager.sendToPlayer(opponent, {
          type: "move_made", game_id: game.id, revision: game.revision, move: result.move, player: result.playerColor,
          game_state: result.gameState, legal_moves: [],
        });
      } else {
        gameManager.broadcastToGame(game, {
          type: "move_made", game_id: game.id, revision: game.revision, move: result.move, player: result.playerColor,
          game_state: result.gameState, legal_moves: result.legalMoves,
        });
      }
      if (result.gameState.gameOver) await settleAndBroadcast(gameManager, game.id, result.gameState.winner!, result.gameState.resultType!);
      return;
    }

    case "end_turn": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleEndTurnLocked(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_END_TURN", message: "Cannot end turn" });
      const game = gameManager.getGame(message.game_id);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      gameManager.broadcastToGame(game, {
        type: "turn_ended", game_id: game.id, revision: game.revision, next_player: result.currentPlayer, game_state: result,
      });
      return;
    }

    case "undo_move": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleUndoLocked(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_UNDO", message: "Cannot undo" });
      const game = gameManager.getGame(message.game_id);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      gameManager.broadcastToGame(game, {
        type: "move_undone", game_id: game.id, revision: game.revision, game_state: result.gameState, legal_moves: result.legalMoves,
      });
      return;
    }

    case "resign": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleResignationTyped(message.game_id, principal, message.resign_type ?? "normal", mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_RESIGN", message: "Cannot resign" });
      const game = gameManager.getGame(message.game_id);
      if (!game) throw new Error("CASH_GAME_NOT_FOUND");
      if (result.offered) {
        const player = gameManager.getPlayerColor(game, principal);
        if (!player || !result.deadlineAt || !result.offerRevision) throw new Error("INVALID_RESIGNATION_OFFER");
        gameManager.broadcastToGame(game, {
          type: "resign_offered", game_id: game.id, revision: game.revision, player, resign_type: message.resign_type ?? "normal",
          deadline_at: new Date(result.deadlineAt).toISOString(), offer_revision: result.offerRevision,
        });
      } else {
        await settleAndBroadcast(gameManager, game.id, result.winner!, "normal");
      }
      return;
    }

    case "accept_resign": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleAcceptResignation(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_ACCEPT", message: "Cannot accept resignation" });
      await settleAndBroadcast(gameManager, message.game_id, result.winner, result.resultType);
      return;
    }

    case "reject_resign": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      if (!await gameManager.handleRejectResignation(message.game_id, principal, mutationCommand(message))) {
        return send(ws, { type: "error", code: "CANNOT_REJECT", message: "Cannot reject resignation" });
      }
      const game = gameManager.getGame(message.game_id);
      if (game) gameManager.broadcastToGame(game, { type: "resign_rejected", game_id: game.id, revision: game.revision });
      return;
    }

    case "offer_double": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleOfferDouble(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_DOUBLE", message: "Cannot double" });
      const game = gameManager.getGame(message.game_id);
      if (game) gameManager.broadcastToGame(game, {
        type: "double_offered", game_id: game.id, revision: game.revision, player: result.player, cube_value: result.cubeValue,
        deadline_at: new Date(result.deadlineAt).toISOString(), offer_revision: result.offerRevision,
      });
      return;
    }

    case "accept_double": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleAcceptDoubleFree(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_ACCEPT", message: "Cannot accept double" });
      const game = gameManager.getGame(message.game_id);
      if (game) gameManager.broadcastToGame(game, {
        type: "double_accepted", game_id: game.id, revision: game.revision, cube_value: result.cubeValue, cube_owner: result.cubeOwner,
      });
      return;
    }

    case "reject_double": {
      gameManager.updatePlayerWs(message.game_id, principal, ws);
      const result = await gameManager.handleRejectDouble(message.game_id, principal, mutationCommand(message));
      if (!result) return send(ws, { type: "error", code: "CANNOT_REJECT", message: "Cannot reject double" });
      await settleAndBroadcast(gameManager, message.game_id, result.winner, "normal");
      return;
    }

    case "request_cash_review": {
      if (!await gameManager.requestCashReview(message.game_id, principal, mutationCommand(message)!)) {
        send(ws, { type: "error", code: "CANNOT_REVIEW", message: "Cash review is unavailable" });
      }
      return;
    }

    case "reaction": {
      const game = gameManager.getGame(message.game_id);
      if (!game || !gameManager.getPlayerColor(game, principal)) {
        send(ws, { type: "error", code: "CANNOT_REACT", message: "Only players can react" });
        return;
      }
      gameManager.broadcastToGame(game, { type: "reaction", game_id: game.id, emoji: message.emoji, from: principal });
      return;
    }

    default:
      send(ws, { type: "error", code: "UNSUPPORTED_MESSAGE", message: "This sandbox WebSocket accepts funded cash-game commands only" });
  }
}
