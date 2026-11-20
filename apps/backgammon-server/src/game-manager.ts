import { randomInt, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { GameDiceHistory, createDiceProof, diceCommitmentContext, type DrandDiceProof } from "./dice.js";
import { DRAND_CHAIN_HASH, fetchFutureBeacon, latestBeacon } from "./drand.js";
import { persistFutureRoundCommitment, revealCommittedDice } from "./dice-commitment-store.js";
import { DEFAULT_TURN_TIME_LIMIT_SEC, STALLING_MIN_MOVES, STALLING_THRESHOLD_PCTG, DISCONNECT_GRACE_SEC, DISCONNECT_CHECK_INTERVAL_MS } from "./config.js";
import { logger } from "./logger.js";
import {
  CASH_GAME_RULES_V1,
  createGameState,
  getLegalFirstMoves,
  hasLegalMoves,
  canDouble,
  acceptDouble,
  rejectDouble,
  endTurn,
  makeMove,
  parseCashGameRules,
  serializeCashGameRules,
  setDice,
  setOpeningRoll,
  type CashGameRules,
  type GameState,
  type Player,
  type Move,
  type ResultType,
} from "@xion-beginner/backgammon-core";
import {
  commitGameCommand,
  expireOrphanWaitingGames,
  loadActiveGames,
  loadCurrentGameForParticipant,
  loadGame,
  loadGameForParticipant,
  persistDiceRoll as persistDiceRollRecord,
  persistGame as persistGameRecord,
  persistMove as persistMoveRecord,
  renewGameOwnership,
  reserveWaitingGame,
  finishGame as finishGameRecord,
  replayGameCommand,
  type GameCommand,
  type PersistedGameServerState,
} from "./game-store.js";

import { getRedis } from "./redis.js";
import { getPool } from "./db.js";
import type { GameReviewReason, ServerGame, PlayerConnection, ServerMessage } from "./types.js";
import { sendWebSocketData } from "./ws-send.js";
import {
  cashGameJoinGate,
  cashGamePlayGate,
  captureCashGameReviewSnapshot,
  cashGameRecoveryState,
  quoteForGame,
  startCashGameSession,
} from "./cash-game-store.js";
type MutationCommand = {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly commandType: string;
};

interface CashGameSnapshot {
  revision: number;
  phase: ServerGame["phase"];
  deadlineAt: number | null;
  gameState: GameState;
  playerWhite: PlayerConnection | null;
  playerBlack: PlayerConnection | null;
  wagerAmount: number;
  status: ServerGame["status"];
  turnTimeLimit: number;
  doublingAllowed: boolean;
  turnMoveStack: GameState[];
  pendingConfirmation: string | null;
  disconnectedPlayer: string | null;
  disconnectedAt: number | null;
  escrowStatus: ServerGame["escrowStatus"];
  pendingResignation: ServerGame["pendingResignation"];
  moveTimes: number[];
  stallingWarned: boolean;
  pendingMatchLength: number | undefined;
  cashQuoteId: string | undefined;
  reviewReason: GameReviewReason | undefined;
  pendingDoubleOffer: ServerGame["pendingDoubleOffer"];
  cashRules: CashGameRules | undefined;
}
export const GAME_RUNTIME_INSTANCE_ID = process.env.FLY_MACHINE_ID || randomUUID();

class CanonicalGameReloadedError extends Error {
  constructor() {
    super("GAME_REVISION_CONFLICT");
    this.name = "CanonicalGameReloadedError";
  }
}

function cashReviewDeadline(): Date {
  const configured = Number(process.env.CASH_GAME_REVIEW_TIMEOUT_SECONDS);
  const seconds = Number.isSafeInteger(configured) && configured >= 3_600 && configured <= 30 * 86_400
    ? configured
    : 7 * 86_400;
  return new Date(Date.now() + seconds * 1_000);
}
const CASH_GAME_LEASE_SECONDS = 30;
const CASH_GAME_LEASE_RENEWAL_MS = 10_000;


function isHydratableParticipantGame(status: string, phase: string, escrowStatus: string): boolean {
  return ["waiting", "depositing", "playing"].includes(status)
    || (status === "abandoned" && phase === "review" && escrowStatus === "active");
}


const WAITING_GAME_EXPIRY_MS = 15 * 60 * 1_000;

export class GameManager {
  private games = new Map<string, ServerGame>();
  private playerGames = new Map<string, string>(); // address -> gameId
  private diceHistories = new Map<string, GameDiceHistory>();
  private readonly instanceId = GAME_RUNTIME_INSTANCE_ID;
  private gameLocks = new Map<string, Promise<void>>();
  private terminalHandler: ((gameId: string, winner: Player, resultType: ResultType) => Promise<void>) | null = null;

  setTerminalHandler(
    handler: (gameId: string, winner: Player, resultType: ResultType) => Promise<void>,
  ): void {
    this.terminalHandler = handler;
  }

  private async emitTerminalResult(
    game: ServerGame,
    winner: Player,
    resultType: ResultType,
  ): Promise<void> {
    if (this.terminalHandler) {
      await this.terminalHandler(game.id, winner, resultType);
      return;
    }
    this.broadcastToGame(game, {
      type: "game_over",
      game_id: game.id,
      winner,
      result_type: resultType,
      game_state: game.gameState,
      revision: game.revision,
    });
    this.releaseTerminalGame(game.id);
  }

  private async withGameLock<T>(gameId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.gameLocks.get(gameId) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    this.gameLocks.set(gameId, next);
    await prev;
    const game = this.games.get(gameId);
    const snapshot = game ? this.captureCashGame(game) : null;
    const playerGamesSnapshot = snapshot ? new Map(this.playerGames) : null;
    try {
      return await fn();
    } catch (error) {
      if (
        snapshot &&
        game &&
        this.games.get(gameId) === game &&
        !(error instanceof CanonicalGameReloadedError) &&
        !(error instanceof Error && error.message === "GAME_OWNERSHIP_LOST")
      ) {
        this.restoreCashGame(game, snapshot);
        this.playerGames = playerGamesSnapshot!;
      }
      throw error;
    } finally {
      resolve!();
      if (this.gameLocks.get(gameId) === next) this.gameLocks.delete(gameId);
    }
  }

  private captureCashGame(game: ServerGame): CashGameSnapshot {
    return {
      revision: game.revision,
      phase: game.phase,
      deadlineAt: game.deadlineAt,
      gameState: structuredClone(game.gameState),
      playerWhite: game.playerWhite,
      playerBlack: game.playerBlack,
      wagerAmount: game.wagerAmount,
      status: game.status,
      turnTimeLimit: game.turnTimeLimit,
      doublingAllowed: game.doublingAllowed,
      turnMoveStack: structuredClone(game.turnMoveStack),
      pendingConfirmation: game.pendingConfirmation,
      disconnectedPlayer: game.disconnectedPlayer,
      disconnectedAt: game.disconnectedAt,
      escrowStatus: game.escrowStatus,
      pendingResignation: structuredClone(game.pendingResignation),
      moveTimes: [...game.moveTimes],
      stallingWarned: game.stallingWarned,
      pendingMatchLength: game.pendingMatchLength,
      cashQuoteId: game.cashQuoteId,
      reviewReason: game.reviewReason,
      pendingDoubleOffer: structuredClone(game.pendingDoubleOffer),
      cashRules: game.cashRules,
    };
  }


  private cashRulesFor(game: ServerGame): CashGameRules {
    if (game.escrowStatus !== "active") return CASH_GAME_RULES_V1;
    if (!game.cashRules) throw new Error("CASH_RULES_SNAPSHOT_REQUIRED");
    return game.cashRules;
  }

  private async requireCashPlayGate(game: ServerGame, principal: string): Promise<void> {
    if (game.escrowStatus !== "active") return;
    const gate = await cashGamePlayGate(game.id, principal);
    if (!gate.allowed) throw new Error(gate.code ?? "CASH_GAME_PLAY_BLOCKED");
  }

  private async startCashSessionIfReady(game: ServerGame): Promise<void> {
    if (
      game.escrowStatus !== "active" ||
      game.status !== "playing" ||
      !game.playerWhite ||
      !game.playerBlack
    ) return;
    if (!(await startCashGameSession(game.id))) throw new Error("CASH_GAME_START_ACK_REQUIRED");
  }

  private async hydrateParticipantGame(gameId: string, principal: string): Promise<ServerGame | null> {
    const existing = this.games.get(gameId);
    if (existing) {
      return isHydratableParticipantGame(existing.status, existing.phase, existing.escrowStatus)
        && this.getPlayerColor(existing, principal)
        ? existing
        : null;
    }
    const stored = await loadGameForParticipant(gameId, principal);
    if (!stored || !isHydratableParticipantGame(stored.status, stored.phase, stored.escrowStatus)) return null;
    const state = stored.serverState;
    const cashRules = stored.escrowStatus === "active"
      ? parseCashGameRules(state.cashRules)
      : undefined;
    if (!(await renewGameOwnership(gameId, this.instanceId, CASH_GAME_LEASE_SECONDS))) {
      throw new Error("GAME_OWNERSHIP_LOST");
    }
    const game: ServerGame = {
      id: stored.id,
      revision: stored.revision,
      phase: stored.phase,
      deadlineAt: stored.deadlineAt?.getTime() ?? null,
      gameState: stored.gameState,
      wagerAmount: stored.wagerAmount,
      status: stored.status as ServerGame["status"],
      playerWhite: this.detachedPlayer(stored.playerWhite),
      playerBlack: this.detachedPlayer(stored.playerBlack),
      createdAt: stored.createdAt.getTime(),
      turnTimer: null,
      ownershipTimer: null,
      turnTimeLimit: cashRules?.turnTimeLimitSeconds ?? stored.turnTimeLimit,
      cashRules,
      doublingAllowed: state.doublingAllowed ?? true,
      turnMoveStack: state.turnMoveStack ?? [],
      pendingConfirmation: state.pendingConfirmation ?? null,
      disconnectTimer: null,
      disconnectedPlayer: state.disconnectedPlayer ?? null,
      disconnectedAt: state.disconnectedAt ?? null,
      escrowStatus: stored.escrowStatus as ServerGame["escrowStatus"],
      pendingResignation: state.pendingResignation ?? null,
      moveTimes: [],
      stallingWarned: false,
      pendingMatchLength: state.pendingMatchLength ?? undefined,
      cashQuoteId: state.cashQuoteId ?? undefined,
      reviewReason: state.reviewReason ?? undefined,
      pendingDoubleOffer: state.pendingDoubleOffer ?? null,
    };
    this.games.set(gameId, game);
    if (game.playerWhite) this.playerGames.set(game.playerWhite.address, gameId);
    if (game.playerBlack) this.playerGames.set(game.playerBlack.address, gameId);
    await this.startCashSessionIfReady(game);
    this.scheduleCashOwnershipRenewal(game);
    if (game.status === "waiting") {
      this.scheduleWaitingExpiry(game);
    } else if (game.status === "playing" && game.disconnectedPlayer && game.disconnectedAt !== null) {
      this.scheduleDisconnectGraceTimer(game, game.disconnectedPlayer, game.disconnectedAt);
    } else if (game.status === "playing" && game.deadlineAt !== null) {
      this.scheduleTurnTimer(game);
    }
    return game;
  }

  async hydrateGameForParticipant(gameId: string, principal: string): Promise<ServerGame | null> {
    return this.hydrateParticipantGame(gameId, principal);
  }

  private scheduleCashOwnershipRenewal(game: ServerGame): void {
    if (game.ownershipTimer) clearInterval(game.ownershipTimer);
    game.ownershipTimer = setInterval(() => {
      void renewGameOwnership(game.id, this.instanceId, CASH_GAME_LEASE_SECONDS).then(async (owned) => {
        if (!owned) {
          await this.reloadCanonicalCashGame(game, false);
          this.relinquishCashOwnership(game);
        }
      }).catch(() => this.relinquishCashOwnership(game));
    }, CASH_GAME_LEASE_RENEWAL_MS);
  }

  private relinquishCashOwnership(game: ServerGame): void {
    if (game.ownershipTimer) clearInterval(game.ownershipTimer);
    game.ownershipTimer = null;
    this.clearTurnTimer(game);
    this.cancelDisconnectGracePeriod(game);
  }

  private async ensureCashOwnership(game: ServerGame): Promise<void> {

    const owned = await renewGameOwnership(game.id, this.instanceId, CASH_GAME_LEASE_SECONDS);
    if (!owned) {
      await this.reloadCanonicalCashGame(game, false);
      this.relinquishCashOwnership(game);
      throw new Error("GAME_OWNERSHIP_LOST");
    }
    if (!game.ownershipTimer) this.scheduleCashOwnershipRenewal(game);
  }

  private async replayCashCommand<T>(
    gameId: string,
    principal: string,
    command: MutationCommand | undefined,
  ): Promise<T | undefined> {
    if (!command) throw new Error("GAME_COMMAND_REQUIRED");
    const replay = await replayGameCommand(gameId, {
      ...command,
      principal,
      commandType: command.commandType,
      eventType: command.commandType,
    });
    if (!replay) return undefined;
    const game = this.games.get(gameId);
    if (game && await this.reloadCanonicalCashGame(game)) throw new CanonicalGameReloadedError();
    throw new Error("GAME_REVISION_CONFLICT");
  }

  private async reloadCanonicalCashGame(game: ServerGame, scheduleTimer = true): Promise<boolean> {
    const stored = await loadGame(game.id);
    if (!stored) return false;
    if (!isHydratableParticipantGame(stored.status, stored.phase, stored.escrowStatus)) {
      this.detachGame(game);
      return false;
    }
    const state = stored.serverState;
    let cashRules: CashGameRules | undefined;
    if (stored.escrowStatus === "active") {
      try {
        cashRules = parseCashGameRules(state.cashRules);
      } catch {
        this.relinquishCashOwnership(game);
        return false;
      }
    }
    this.clearTurnTimer(game);
    Object.assign(game, {
      revision: stored.revision,
      phase: stored.phase,
      deadlineAt: stored.deadlineAt?.getTime() ?? null,
      gameState: stored.gameState,
      wagerAmount: stored.wagerAmount,
      status: stored.status,
      createdAt: stored.createdAt.getTime(),
      playerWhite: game.playerWhite?.address === stored.playerWhite ? game.playerWhite : this.detachedPlayer(stored.playerWhite),
      playerBlack: game.playerBlack?.address === stored.playerBlack ? game.playerBlack : this.detachedPlayer(stored.playerBlack),
      turnTimeLimit: cashRules?.turnTimeLimitSeconds ?? stored.turnTimeLimit,
      cashRules,
      doublingAllowed: state.doublingAllowed ?? true,
      turnMoveStack: state.turnMoveStack ?? [],
      pendingConfirmation: state.pendingConfirmation ?? null,
      disconnectedPlayer: state.disconnectedPlayer ?? null,
      disconnectedAt: state.disconnectedAt ?? null,
      escrowStatus: stored.escrowStatus,
      pendingResignation: state.pendingResignation ?? null,
      pendingMatchLength: state.pendingMatchLength ?? undefined,
      cashQuoteId: state.cashQuoteId ?? undefined,
      reviewReason: state.reviewReason ?? undefined,
      pendingDoubleOffer: state.pendingDoubleOffer ?? null,
    });
    if (scheduleTimer && game.status === "waiting") {
      this.scheduleWaitingExpiry(game);
    } else if (scheduleTimer && game.status === "playing" && game.disconnectedPlayer && game.disconnectedAt !== null) {
      this.scheduleDisconnectGraceTimer(game, game.disconnectedPlayer, game.disconnectedAt);
    } else if (scheduleTimer && game.status === "playing" && game.deadlineAt !== null) {
      this.scheduleTurnTimer(game);
    }
    return true;
  }
  private restoreCashGame(game: ServerGame, snapshot: CashGameSnapshot): void {
    clearTimeout(game.turnTimer ?? undefined);
    Object.assign(game, snapshot, { turnTimer: null });
    if (game.status === "playing" && game.disconnectedPlayer && game.disconnectedAt !== null) {
      this.scheduleDisconnectGraceTimer(game, game.disconnectedPlayer, game.disconnectedAt);
    } else if (game.status === "playing" && game.deadlineAt !== null) {
      this.scheduleTurnTimer(game);
    }
  }
  private persistedServerState(game: ServerGame): PersistedGameServerState {
    return {
      turnMoveStack: game.turnMoveStack,
      pendingConfirmation: game.pendingConfirmation,
      pendingResignation: game.pendingResignation,
      pendingDoubleOffer: game.pendingDoubleOffer,
      disconnectedPlayer: game.disconnectedPlayer,
      disconnectedAt: game.disconnectedAt,
      pendingMatchLength: game.pendingMatchLength,
      doublingAllowed: game.doublingAllowed,
      cashQuoteId: game.cashQuoteId,
      reviewReason: game.reviewReason,
      cashRules: game.cashRules ? JSON.parse(serializeCashGameRules(game.cashRules)) as Record<string, unknown> : undefined,
    };
  }
  private systemCommand(game: ServerGame, commandType: string, identity: string | number): MutationCommand {
    return {
      commandId: `system:${game.id}:${commandType}:${identity}`,
      expectedRevision: game.revision,
      commandType,
    };
  }

  private detachedPlayer(address: string | null): PlayerConnection | null {
    if (!address) return null;
    return {
      address,
      rating: 0,
      connectedAt: 0,
      ws: { readyState: 3 } as WebSocket,
    };
  }

  private async commitMutation(
    game: ServerGame,
    principal: string,
    command: MutationCommand | undefined,
    eventType: string,
    eventPayload: Record<string, unknown>,
    result: unknown,
  ): Promise<unknown> {
    await this.ensureCashOwnership(game);
    if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
    const storedCommand: GameCommand = {
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
      principal,
      commandType: command.commandType,
      eventType,
    };
    try {
      const committed = await commitGameCommand({
        gameId: game.id,
        command: storedCommand,
        status: game.status,
        escrowStatus: game.escrowStatus,
        gameState: game.gameState,
        result,
        eventPayload,
        phase: game.phase,
        deadlineAt: game.deadlineAt === null ? null : new Date(game.deadlineAt),
        serverState: this.persistedServerState(game),
        ownerInstanceId: this.instanceId,
        cashReview: eventType === "cash_game_review" && typeof eventPayload.reason === "string"
          ? { reason: eventPayload.reason as GameReviewReason, deadlineAt: cashReviewDeadline() }
          : undefined,
      });
      game.revision = committed.revision;
      return committed.result;
    } catch (error) {
      if (error instanceof Error && error.message === "GAME_REVISION_CONFLICT") {
        if (await this.reloadCanonicalCashGame(game)) throw new CanonicalGameReloadedError();
      }
      if (error instanceof Error && error.message === "GAME_OWNERSHIP_LOST") {
        await this.reloadCanonicalCashGame(game, false);
        this.relinquishCashOwnership(game);
      }
      throw error;
    }
  }

  private async persistGame(game: ServerGame): Promise<boolean> {
    let durable = false;
    try {
      durable = await persistGameRecord(
        game.id,
        game.playerWhite?.address || null,
        game.playerBlack?.address || null,
        game.wagerAmount,
        game.status,
        game.escrowStatus,
        game.gameState,
        game.turnTimeLimit,
        game.revision,
        game.phase,
        game.deadlineAt === null ? null : new Date(game.deadlineAt),
        this.persistedServerState(game),
        this.instanceId,
      );
    } catch {
      durable = false;
    }
    if (!durable) return false;

    try {
      const redis = getRedis();
      if (redis) {
        const serializable = {
          id: game.id,
          revision: game.revision,
          phase: game.phase,
          deadlineAt: game.deadlineAt,
          gameState: game.gameState,
          wagerAmount: game.wagerAmount,
          status: game.status,
          escrowStatus: game.escrowStatus,
          playerWhiteAddress: game.playerWhite?.address || null,
          playerBlackAddress: game.playerBlack?.address || null,
          ...this.persistedServerState(game),
          moveHistory: game.gameState.moveHistory || [],
          turnTimeLimit: game.turnTimeLimit,
        };
        await redis.set(`active_game:${game.id}`, JSON.stringify(serializable), "EX", 7200);
      }
    } catch {
      // Redis is a disposable cache; PostgreSQL durability is authoritative.
    }
    return durable;
  }

  /** Persist a dice roll to PostgreSQL for the audit trail */
  async persistDiceRoll(
    gameId: string,
    turnNumber: number,
    player: string,
    die1: number,
    die2: number,
    drandProof?: { round: number; randomness: string; signature: string },
    drandFailed?: boolean,
  ): Promise<void> {
    await persistDiceRollRecord(gameId, turnNumber, player, die1, die2, drandProof, drandFailed);
  }

  /** Persist a move to PostgreSQL for replay/audit */
  async persistMoveRecord(
    gameId: string,
    turnNumber: number,
    player: string,
    from: number,
    to: number,
    gameStateAfter: GameState,
  ): Promise<void> {
    await persistMoveRecord(gameId, turnNumber, player, from, to, gameStateAfter);
  }

  private async deletePersistedGame(gameId: string): Promise<void> {
    const game = this.games.get(gameId);
    if (!(await finishGameRecord(gameId, game?.status || "finished", game?.escrowStatus || "none"))) {
      throw new Error("GAME_TERMINATION_PERSISTENCE_FAILED");
    }
    try {
      const redis = getRedis();
      if (redis) await redis.del(`active_game:${gameId}`);
    } catch {
      // Redis is a disposable cache; PostgreSQL durability is authoritative.
    }
  }
  async restoreGames(): Promise<number> {
    await expireOrphanWaitingGames();
    const activeGames = await loadActiveGames();
    let restored = 0;
    for (const data of activeGames) {
      const state = data.serverState;
      let cashRules: CashGameRules | undefined;
      if (data.escrowStatus === "active") cashRules = parseCashGameRules(state.cashRules);
      if (!(await renewGameOwnership(data.id, this.instanceId, CASH_GAME_LEASE_SECONDS))) continue;
      const game: ServerGame = {
        id: data.id,
        revision: data.revision,
        phase: data.phase,
        deadlineAt: data.deadlineAt?.getTime() ?? null,
        gameState: data.gameState,
        wagerAmount: data.wagerAmount,
        status: data.status as ServerGame["status"],
        playerWhite: this.detachedPlayer(data.playerWhite),
        playerBlack: this.detachedPlayer(data.playerBlack),
        createdAt: data.createdAt.getTime(),
        turnTimer: null,
        ownershipTimer: null,
        turnTimeLimit: cashRules?.turnTimeLimitSeconds ?? data.turnTimeLimit,
        cashRules,
        doublingAllowed: state.doublingAllowed ?? true,
        turnMoveStack: state.turnMoveStack ?? [],
        pendingConfirmation: state.pendingConfirmation ?? null,
        disconnectTimer: null,
        disconnectedPlayer: state.disconnectedPlayer ?? null,
        disconnectedAt: state.disconnectedAt ?? null,
        escrowStatus: data.escrowStatus as ServerGame["escrowStatus"],
        pendingResignation: state.pendingResignation ?? null,
        moveTimes: [],
        stallingWarned: false,
        pendingMatchLength: state.pendingMatchLength ?? undefined,
        cashQuoteId: state.cashQuoteId ?? undefined,
        reviewReason: state.reviewReason ?? undefined,
        pendingDoubleOffer: state.pendingDoubleOffer ?? null,
      };
      this.games.set(game.id, game);
      await this.startCashSessionIfReady(game);
      this.scheduleCashOwnershipRenewal(game);
      if (game.status === "waiting") {
        this.scheduleWaitingExpiry(game);
      } else if (game.status === "playing" && game.disconnectedPlayer && game.disconnectedAt !== null) {
        this.scheduleDisconnectGraceTimer(game, game.disconnectedPlayer, game.disconnectedAt);
      } else if (game.status === "playing" && game.deadlineAt !== null) {
        this.scheduleTurnTimer(game);
      }
      restored++;
    }
    if (activeGames.length > 0) logger.info(`Restored ${restored} games from PostgreSQL`);
    return restored;
  }

  private generateGameId(): string {
    return randomUUID();
  }

  createGame(
    wagerAmount: number,
    turnTimeLimit: number = DEFAULT_TURN_TIME_LIMIT_SEC,
    doublingAllowed = true,
  ): ServerGame {
    const id = this.generateGameId();
    const game: ServerGame = {
      id,
      revision: 0,
      phase: "waiting",
      deadlineAt: null,
      gameState: createGameState(),
      playerWhite: null,
      playerBlack: null,
      wagerAmount,
      status: "waiting",
      createdAt: Date.now(),
      turnTimer: null,
      ownershipTimer: null,
      turnTimeLimit,
      doublingAllowed,
      turnMoveStack: [],
      pendingConfirmation: null,
      disconnectTimer: null,
      disconnectedPlayer: null,
      disconnectedAt: null,
      escrowStatus: "none",
      pendingResignation: null,
      moveTimes: [],
      stallingWarned: false,
      pendingDoubleOffer: null,
    };
    this.diceHistories.set(id, new GameDiceHistory());
    this.games.set(id, game);
    return game;
  }
  createGameWithId(id: string, turnTimeLimit: number = DEFAULT_TURN_TIME_LIMIT_SEC): ServerGame {
    const existing = this.games.get(id);
    if (existing) return existing;
    const game = this.createGame(0, turnTimeLimit);
    this.games.delete(game.id);
    this.diceHistories.delete(game.id);
    game.id = id;
    this.games.set(id, game);
    this.diceHistories.set(id, new GameDiceHistory());
    return game;
  }

  private assignPlayer(game: ServerGame, player: PlayerConnection, deferStart = false): { color: Player } | null {
    if (!["waiting", "depositing", "playing"].includes(game.status)) return null;
    if (game.playerWhite?.address === player.address) {
      game.playerWhite = player;
      return { color: "white" };
    }
    if (game.playerBlack?.address === player.address) {
      game.playerBlack = player;
      if (!deferStart && game.status === "waiting" && game.playerWhite) {
        game.status = "playing";
        game.phase = "await_roll";
        this.startTurnTimer(game);
      }
      return { color: "black" };
    }
    if (!game.playerWhite) {
      game.playerWhite = player;
      game.phase = "waiting";
      game.deadlineAt = null;
      this.playerGames.set(player.address, game.id);
      return { color: "white" };
    }
    if (!game.playerBlack) {
      game.playerBlack = player;
      this.playerGames.set(player.address, game.id);
      if (!deferStart) {
        game.status = "playing";
        game.phase = "await_roll";
        this.startTurnTimer(game);
      }
      return { color: "black" };
    }
    return null;
  }

  private async restoreResumedCashGame(game: ServerGame): Promise<void> {
    if (game.escrowStatus !== "active" || game.status !== "abandoned" || game.phase !== "review") return;
    if ((await quoteForGame(game.id))?.state !== "active") return;
    await this.ensureCashOwnership(game);
    const recovery = await cashGameRecoveryState(game.id);
    if (!recovery) throw new Error("CASH_GAME_RECOVERY_STATE_REQUIRED");
    if (!["waiting", "await_roll", "playing_moves", "await_confirmation", "double_offer", "resignation_offer"].includes(recovery.phase)) {
      throw new Error("CASH_GAME_RECOVERY_STATE_INVALID");
    }
    const deadlineAt = recovery.deadlineAt === null ? null : Date.parse(recovery.deadlineAt);
    if (deadlineAt !== null && !Number.isFinite(deadlineAt)) throw new Error("CASH_GAME_RECOVERY_STATE_INVALID");
    const expectedRevision = game.revision;
    game.status = "playing";
    game.phase = recovery.phase as ServerGame["phase"];
    game.deadlineAt = deadlineAt;
    game.reviewReason = undefined;
    try {
      await this.commitMutation(
        game,
        "system:cash-recovery",
        {
          commandId: `system:${game.id}:cash-recovery:${expectedRevision}`,
          expectedRevision,
          commandType: "cash_game_resumed",
        },
        "cash_game_resumed",
        { recoveredRevision: recovery.gameRevision, phase: recovery.phase, deadlineAt: recovery.deadlineAt },
        { resumed: true },
      );
    } catch (error) {
      await this.reloadCanonicalCashGame(game, false);
      throw error;
    }
    if (game.deadlineAt !== null) this.scheduleTurnTimer(game);
  }

  async joinCashGame(gameId: string, player: PlayerConnection, quoteId: string): Promise<{ color: Player } | null> {
    return this.withGameLock(gameId, async () => {
      const quote = await quoteForGame(gameId);
      if (!quote || quote.id !== quoteId) return null;
      const gate = await cashGameJoinGate(gameId, player.address);
      if (!gate.allowed) throw new Error(gate.code ?? "CASH_GAME_PLAY_BLOCKED");
      const activeGameId = await this.getAuthoritativePlayerGame(player.address);
      if (activeGameId && activeGameId !== gameId) return null;
      if (!this.games.has(gameId)) {
        const pool = getPool();
        if (!pool) throw new Error("DATABASE_UNAVAILABLE");
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          const locked = await connection.query<{ state: string }>(
            "SELECT state FROM cash_game_quotes WHERE id = $1 AND game_id = $2 FOR UPDATE", [quoteId, gameId],
          );
          if (locked.rows[0]?.state !== "active") throw new Error("CASH_GAME_NOT_ACTIVE");
          const existing = await connection.query("SELECT id FROM games WHERE id = $1", [gameId]);
          if (!existing.rowCount) await reserveWaitingGame(connection, {
            id: gameId, playerWhite: quote.playerA, playerBlack: quote.playerB,
            turnTimeLimit: parseCashGameRules(quote.rules).turnTimeLimitSeconds,
            doublingAllowed: true, ownerInstanceId: this.instanceId,
          });
          await connection.query("COMMIT");
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
      }
      let game = this.games.get(gameId);
      if (!game) game = (await this.hydrateParticipantGame(gameId, player.address)) ?? undefined;
      if (!game && !(await renewGameOwnership(gameId, this.instanceId, CASH_GAME_LEASE_SECONDS))) {
        throw new Error("GAME_OWNERSHIP_LOST");
      }
      const existed = Boolean(game);
      game ??= this.createGameWithId(gameId, parseCashGameRules(quote.rules).turnTimeLimitSeconds);
      await this.ensureCashOwnership(game);
      const cashRules = parseCashGameRules(quote.rules);
      await this.restoreResumedCashGame(game);
      if (!["waiting", "depositing", "playing"].includes(game.status)) return null;
      if (game.cashQuoteId && game.cashQuoteId !== quoteId) return null;
      const previous = {
        playerWhite: game.playerWhite,
        playerBlack: game.playerBlack,
        status: game.status,
        escrowStatus: game.escrowStatus,
        phase: game.phase,
        deadlineAt: game.deadlineAt,
        cashQuoteId: game.cashQuoteId,
        cashRules: game.cashRules,
        turnTimeLimit: game.turnTimeLimit,
        revision: game.revision,
      };
      game.escrowStatus = "active";
      game.cashQuoteId = quoteId;
      game.cashRules = cashRules;
      game.turnTimeLimit = cashRules.turnTimeLimitSeconds;
      const result = this.assignPlayer(game, player, true);
      if (!result) {
        Object.assign(game, previous);
        return null;
      }
      if (game.status === "waiting" && game.playerWhite?.ws.readyState === 1 && game.playerBlack?.ws.readyState === 1) {
        game.status = "playing";
        game.phase = "await_roll";
        this.startTurnTimer(game);
      }
      if (existed && (
        previous.playerWhite?.address !== game.playerWhite?.address ||
        previous.playerBlack?.address !== game.playerBlack?.address ||
        previous.escrowStatus !== game.escrowStatus ||
        previous.status !== game.status ||
        previous.phase !== game.phase ||
        previous.cashQuoteId !== game.cashQuoteId
      )) game.revision++;
      const persisted = await this.persistGame(game);
      if (!persisted) {
        if (await this.reloadCanonicalCashGame(game)) throw new CanonicalGameReloadedError();
        this.relinquishCashOwnership(game);
        Object.assign(game, previous);
        this.playerGames.delete(player.address);
        if (!existed) {
          this.games.delete(gameId);
          this.diceHistories.delete(gameId);
        }
        throw new Error("CASH_GAME_PERSISTENCE_FAILED");
      }
      await this.startCashSessionIfReady(game);
      this.scheduleCashOwnershipRenewal(game);
      if (game.status === "waiting") this.scheduleWaitingExpiry(game);
      return result;
    });
  }

  getGame(id: string): ServerGame | undefined {
    return this.games.get(id);
  }

  getPlayerGame(address: string): string | undefined {
    return this.playerGames.get(address);
  }

  async getAuthoritativePlayerGame(address: string): Promise<string | undefined> {
    const local = this.playerGames.get(address);
    if (local) {
      const game = this.games.get(local);
      if (game && ["waiting", "depositing", "playing"].includes(game.status)) return local;
      this.playerGames.delete(address);
    }
    return (await loadCurrentGameForParticipant(address))?.id;
  }

  async joinGame(gameId: string, player: PlayerConnection): Promise<{ color: Player } | null> {
    return this.withGameLock(gameId, async () => {
      const activeGameId = await this.getAuthoritativePlayerGame(player.address);
      if (activeGameId && activeGameId !== gameId) return null;
      const game = this.games.get(gameId);
      if (!game || !["waiting", "depositing", "playing"].includes(game.status)) return null;
      await this.ensureCashOwnership(game);
      const playerWasAssigned = game.playerWhite?.address === player.address || game.playerBlack?.address === player.address;
      const hadParticipant = game.playerWhite !== null || game.playerBlack !== null;
      const priorStatus = game.status;
      const priorPhase = game.phase;
      const result = this.assignPlayer(game, player);
      if (!result) return null;
      if (
        (!playerWasAssigned && hadParticipant) ||
        game.status !== priorStatus ||
        game.phase !== priorPhase
      ) game.revision++;
      if (!(await this.persistGame(game))) {
        if (await this.reloadCanonicalCashGame(game)) throw new CanonicalGameReloadedError();
        throw new Error("GAME_PERSISTENCE_FAILED");
      }
      if (game.status === "waiting") this.scheduleWaitingExpiry(game);
      return result;
    });
  }

  async rollDiceLocked(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ dice: [number, number]; player: Player; gameState: GameState; legalMoves: Move[]; drandProof?: { round: number; randomness: string; signature: string }; drandFailed?: boolean } | null> {
    return this.withGameLock(gameId, () => this.rollDice(gameId, playerAddress, command));
  }

  async rollDice(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ dice: [number, number]; player: Player; gameState: GameState; legalMoves: Move[]; drandProof?: { round: number; randomness: string; signature: string }; drandFailed?: boolean } | null> {
    const replayed = await this.replayCashCommand(gameId, playerAddress, command);
    if (replayed !== undefined) return replayed as { dice: [number, number]; player: Player; gameState: GameState; legalMoves: Move[]; drandProof?: { round: number; randomness: string; signature: string }; drandFailed?: boolean };
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing" || game.phase !== "await_roll") return null;
    if (game.gameState.dice !== null) return null;
    await this.ensureCashOwnership(game);
    if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
    if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");

    const playerColor = this.getPlayerColor(game, playerAddress);
    const openingRoll = game.gameState.turnNumber === 0 && game.gameState.moveHistory.length === 0;
    if (!playerColor || (!openingRoll && playerColor !== game.gameState.currentPlayer)) return null;

    game.turnMoveStack = [];

    const diceHistory = this.diceHistories.get(gameId);
    const turnNumber = game.gameState.turnNumber + 1;
    const whiteAddr = game.playerWhite?.address || "";
    const blackAddr = game.playerBlack?.address || "";
    const proofContext = {
      drandChainHash: DRAND_CHAIN_HASH,
      gameId,
      cashQuoteId: game.cashQuoteId ?? null,
      playerWhite: whiteAddr,
      playerBlack: blackAddr,
      roller: playerColor,
      turnNumber,
      rulesVersion: game.escrowStatus === "active" ? this.cashRulesFor(game).version : "free-v1",
      openingRoll,
    } as const;

    let die1: number;
    let die2: number;
    let fullProof: DrandDiceProof | undefined;
    let drandProof: { round: number; randomness: string; signature: string } | undefined;

    try {
      const latest = await latestBeacon();
      const proposedRound = latest.round + 2;
      const proposedContext = diceCommitmentContext({
        ...proofContext,
        drandRound: proposedRound,
      });
      const commitment = await persistFutureRoundCommitment({
        gameId,
        turnNumber,
        player: playerColor,
        proposedRound,
        contextHex: proposedContext,
        commitHash: proposedContext,
      });
      if (!commitment) {
        if (game.escrowStatus === "active") throw new Error("DURABLE_DICE_COMMITMENT_REQUIRED");
        const proof = createDiceProof(latest, proofContext);
        die1 = proof.dice[0];
        die2 = proof.dice[1];
        fullProof = proof;
        drandProof = { round: proof.drandRound, randomness: proof.drandRandomness, signature: proof.drandSignature };
      } else {
        const expectedContext = diceCommitmentContext({
          ...proofContext,
          drandRound: commitment.round,
        });
        if (commitment.contextHex !== expectedContext) throw new Error("DICE_COMMITMENT_CONTEXT_MISMATCH");
        this.broadcastToGame(game, {
          type: "dice_commit",
          game_id: gameId,
          commit_hash: commitment.commitHash,
          turn_number: turnNumber,
        });
        const beacon = await fetchFutureBeacon(commitment.round);
        const proof = createDiceProof(beacon, proofContext);
        die1 = proof.dice[0];
        die2 = proof.dice[1];
        fullProof = proof;
        drandProof = { round: proof.drandRound, randomness: proof.drandRandomness, signature: proof.drandSignature };
        const revealed = await revealCommittedDice({
          gameId,
          turnNumber,
          player: playerColor,
          round: commitment.round,
          contextHex: commitment.contextHex,
          die1,
          die2,
          randomness: proof.drandRandomness,
          signature: proof.drandSignature,
          proof,
        });
        if (!revealed) throw new Error("DICE_REVEAL_PERSISTENCE_FAILED");
      }
      if (diceHistory && fullProof) diceHistory.addProof(fullProof);
    } catch (err) {
      if (game.escrowStatus === "active") {
        await this.pauseCashGameForReview(game, "proof_unavailable", game.deadlineAt ?? Date.now());
        throw new Error("CASH_GAME_REVIEW");
      }
      logger.warn("Drand unavailable; using unverifiable free-play dice", {
        gameId,
        errorCode: err instanceof Error ? err.name : "unknown",
      });
      die1 = randomInt(1, 7);
      die2 = randomInt(1, 7);
      if (openingRoll) {
        while (die1 === die2) {
          die1 = randomInt(1, 7);
          die2 = randomInt(1, 7);
        }
      }
      drandProof = undefined;
    }

    const drandFailed = !drandProof;

    if (openingRoll) {
      const opened = setOpeningRoll(game.gameState, die1, die2);
      if (!opened) throw new Error("OPENING_ROLL_TIE");
      game.gameState = opened;
    } else {
      game.gameState = setDice(game.gameState, die1, die2);
    }
    const rolledPlayer = game.gameState.currentPlayer;
    game.phase = "playing_moves";

    const legalMoves = getLegalFirstMoves(
      game.gameState.board,
      game.gameState.currentPlayer,
      game.gameState.movesRemaining
    );

    // Start turn timer — player must always confirm, even with no legal moves
    this.startTurnTimer(game);

    await this.commitMutation(
      game,
      playerAddress,
      command,
      "dice_rolled",
      { turnNumber, die1, die2, openingRoll, roller: playerColor, activePlayer: rolledPlayer, drandRound: drandProof?.round ?? null },
      { dice: [die1, die2], player: rolledPlayer, gameState: game.gameState, legalMoves, drandProof, drandFailed },
    );
    if (!drandProof) {
      await this.persistDiceRoll(gameId, turnNumber, playerColor, die1, die2, undefined, true);
    }

    return { dice: [die1, die2], player: rolledPlayer, gameState: game.gameState, legalMoves, drandProof, drandFailed };
  }

  async applyMoveLocked(
    gameId: string,
    playerAddress: string,
    from: number,
    to: number,
    command?: MutationCommand,
  ): Promise<{ move: Move; playerColor: Player; gameState: GameState; legalMoves: Move[]; turnAutoEnded: boolean } | null> {
    return this.withGameLock(gameId, () => this.applyMove(gameId, playerAddress, from, to, command));
  }

  async applyMove(
    gameId: string,
    playerAddress: string,
    from: number,
    to: number,
    command?: MutationCommand,
  ): Promise<{ move: Move; playerColor: Player; gameState: GameState; legalMoves: Move[]; turnAutoEnded: boolean } | null> {
    const replayed = await this.replayCashCommand(gameId, playerAddress, command);
    if (replayed !== undefined) return replayed as { move: Move; playerColor: Player; gameState: GameState; legalMoves: Move[]; turnAutoEnded: boolean };
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing" || !["playing_moves", "await_confirmation"].includes(game.phase)) return null;
    await this.ensureCashOwnership(game);
    if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
    if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");

    const playerColor = this.getPlayerColor(game, playerAddress);
    // Allow moves when it's the player's turn OR when they have pendingConfirmation (undo then re-move)
    if (!playerColor || (playerColor !== game.gameState.currentPlayer && game.pendingConfirmation !== playerAddress)) return null;
    if (game.gameState.dice === null) return null;

    const newState = makeMove(game.gameState, from, to);
    if (!newState) return null;
    game.turnMoveStack.push(structuredClone(game.gameState));

    // Find which die was used
    const usedDieValues = game.gameState.movesRemaining.filter(
      (d, i) => !newState.movesRemaining.includes(d) ||
        game.gameState.movesRemaining.indexOf(d) !== newState.movesRemaining.indexOf(d)
    );
    const die = usedDieValues[0] || game.gameState.movesRemaining[0];

    const move: Move = { from, to, die };
    game.gameState = newState;

    const legalMoves = newState.movesRemaining.length > 0
      ? getLegalFirstMoves(newState.board, newState.currentPlayer, newState.movesRemaining)
      : [];

    // Check if game is over
    if (newState.gameOver) {
      game.status = "finished";
      this.clearTurnTimer(game);
      game.phase = "terminal";
    }

    // If turn auto-ended (currentPlayer changed), set pending confirmation
    const turnAutoEnded = newState.currentPlayer !== playerColor && !newState.gameOver;
    if (turnAutoEnded) {
      game.pendingConfirmation = playerAddress;
      game.phase = "await_confirmation";
    } else if (!newState.gameOver) {
      game.phase = "playing_moves";
    }

    const result = { move, playerColor, gameState: game.gameState, legalMoves, turnAutoEnded };
    await this.commitMutation(
      game,
      playerAddress,
      command,
      "move_made",
      { from, to, die, turnNumber: game.gameState.turnNumber },
      result,
    );
    if (newState.gameOver) await this.deletePersistedGame(gameId);

    if (game.escrowStatus !== "active") {
      await this.persistMoveRecord(gameId, game.gameState.turnNumber, playerColor, from, to, newState);
    }
    return result;
  }

  async handleEndTurnLocked(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<GameState | null> {
    return this.withGameLock(gameId, () => this.handleEndTurn(gameId, playerAddress, command));
  }

  async handleEndTurn(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<GameState | null> {
    const replayed = await this.replayCashCommand(gameId, playerAddress, command);
    if (replayed !== undefined) return replayed as GameState;
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing" || !["playing_moves", "await_confirmation"].includes(game.phase)) return null;
    await this.ensureCashOwnership(game);
    if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
    if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");

    // Handle pendingConfirmation: player confirms the auto-ended turn
    if (game.phase === "await_confirmation" && game.pendingConfirmation === playerAddress) {
      game.pendingConfirmation = null;
      game.turnMoveStack = [];
      game.phase = "await_roll";
      // Start timer for next player's roll phase (will be reset when they roll)
      this.startTurnTimer(game);
      await this.commitMutation(
        game,
        playerAddress,
        command,
        "turn_confirmed",
        { turnNumber: game.gameState.turnNumber },
        game.gameState,
      );
      return game.gameState;
    }

    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor || playerColor !== game.gameState.currentPlayer) return null;

    // Can only end turn if no legal moves remain or player has used their dice
    if (hasLegalMoves(game.gameState)) return null;

    game.turnMoveStack = [];
    game.gameState = endTurn(game.gameState);
    game.phase = "await_roll";
    // Start timer for next player's roll phase (will be reset when they roll)
    this.startTurnTimer(game);

    await this.commitMutation(
      game,
      playerAddress,
      command,
      "turn_ended",
      { turnNumber: game.gameState.turnNumber },
      game.gameState,
    );

    return game.gameState;
  }

  async handleUndoLocked(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ gameState: GameState; legalMoves: Move[] } | null> {
    return this.withGameLock(gameId, () => this.handleUndo(gameId, playerAddress, command));
  }

  async handleUndo(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ gameState: GameState; legalMoves: Move[] } | null> {
    const replayed = await this.replayCashCommand(gameId, playerAddress, command);
    if (replayed !== undefined) return replayed as { gameState: GameState; legalMoves: Move[] };
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing" || !["playing_moves", "await_confirmation"].includes(game.phase)) return null;
    await this.ensureCashOwnership(game);
    if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
    if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");

    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;

    // Allow undo when pendingConfirmation is set (even though currentPlayer changed)
    const isPending = game.pendingConfirmation === playerAddress;
    if (!isPending && playerColor !== game.gameState.currentPlayer) return null;
    if (game.turnMoveStack.length === 0) return null;

    game.gameState = game.turnMoveStack.pop()!;

    // Clear pendingConfirmation if restored state's currentPlayer matches the player
    if (isPending && game.gameState.currentPlayer === playerColor) {
      game.pendingConfirmation = null;
      game.phase = "playing_moves";
    }

    const legalMoves = getLegalFirstMoves(
      game.gameState.board,
      game.gameState.currentPlayer,
      game.gameState.movesRemaining,
    );
    const result = { gameState: game.gameState, legalMoves };
    await this.commitMutation(
      game,
      playerAddress,
      command,
      "move_undone",
      {},
      result,
    );
    return result;
  }

  handleDisconnect(address: string): { gameId: string; game: ServerGame } | null {
    const gameId = this.playerGames.get(address);
    if (!gameId) return null;

    const game = this.games.get(gameId);
    if (!game) return null;

    return { gameId, game };
  }

  async handleReconnect(gameId: string, player: PlayerConnection): Promise<boolean> {
    let game = this.games.get(gameId);
    if (!game) game = (await this.hydrateParticipantGame(gameId, player.address)) ?? undefined;
    if (!game) return false;
    return this.withGameLock(gameId, async () => {
      await this.ensureCashOwnership(game!);
      if (game!.playerWhite?.address === player.address) game!.playerWhite = player;
      else if (game!.playerBlack?.address === player.address) game!.playerBlack = player;
      else return false;
      this.playerGames.set(player.address, gameId);
      if (game!.escrowStatus === "active") {
        await this.restoreResumedCashGame(game!);
        await this.startCashSessionIfReady(game!);
      }
      if (game!.disconnectedPlayer !== player.address) return true;
      const expectedRevision = game!.revision;
      this.cancelDisconnectGracePeriod(game!);
      await this.commitMutation(
        game!,
        player.address,
        this.systemCommand(game!, "player_reconnected", `${player.address}:${expectedRevision}`),
        "player_reconnected",
        { player: player.address },
        { reconnected: true },
      );
      if (game!.status === "playing" && game!.deadlineAt !== null) this.scheduleTurnTimer(game!);
      return true;
    });
  }

  /** Update a player's WebSocket to the one that sent a game message. */
  updatePlayerWs(gameId: string, address: string, ws: WebSocket): void {
    const game = this.games.get(gameId);
    if (!game) return;
    if (game.playerWhite?.address === address && game.playerWhite.ws !== ws) {
      game.playerWhite.ws = ws;
    }
    if (game.playerBlack?.address === address && game.playerBlack.ws !== ws) {
      game.playerBlack.ws = ws;
    }
  }

  private detachGame(game: ServerGame): void {
    this.relinquishCashOwnership(game);
    if (game.playerWhite && this.playerGames.get(game.playerWhite.address) === game.id) {
      this.playerGames.delete(game.playerWhite.address);
    }
    if (game.playerBlack && this.playerGames.get(game.playerBlack.address) === game.id) {
      this.playerGames.delete(game.playerBlack.address);
    }
    this.games.delete(game.id);
    this.diceHistories.delete(game.id);
    this.gameLocks.delete(game.id);
  }

  releaseTerminalGame(gameId: string): void {
    const game = this.games.get(gameId);
    if (game && ["finished", "abandoned"].includes(game.status)) this.detachGame(game);
  }

  removeGame(gameId: string): void {
    const game = this.games.get(gameId);
    if (!game) return;
    void this.deletePersistedGame(gameId);
    this.detachGame(game);
  }

  discardUnjoinedGame(gameId: string): void {
    const game = this.games.get(gameId);
    if (game?.status === "waiting" && !game.playerWhite && !game.playerBlack) this.detachGame(game);
  }

  // ── Doubling Cube ─────────────────────────────────────────────

  async handleOfferDouble(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ player: Player; cubeValue: number; deadlineAt: number; offerRevision: number } | null> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed as { player: Player; cubeValue: number; deadlineAt: number; offerRevision: number };
      const game = this.games.get(gameId);
      if (!game || !game.doublingAllowed || game.status !== "playing" || game.phase !== "await_roll" || game.pendingDoubleOffer || game.gameState.turnNumber === 0) return null;
      await this.ensureCashOwnership(game);
      if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
      if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      const playerColor = this.getPlayerColor(game, playerAddress);
      if (!playerColor || !canDouble(game.gameState, playerColor)) return null;
      const cubeValue = game.gameState.cubeValue * 2;
      if (cubeValue !== 2 && cubeValue !== 4 && cubeValue !== 8) return null;
      const offeredAt = Date.now();
      const deadlineAt = offeredAt + this.cashRulesFor(game).doubleResponseSeconds * 1000;
      const offerRevision = game.revision + 1;
      game.pendingDoubleOffer = { doubler: playerAddress, offeredCube: cubeValue, offeredAt, deadlineAt, offerRevision };
      game.phase = "double_offer";
      this.clearTurnTimer(game);
      game.deadlineAt = deadlineAt;
      this.scheduleTurnTimer(game);
      const result = { player: playerColor, cubeValue, deadlineAt, offerRevision };
      await this.commitMutation(game, playerAddress, command, "double_offered", { cubeValue, deadlineAt, offerRevision }, result);
      return result;
    });
  }

  async handleAcceptDoubleFree(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ cubeValue: number; cubeOwner: Player } | null> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed as { cubeValue: number; cubeOwner: Player };
      const game = this.games.get(gameId);
      const offer = game?.pendingDoubleOffer;
      if (!game || game.status !== "playing" || game.phase !== "double_offer" || !offer || offer.doubler === playerAddress) return null;
      if (Date.now() > offer.deadlineAt) {
        if (game.escrowStatus === "active") await this.pauseCashGameForReview(game, "double_response_timeout", offer.deadlineAt);
        return null;
      }
      await this.ensureCashOwnership(game);
      if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
      if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      const playerColor = this.getPlayerColor(game, playerAddress);
      if (!playerColor) return null;
      game.gameState = acceptDouble(game.gameState, playerColor);
      game.pendingDoubleOffer = null;
      game.phase = "await_roll";
      this.startTurnTimer(game);
      const result = { cubeValue: game.gameState.cubeValue, cubeOwner: game.gameState.cubeOwner! };
      await this.commitMutation(game, playerAddress, command, "double_accepted", result, result);
      return result;
    });
  }


  async handleRejectDouble(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ winner: Player } | null> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed as { winner: Player };
      const game = this.games.get(gameId);
      const offer = game?.pendingDoubleOffer;
      if (!game || game.status !== "playing" || game.phase !== "double_offer" || !offer || offer.doubler === playerAddress) return null;
      if (Date.now() > offer.deadlineAt) {
        if (game.escrowStatus === "active") await this.pauseCashGameForReview(game, "double_response_timeout", offer.deadlineAt);
        return null;
      }
      await this.ensureCashOwnership(game);
      if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
      if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      const playerColor = this.getPlayerColor(game, playerAddress);
      if (!playerColor) return null;
      const rejected = rejectDouble(game.gameState, playerColor);
      game.gameState = rejected.state;
      game.status = "finished";
      game.pendingDoubleOffer = null;
      game.phase = "terminal";
      this.clearTurnTimer(game);
      const result = { winner: rejected.winner };
      await this.commitMutation(game, playerAddress, command, "double_rejected", result, result);
      await this.deletePersistedGame(gameId);
      return result;
    });
  }


  // ── Typed Resignation ─────────────────────────────────────────

  async handleResignationTyped(
    gameId: string,
    playerAddress: string,
    resignType: "normal" | "gammon" | "backgammon" = "normal",
    command?: MutationCommand,
  ): Promise<{ offered: boolean; winner?: Player; loser?: Player; resignType: string; deadlineAt?: number; offerRevision?: number } | null> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed as { offered: boolean; winner?: Player; loser?: Player; resignType: string; deadlineAt?: number; offerRevision?: number };
      const game = this.games.get(gameId);
      if (!game || game.status !== "playing" || !["await_roll", "playing_moves", "await_confirmation"].includes(game.phase) || game.pendingResignation) return null;
      await this.ensureCashOwnership(game);
      if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
      if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      const playerColor = this.getPlayerColor(game, playerAddress);
      if (!playerColor) return null;
      if (playerColor !== game.gameState.currentPlayer && game.pendingConfirmation !== playerAddress) return null;
      if (resignType !== "normal") {
        const previousPhase = game.phase as "await_roll" | "playing_moves" | "await_confirmation";
        const offeredAt = Date.now();
        const previousDeadlineAt = game.deadlineAt ?? offeredAt;
        const deadlineAt = offeredAt + this.cashRulesFor(game).resignationResponseSeconds * 1000;
        const offerRevision = game.revision + 1;
        game.pendingResignation = { player: playerAddress, resignType, previousPhase, previousDeadlineAt, offeredAt, deadlineAt, offerRevision };
        game.phase = "resignation_offer";
        this.clearTurnTimer(game);
        game.deadlineAt = deadlineAt;
        this.scheduleTurnTimer(game);
        const result = { offered: true, resignType, deadlineAt, offerRevision };
        await this.commitMutation(game, playerAddress, command, "resignation_offered", { resignType, deadlineAt, offerRevision }, result);
        return result;
      }
      const winner: Player = playerColor === "white" ? "black" : "white";
      game.status = "finished";
      game.gameState = { ...game.gameState, gameOver: true, winner, resultType: "normal" };
      game.phase = "terminal";
      this.clearTurnTimer(game);
      const result = { offered: false, winner, loser: playerColor, resignType: "normal" };
      await this.commitMutation(game, playerAddress, command, "resigned", { resultType: "normal" }, result);
      await this.deletePersistedGame(gameId);
      return result;
    });
  }

  async handleAcceptResignation(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<{ winner: Player; resultType: ResultType } | null> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed as { winner: Player; resultType: ResultType };
      const game = this.games.get(gameId);
      if (!game || game.status !== "playing" || game.phase !== "resignation_offer" || !game.pendingResignation) return null;
      if (Date.now() > game.pendingResignation.deadlineAt) {
        if (game.escrowStatus === "active") await this.pauseCashGameForReview(game, "resignation_response_timeout", game.pendingResignation.deadlineAt);
        return null;
      }
      await this.ensureCashOwnership(game);
      if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
      if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      const resigningColor = this.getPlayerColor(game, game.pendingResignation.player);
      const acceptingColor = this.getPlayerColor(game, playerAddress);
      if (!resigningColor || !acceptingColor || resigningColor === acceptingColor) return null;
      const result = { winner: acceptingColor, resultType: game.pendingResignation.resignType as ResultType };
      game.status = "finished";
      game.gameState = { ...game.gameState, gameOver: true, winner: result.winner, resultType: result.resultType };
      game.phase = "terminal";
      game.pendingResignation = null;
      this.clearTurnTimer(game);
      await this.commitMutation(game, playerAddress, command, "resignation_accepted", result, result);
      await this.deletePersistedGame(gameId);
      return result;
    });
  }

  async handleRejectResignation(
    gameId: string,
    playerAddress: string,
    command?: MutationCommand,
  ): Promise<boolean> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed as boolean;
      const game = this.games.get(gameId);
      if (!game || game.status !== "playing" || game.phase !== "resignation_offer" || !game.pendingResignation) return false;
      if (Date.now() > game.pendingResignation.deadlineAt) {
        if (game.escrowStatus === "active") await this.pauseCashGameForReview(game, "resignation_response_timeout", game.pendingResignation.deadlineAt);
        return false;
      }
      await this.ensureCashOwnership(game);
      if (game.escrowStatus === "active") await this.requireCashPlayGate(game, playerAddress);
      if (!command || command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      const resigningColor = this.getPlayerColor(game, game.pendingResignation.player);
      const rejectingColor = this.getPlayerColor(game, playerAddress);
      if (!resigningColor || !rejectingColor || resigningColor === rejectingColor) return false;
      const previousPhase = game.pendingResignation.previousPhase;
      const previousDeadlineAt = game.pendingResignation.previousDeadlineAt;
      game.pendingResignation = null;
      game.phase = previousPhase;
      game.deadlineAt = previousDeadlineAt;
      this.scheduleTurnTimer(game);
      await this.commitMutation(game, playerAddress, command, "resignation_rejected", {}, { rejected: true });
      return true;
    });
  }


  // ── Stalling Detection ────────────────────────────────────────

  checkStalling(game: ServerGame, playerAddress: string): { warn: boolean; penalize: boolean } {
    if (game.moveTimes.length < STALLING_MIN_MOVES) return { warn: false, penalize: false };

    const recent = game.moveTimes.slice(-3);
    const avgTime = recent.reduce((a, b) => a + b, 0) / recent.length;
    const turnLimit = game.turnTimeLimit * 1000;

    if (avgTime > turnLimit * STALLING_THRESHOLD_PCTG) {
      if (game.stallingWarned) return { warn: false, penalize: true };
      return { warn: true, penalize: false };
    }
    return { warn: false, penalize: false };
  }

  getDiceHistory(gameId: string): DrandDiceProof[] {
    const history = this.diceHistories.get(gameId);
    return history ? history.getHistory() : [];
  }

  getPlayerColor(game: ServerGame, address: string): Player | null {
    if (game.playerWhite?.address === address) return "white";
    if (game.playerBlack?.address === address) return "black";
    return null;
  }

  private scheduleWaitingExpiry(game: ServerGame): void {
    if (!game.ownershipTimer || game.status !== "waiting" || !game.playerWhite || game.playerBlack) return;
    this.clearTurnTimer(game);
    const delay = Math.max(0, game.createdAt + WAITING_GAME_EXPIRY_MS - Date.now());
    game.turnTimer = setTimeout(() => {
      void this.withGameLock(game.id, async () => {
        if (
          this.games.get(game.id) !== game ||
          game.status !== "waiting" ||
          !game.playerWhite ||
          game.playerBlack
        ) return;
        await this.ensureCashOwnership(game);
        game.status = "abandoned";
        game.phase = "terminal";
        await this.deletePersistedGame(game.id);
        this.detachGame(game);
      }).catch((error: unknown) => {
        logger.error("Waiting game expiry failed", { gameId: game.id, errorCode: error instanceof Error ? error.name : "unknown" });
      });
    }, delay);
  }

  private startTurnTimer(game: ServerGame, seconds = game.turnTimeLimit): void {
    this.clearTurnTimer(game);
    game.deadlineAt = Date.now() + seconds * 1000;
    this.scheduleTurnTimer(game);
  }

  private scheduleTurnTimer(game: ServerGame): void {
    if (!game.ownershipTimer) return;
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = null;
    const expectedDeadline = game.deadlineAt;
    if (expectedDeadline === null || game.status !== "playing") return;
    const delay = Math.max(0, expectedDeadline - Date.now());
    game.turnTimer = setTimeout(() => {
      void this.withGameLock(game.id, async () => {
        const current = this.games.get(game.id);
        if (
          current !== game ||
          game.status !== "playing" ||
          game.gameState.gameOver ||
          game.deadlineAt !== expectedDeadline
        ) return;
        await this.ensureCashOwnership(game);
        game.turnTimer = null;

        if (game.escrowStatus === "active") {
          const reason: GameReviewReason = game.pendingDoubleOffer
            ? "double_response_timeout"
            : game.pendingResignation
              ? "resignation_response_timeout"
              : "turn_timeout";
          await this.pauseCashGameForReview(game, reason, expectedDeadline);
          return;
        }

        if (game.pendingDoubleOffer) {
          const doubler = this.getPlayerColor(game, game.pendingDoubleOffer.doubler);
          if (!doubler) return;
          const responder: Player = doubler === "white" ? "black" : "white";
          const rejected = rejectDouble(game.gameState, responder);
          game.gameState = rejected.state;
          game.pendingDoubleOffer = null;
          game.status = "finished";
          game.phase = "terminal";
          game.deadlineAt = null;
          await this.commitMutation(game, "system:deadline", this.systemCommand(game, "double_response_timeout", expectedDeadline), "double_response_timeout", {}, { winner: rejected.winner });
          await this.deletePersistedGame(game.id);
          this.broadcastToGame(game, { type: "double_rejected", game_id: game.id, winner: rejected.winner, revision: game.revision });
          await this.emitTerminalResult(game, rejected.winner, "normal");
          return;
        }
        if (game.pendingResignation) {
          const previousPhase = game.pendingResignation.previousPhase;
          const previousDeadlineAt = game.pendingResignation.previousDeadlineAt;
          game.pendingResignation = null;
          game.phase = previousPhase;
          game.deadlineAt = previousDeadlineAt;
          this.scheduleTurnTimer(game);
          await this.commitMutation(game, "system:deadline", this.systemCommand(game, "resignation_response_timeout", expectedDeadline), "resignation_response_timeout", {}, { rejected: true });
          this.broadcastToGame(game, { type: "resign_rejected", game_id: game.id, revision: game.revision });
          return;
        }


        if (game.pendingConfirmation) {
          game.pendingConfirmation = null;
          game.turnMoveStack = [];
          game.phase = "await_roll";
          this.startTurnTimer(game);
          await this.commitMutation(game, "system:deadline", this.systemCommand(game, "confirmation_timeout", expectedDeadline), "confirmation_timeout", {}, game.gameState);
          this.broadcastToGame(game, {
            type: "turn_ended",
            game_id: game.id,
            next_player: game.gameState.currentPlayer,
            game_state: game.gameState,
            revision: game.revision,
          });
          return;
        }

        if (game.gameState.dice !== null && hasLegalMoves(game.gameState)) {
          const loser = game.gameState.currentPlayer;
          const winner: Player = loser === "white" ? "black" : "white";
          game.status = "finished";
          game.phase = "terminal";
          game.deadlineAt = null;
          game.gameState = { ...game.gameState, gameOver: true, winner, resultType: "normal" };
          await this.commitMutation(game, "system:deadline", this.systemCommand(game, "turn_timeout_forfeit", expectedDeadline), "turn_timeout_forfeit", {}, { winner });
          await this.deletePersistedGame(game.id);
          await this.emitTerminalResult(game, winner, "normal");
          return;
        }

        game.turnMoveStack = [];
        game.gameState = endTurn(game.gameState);
        game.phase = "await_roll";
        this.startTurnTimer(game);
        await this.commitMutation(game, "system:deadline", this.systemCommand(game, "turn_timeout", expectedDeadline), "turn_timeout", {}, game.gameState);
        this.broadcastToGame(game, {
          type: "turn_ended",
          game_id: game.id,
          next_player: game.gameState.currentPlayer,
          game_state: game.gameState,
          revision: game.revision,
        });
      }).catch((error: unknown) => {
        logger.error("Game deadline processing failed", { gameId: game.id, errorCode: error instanceof Error ? error.name : "unknown" });
      });
    }, delay);
  }

  private clearTurnTimer(game: ServerGame): void {
    if (game.turnTimer) clearTimeout(game.turnTimer);
    game.turnTimer = null;
    game.deadlineAt = null;
  }

  async prepareForDrain(): Promise<void> {
    await Promise.all([...this.games.values()].map(async (game) => {
      if (game.escrowStatus !== "active" || game.status !== "playing") return;
      try {
        await this.withGameLock(game.id, async () => {
          await this.ensureCashOwnership(game);
          this.cancelDisconnectGracePeriod(game);
          await this.pauseCashGameForReview(game, "platform_recovery", Date.now());
        });
      } catch (error) {
        logger.error("Failed to pause cash game for drain", {
          gameId: game.id,
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      }
    }));
  }

  async requestCashReview(
    gameId: string,
    playerAddress: string,
    command: MutationCommand,
  ): Promise<boolean> {
    return this.withGameLock(gameId, async () => {
      const replayed = await this.replayCashCommand<boolean>(gameId, playerAddress, command);
      if (replayed !== undefined) return replayed;
      const game = this.games.get(gameId);
      if (!game || game.escrowStatus !== "active" || game.status !== "playing") return game?.phase === "review";
      if (!this.getPlayerColor(game, playerAddress)) return false;
      await this.ensureCashOwnership(game);
      if (command.expectedRevision !== game.revision) throw new Error("GAME_REVISION_CONFLICT");
      await this.pauseCashGameForReview(game, "terms_unavailable", Date.now(), playerAddress, command);
      return true;
    });
  }

  private async pauseCashGameForReview(
    game: ServerGame,
    reason: GameReviewReason,
    deadlineIdentity: number,
    principal = "system:deadline",
    command?: MutationCommand,
  ): Promise<void> {
    const expectedRevision = game.revision;
    const captured = await captureCashGameReviewSnapshot({
      gameId: game.id,
      reason,
      phase: game.phase,
      deadlineAt: game.deadlineAt === null ? null : new Date(game.deadlineAt),
      gameRevision: expectedRevision,
    });
    if (!captured) throw new Error("CASH_GAME_REVIEW");
    this.clearTurnTimer(game);
    game.status = "abandoned";
    game.phase = "review";
    game.reviewReason = reason;
    await this.commitMutation(
      game,
      principal,
      command ?? {
        commandId: `system:${game.id}:${reason}:${deadlineIdentity}`,
        expectedRevision,
        commandType: "system_cash_review",
      },
      "cash_game_review",
      { reason },
      { reason, fundsStatus: "held_for_review" },
    );
    this.broadcastToGame(game, {
      type: "game_review",
      game_id: game.id,
      reason,
      funds_status: "held_for_review",
      revision: game.revision,
    });
    await this.deletePersistedGame(game.id);
    this.detachGame(game);
  }

  async startDisconnectGracePeriod(
    game: ServerGame,
    address: string,
    onForfeit?: (gameId: string, winner: Player, resultType: ResultType) => void,
  ): Promise<void> {
    await this.withGameLock(game.id, async () => {
      if (game.status !== "playing" || game.gameState.gameOver) return;
      const expectedRevision = game.revision;
      await this.ensureCashOwnership(game);
      this.cancelDisconnectGracePeriod(game);
      const disconnectedAt = Date.now();
      game.disconnectedPlayer = address;
      game.disconnectedAt = disconnectedAt;
      const graceSec = game.escrowStatus === "active"
        ? this.cashRulesFor(game).disconnectGraceSeconds
        : DISCONNECT_GRACE_SEC;
      await this.commitMutation(
        game,
        address,
        this.systemCommand(game, "player_disconnected", `${address}:${expectedRevision}`),
        "player_disconnected",
        { player: address, disconnectedAt, graceSeconds: graceSec },
        { disconnectedAt, graceSeconds: graceSec },
      );
      const opponent = game.playerWhite?.address === address ? game.playerBlack : game.playerWhite;
      if (opponent) {
        this.sendToPlayer(opponent, {
          type: "opponent_disconnecting",
          game_id: game.id,
          grace_seconds: graceSec,
        });
      }
      this.scheduleDisconnectGraceTimer(game, address, disconnectedAt, onForfeit);
    });
  }

  private scheduleDisconnectGraceTimer(
    game: ServerGame,
    address: string,
    disconnectedAt: number,
    onForfeit?: (gameId: string, winner: Player, resultType: ResultType) => void,
  ): void {
    if (!game.ownershipTimer) return;
    clearInterval(game.disconnectTimer ?? undefined);
    const graceSec = game.escrowStatus === "active"
      ? this.cashRulesFor(game).disconnectGraceSeconds
      : DISCONNECT_GRACE_SEC;
    const deadline = disconnectedAt + graceSec * 1_000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
      if (remaining > 0) {
        const opponent = game.playerWhite?.address === address ? game.playerBlack : game.playerWhite;
        if (opponent) {
          this.sendToPlayer(opponent, {
            type: "disconnect_countdown",
            game_id: game.id,
            seconds_remaining: remaining,
          });
        }
        return;
      }
      void this.withGameLock(game.id, async () => {
        await this.ensureCashOwnership(game);
        this.cancelDisconnectGracePeriod(game);
        if (game.escrowStatus === "active") {
          await this.pauseCashGameForReview(game, "player_disconnect", deadline);
          return;
        }
        const disconnectedColor = this.getPlayerColor(game, address);
        if (!disconnectedColor) return;
        const winner: Player = disconnectedColor === "white" ? "black" : "white";
        game.status = "finished";
        game.phase = "terminal";
        game.gameState = { ...game.gameState, gameOver: true, winner, resultType: "normal" };
        this.clearTurnTimer(game);
        await this.commitMutation(game, "system:disconnect", this.systemCommand(game, "disconnect_forfeit", deadline), "disconnect_forfeit", {}, { winner });
        await this.deletePersistedGame(game.id);
        if (onForfeit) onForfeit(game.id, winner, "normal");
        else await this.emitTerminalResult(game, winner, "normal");
      }).catch((error: unknown) => {
        logger.error("Disconnect deadline processing failed", { gameId: game.id, errorCode: error instanceof Error ? error.name : "unknown" });
      });
    };
    game.disconnectTimer = setInterval(tick, game.escrowStatus === "active"
      ? this.cashRulesFor(game).disconnectCheckIntervalMs
      : DISCONNECT_CHECK_INTERVAL_MS);
    tick();
  }

  cancelDisconnectGracePeriod(game: ServerGame): void {
    if (game.disconnectTimer) {
      clearInterval(game.disconnectTimer);
      game.disconnectTimer = null;
    }
    game.disconnectedPlayer = null;
    game.disconnectedAt = null;
  }

  broadcastToGame(game: ServerGame, message: ServerMessage): void {
    const data = JSON.stringify(message);
    if (game.playerWhite) sendWebSocketData(game.playerWhite.ws, data);
    if (game.playerBlack) sendWebSocketData(game.playerBlack.ws, data);
  }

  sendToPlayer(player: PlayerConnection | null, message: ServerMessage): void {
    if (player) sendWebSocketData(player.ws, JSON.stringify(message));
  }
}
