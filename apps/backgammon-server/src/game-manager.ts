import { randomInt, randomUUID } from "node:crypto";
import { GameDiceHistory, createDiceProof, type DrandDiceProof } from "./dice.js";
import { latestBeacon } from "./drand.js";
import { DEFAULT_TURN_TIME_LIMIT_SEC, DOUBLE_DEPOSIT_TIMEOUT_MS, STALLING_MIN_MOVES, STALLING_THRESHOLD_PCTG, DISCONNECT_GRACE_SEC, DISCONNECT_GRACE_DOUBLE_SEC, DISCONNECT_CHECK_INTERVAL_MS } from "./config.js";
import {
  createGameState,
  setDice,
  makeMove,
  endTurn,
  hasLegalMoves,
  getLegalFirstMoves,
  canDouble,
  acceptDouble,
  rejectDouble,
  type GameState,
  type Player,
  type Move,
  type ResultType,
} from "@xion-beginner/backgammon-core";
import { getEscrowClient } from "./escrow.js";
import type { ServerGame, PlayerConnection, ServerMessage } from "./types.js";

export class GameManager {
  private games = new Map<string, ServerGame>();
  private playerGames = new Map<string, string>(); // address -> gameId
  private diceHistories = new Map<string, GameDiceHistory>();
  private gameLocks = new Map<string, Promise<void>>();

  private async withGameLock<T>(gameId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.gameLocks.get(gameId) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    this.gameLocks.set(gameId, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  private async persistGame(game: ServerGame): Promise<void> {
    try {
      const { getRedis: getR } = await import("./redis.js");
      const r = getR();
      if (!r) return;
      const serializable = {
        id: game.id,
        gameState: game.gameState,
        wagerAmount: game.wagerAmount,
        status: game.status,
        playerWhiteAddress: game.playerWhite?.address || null,
        playerBlackAddress: game.playerBlack?.address || null,
        turnMoveStack: game.turnMoveStack,
        pendingConfirmation: game.pendingConfirmation,
        moveHistory: game.gameState.moveHistory || [],
      };
      await r.set(`active_game:${game.id}`, JSON.stringify(serializable), "EX", 7200); // 2 hour TTL
    } catch {
      // Non-critical — don't crash on persistence failure
    }
  }

  private async deletePersistedGame(gameId: string): Promise<void> {
    try {
      const { getRedis: getR } = await import("./redis.js");
      const r = getR();
      if (!r) return;
      await r.del(`active_game:${gameId}`);
    } catch {
      // Non-critical failure
    }
  }

  async restoreGames(): Promise<number> {
    try {
      const { getRedis: getR } = await import("./redis.js");
      const r = getR();
      if (!r) return 0;
      const keys = await r.keys("active_game:*");
      let restored = 0;
      for (const key of keys) {
        try {
          const raw = await r.get(key);
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (data.status !== "playing") continue;

          const game: ServerGame = {
            id: data.id,
            gameState: data.gameState,
            wagerAmount: data.wagerAmount,
            status: data.status,
            playerWhite: null, // Players need to reconnect
            playerBlack: null,
            spectators: [],
            createdAt: Date.now(),
            turnTimer: null,
            turnTimeLimit: DEFAULT_TURN_TIME_LIMIT_SEC,
            turnMoveStack: data.turnMoveStack || [],
            pendingConfirmation: data.pendingConfirmation || null,
            disconnectTimer: null,
            disconnectedPlayer: null,
            disconnectedAt: null,
            escrowStatus: "none",
            pendingResignation: null,
            moveTimes: [],
            stallingWarned: false,
            pendingDoubleDeposit: null,
          };
          this.games.set(game.id, game);

          // Track player-game mappings for reconnection
          if (data.playerWhiteAddress) {
            this.playerGames.set(data.playerWhiteAddress, game.id);
          }
          if (data.playerBlackAddress) {
            this.playerGames.set(data.playerBlackAddress, game.id);
          }
          restored++;
        } catch {
          // Skip corrupted entries
        }
      }
      return restored;
    } catch {
      return 0;
    }
  }

  private generateGameId(): string {
    return randomUUID();
  }

  createGame(wagerAmount: number, turnTimeLimit: number = DEFAULT_TURN_TIME_LIMIT_SEC): ServerGame {
    const id = this.generateGameId();
    const game: ServerGame = {
      id,
      gameState: createGameState(),
      playerWhite: null,
      playerBlack: null,
      spectators: [],
      wagerAmount,
      status: "waiting",
      createdAt: Date.now(),
      turnTimer: null,
      turnTimeLimit,
      turnMoveStack: [],
      pendingConfirmation: null,
      disconnectTimer: null,
      disconnectedPlayer: null,
      disconnectedAt: null,
      escrowStatus: "none",
      pendingResignation: null,
      moveTimes: [],
      stallingWarned: false,
      pendingDoubleDeposit: null,
    };
    this.diceHistories.set(id, new GameDiceHistory());
    this.games.set(id, game);
    return game;
  }

  getGame(id: string): ServerGame | undefined {
    return this.games.get(id);
  }

  getPlayerGame(address: string): string | undefined {
    return this.playerGames.get(address);
  }

  joinGame(gameId: string, player: PlayerConnection): { color: Player } | null {
    const game = this.games.get(gameId);
    if (!game) return null;

    if (!game.playerWhite) {
      game.playerWhite = player;
      this.playerGames.set(player.address, gameId);
      return { color: "white" };
    } else if (!game.playerBlack && game.playerWhite.address !== player.address) {
      game.playerBlack = player;
      this.playerGames.set(player.address, gameId);
      game.status = "playing";
      return { color: "black" };
    }
    return null;
  }

  async rollDiceLocked(gameId: string, playerAddress: string): Promise<{ dice: [number, number]; gameState: GameState; legalMoves: Move[]; drandProof?: { round: number; randomness: string; signature: string } } | null> {
    return this.withGameLock(gameId, () => this.rollDice(gameId, playerAddress));
  }

  async rollDice(gameId: string, playerAddress: string): Promise<{ dice: [number, number]; gameState: GameState; legalMoves: Move[]; drandProof?: { round: number; randomness: string; signature: string } } | null> {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    if (game.gameState.dice !== null) return null; // already rolled

    // Verify it's this player's turn
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor || playerColor !== game.gameState.currentPlayer) return null;

    game.turnMoveStack = [];

    const diceHistory = this.diceHistories.get(gameId);
    const turnNumber = game.gameState.turnNumber + 1; // setDice increments turnNumber
    const whiteAddr = game.playerWhite?.address || "";
    const blackAddr = game.playerBlack?.address || "";

    let die1: number;
    let die2: number;
    let drandProof: { round: number; randomness: string; signature: string } | undefined;

    try {
      // Fetch latest drand beacon and derive dice
      const beacon = await latestBeacon();
      const proof = createDiceProof(beacon, whiteAddr, blackAddr, turnNumber);
      die1 = proof.dice[0];
      die2 = proof.dice[1];
      drandProof = { round: proof.drandRound, randomness: proof.drandRandomness, signature: proof.drandSignature };

      if (diceHistory) {
        diceHistory.addProof(proof);
      }
    } catch {
      // Fallback to random if drand is unreachable
      die1 = randomInt(1, 7);
      die2 = randomInt(1, 7);
    }

    game.gameState = setDice(game.gameState, die1, die2);

    const legalMoves = getLegalFirstMoves(
      game.gameState.board,
      game.gameState.currentPlayer,
      game.gameState.movesRemaining
    );

    // Start turn timer — player must always confirm, even with no legal moves
    this.startTurnTimer(game);

    void this.persistGame(game);

    return { dice: [die1, die2], gameState: game.gameState, legalMoves, drandProof };
  }

  async applyMoveLocked(gameId: string, playerAddress: string, from: number, to: number): Promise<{ move: Move; playerColor: Player; gameState: GameState; legalMoves: Move[]; turnAutoEnded: boolean } | null> {
    return this.withGameLock(gameId, () => this.applyMove(gameId, playerAddress, from, to));
  }

  applyMove(gameId: string, playerAddress: string, from: number, to: number): { move: Move; playerColor: Player; gameState: GameState; legalMoves: Move[]; turnAutoEnded: boolean } | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;

    const playerColor = this.getPlayerColor(game, playerAddress);
    // Allow moves when it's the player's turn OR when they have pendingConfirmation (undo then re-move)
    if (!playerColor || (playerColor !== game.gameState.currentPlayer && game.pendingConfirmation !== playerAddress)) return null;
    if (game.gameState.dice === null) return null;

    game.turnMoveStack.push(JSON.parse(JSON.stringify(game.gameState)));
    const newState = makeMove(game.gameState, from, to);
    if (!newState) return null;

    // Find which die was used
    const usedDieValues = game.gameState.movesRemaining.filter(
      (d, i) => !newState.movesRemaining.includes(d) ||
        game.gameState.movesRemaining.indexOf(d) !== newState.movesRemaining.indexOf(d)
    );
    const die = usedDieValues[0] || game.gameState.movesRemaining[0];

    const move: Move = { from, to, die };
    game.gameState = newState;

    // Get remaining legal moves
    const legalMoves = newState.movesRemaining.length > 0
      ? getLegalFirstMoves(newState.board, newState.currentPlayer, newState.movesRemaining)
      : [];

    // Check if game is over
    if (newState.gameOver) {
      game.status = "finished";
      this.clearTurnTimer(game);
      void this.deletePersistedGame(gameId);
    }

    // If turn auto-ended (currentPlayer changed), set pending confirmation
    const turnAutoEnded = newState.currentPlayer !== playerColor && !newState.gameOver;
    if (turnAutoEnded) {
      game.pendingConfirmation = playerAddress;
      // Don't clear timer — let it run for confirmation timeout
    }

    void this.persistGame(game);

    return { move, playerColor: playerColor!, gameState: game.gameState, legalMoves, turnAutoEnded };
  }

  async handleEndTurnLocked(gameId: string, playerAddress: string): Promise<GameState | null> {
    return this.withGameLock(gameId, () => this.handleEndTurn(gameId, playerAddress));
  }

  handleEndTurn(gameId: string, playerAddress: string): GameState | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;

    // Handle pendingConfirmation: player confirms the auto-ended turn
    if (game.pendingConfirmation === playerAddress) {
      game.pendingConfirmation = null;
      game.turnMoveStack = [];
      // Start timer for next player's roll phase (will be reset when they roll)
      this.startTurnTimer(game);
      void this.persistGame(game);
      return game.gameState;
    }

    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor || playerColor !== game.gameState.currentPlayer) return null;

    // Can only end turn if no legal moves remain or player has used their dice
    if (hasLegalMoves(game.gameState)) return null;

    game.turnMoveStack = [];
    game.gameState = endTurn(game.gameState);
    // Start timer for next player's roll phase (will be reset when they roll)
    this.startTurnTimer(game);

    void this.persistGame(game);

    return game.gameState;
  }

  async handleUndoLocked(gameId: string, playerAddress: string): Promise<{ gameState: GameState; legalMoves: Move[] } | null> {
    return this.withGameLock(gameId, () => this.handleUndo(gameId, playerAddress));
  }

  handleUndo(gameId: string, playerAddress: string): { gameState: GameState; legalMoves: Move[] } | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;

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
    }

    const legalMoves = getLegalFirstMoves(
      game.gameState.board,
      game.gameState.currentPlayer,
      game.gameState.movesRemaining
    );

    void this.persistGame(game);

    return { gameState: game.gameState, legalMoves };
  }

  handleDisconnect(address: string): { gameId: string; game: ServerGame } | null {
    const gameId = this.playerGames.get(address);
    if (!gameId) return null;

    const game = this.games.get(gameId);
    if (!game) return null;

    return { gameId, game };
  }

  handleReconnect(gameId: string, player: PlayerConnection): boolean {
    const game = this.games.get(gameId);
    if (!game) return false;

    if (game.playerWhite?.address === player.address) {
      game.playerWhite = player;
      return true;
    }
    if (game.playerBlack?.address === player.address) {
      game.playerBlack = player;
      return true;
    }
    return false;
  }

  /** Update a player's WebSocket to the one that sent a game message. */
  updatePlayerWs(gameId: string, address: string, ws: import("ws").WebSocket): void {
    const game = this.games.get(gameId);
    if (!game) return;
    if (game.playerWhite?.address === address && game.playerWhite.ws !== ws) {
      game.playerWhite.ws = ws;
    }
    if (game.playerBlack?.address === address && game.playerBlack.ws !== ws) {
      game.playerBlack.ws = ws;
    }
  }

  removeGame(gameId: string): void {
    const game = this.games.get(gameId);
    if (game) {
      this.clearTurnTimer(game);
      this.clearDoubleDepositTimer(game);
      if (game.playerWhite) this.playerGames.delete(game.playerWhite.address);
      if (game.playerBlack) this.playerGames.delete(game.playerBlack.address);
      this.games.delete(gameId);
      this.diceHistories.delete(gameId);
      this.gameLocks.delete(gameId);
      void this.deletePersistedGame(gameId);
    }
  }

  // ── Doubling Cube ─────────────────────────────────────────────

  handleOfferDouble(gameId: string, playerAddress: string): { player: Player; cubeValue: number } | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;
    if (!canDouble(game.gameState, playerColor)) return null;
    return { player: playerColor, cubeValue: game.gameState.cubeValue * 2 };
  }

  /** Accept double for free games (no wager). Mutates game state immediately. */
  handleAcceptDoubleFree(gameId: string, playerAddress: string): { cubeValue: number; cubeOwner: Player } | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;
    game.gameState = acceptDouble(game.gameState, playerColor);
    void this.persistGame(game);
    return { cubeValue: game.gameState.cubeValue, cubeOwner: game.gameState.cubeOwner! };
  }

  /** Accept double for wagered games — initiates escrow deposit flow.
   *  Returns info needed to start the deposit process. */
  async handleAcceptDoubleWagered(
    gameId: string,
    playerAddress: string,
  ): Promise<{
    cubeValue: number;
    cubeOwner: Player;
    additionalDeposit: string;
    doubler: string;
    responder: string;
  } | null> {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;

    const newCubeValue = game.gameState.cubeValue * 2;
    const doublerColor: Player = playerColor === "white" ? "black" : "white";
    const doublerAddress = doublerColor === "white"
      ? game.playerWhite?.address
      : game.playerBlack?.address;

    if (!doublerAddress) return null;

    // Call escrow contract to transition to AwaitingDoubleDeposits
    const escrow = getEscrowClient();
    if (!escrow) return null;

    const success = await escrow.offerDouble(gameId, doublerAddress, newCubeValue);
    if (!success) return null;

    // Calculate additional deposit: old_cube * wager
    const additionalDeposit = String(game.gameState.cubeValue * game.wagerAmount);

    // Track pending double deposit on the game
    game.pendingDoubleDeposit = {
      doubler: doublerAddress,
      responder: playerAddress,
      newCubeValue,
      additionalDeposit,
      doublerDeposited: false,
      responderDeposited: false,
      depositTimer: null,
    };
    game.escrowStatus = "awaiting_double_deposits";

    void this.persistGame(game);

    return {
      cubeValue: newCubeValue,
      cubeOwner: playerColor,
      additionalDeposit,
      doubler: doublerAddress,
      responder: playerAddress,
    };
  }

  /** Verify a double deposit and update tracking. Returns deposit status. */
  async verifyDoubleDeposit(
    gameId: string,
    playerAddress: string,
  ): Promise<{ depositsComplete: boolean; playerDeposited: boolean } | null> {
    const game = this.games.get(gameId);
    if (!game || !game.pendingDoubleDeposit) return null;

    const pending = game.pendingDoubleDeposit;
    if (playerAddress !== pending.doubler && playerAddress !== pending.responder) return null;

    // Query on-chain escrow to verify the deposit
    const escrow = getEscrowClient();
    if (!escrow) return null;

    const info = await escrow.queryEscrowStatus(gameId);
    if (!info || !info.pendingDouble) return null;

    // Update our tracking based on on-chain state
    pending.doublerDeposited = info.pendingDouble.doublerDeposited;
    pending.responderDeposited = info.pendingDouble.responderDeposited;

    const depositsComplete = pending.doublerDeposited && pending.responderDeposited;

    if (depositsComplete) {
      // Update game state with the accepted double
      const accepterColor = this.getPlayerColor(game, pending.responder);
      if (accepterColor) {
        game.gameState = acceptDouble(game.gameState, accepterColor);
      }
      // Clean up pending state
      this.clearDoubleDepositTimer(game);
      game.pendingDoubleDeposit = null;
      game.escrowStatus = "active";
      void this.persistGame(game);
    }

    return {
      depositsComplete,
      playerDeposited: playerAddress === pending.doubler
        ? pending.doublerDeposited
        : pending.responderDeposited,
    };
  }

  /** Start a timer for double deposit timeout (120s). */
  startDoubleDepositTimer(
    game: ServerGame,
    onTimeout: (gameId: string) => void,
  ): void {
    this.clearDoubleDepositTimer(game);
    if (!game.pendingDoubleDeposit) return;

    game.pendingDoubleDeposit.depositTimer = setTimeout(() => {
      if (game.pendingDoubleDeposit) {
        onTimeout(game.id);
      }
    }, DOUBLE_DEPOSIT_TIMEOUT_MS); // 120 seconds
  }

  /** Handle double deposit timeout — cancel pending double, refund deposits. */
  async handleDoubleDepositTimeout(gameId: string): Promise<void> {
    const game = this.games.get(gameId);
    if (!game || !game.pendingDoubleDeposit) return;

    // Cancel the escrow double on-chain (refunds happen in contract)
    const escrow = getEscrowClient();
    if (escrow) {
      await escrow.cancel(gameId);
    }

    this.clearDoubleDepositTimer(game);
    game.pendingDoubleDeposit = null;
    game.escrowStatus = "cancelled";

    this.broadcastToGame(game, {
      type: "double_deposit_timeout" as any,
      game_id: gameId,
      message: "Double deposit timed out. Reverting to pre-double state.",
    });

    void this.persistGame(game);
  }

  private clearDoubleDepositTimer(game: ServerGame): void {
    if (game.pendingDoubleDeposit?.depositTimer) {
      clearTimeout(game.pendingDoubleDeposit.depositTimer);
      game.pendingDoubleDeposit.depositTimer = null;
    }
  }

  handleRejectDouble(gameId: string, playerAddress: string): { winner: Player } | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;
    const result = rejectDouble(game.gameState, playerColor);
    game.gameState = result.state;
    game.status = "finished";
    this.clearTurnTimer(game);
    void this.deletePersistedGame(gameId);
    return { winner: result.winner };
  }

  /** Reject double for wagered games — settles escrow to doubler. */
  async handleRejectDoubleWagered(gameId: string, playerAddress: string): Promise<{ winner: Player } | null> {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;

    // Settle escrow: rejecter forfeits, doubler gets pot
    const escrow = getEscrowClient();
    if (escrow) {
      await escrow.rejectDouble(gameId, playerAddress);
    }

    const result = rejectDouble(game.gameState, playerColor);
    game.gameState = result.state;
    game.status = "finished";
    game.escrowStatus = "forfeited";
    this.clearTurnTimer(game);
    this.clearDoubleDepositTimer(game);
    game.pendingDoubleDeposit = null;
    void this.deletePersistedGame(gameId);
    return { winner: result.winner };
  }

  // ── Typed Resignation ─────────────────────────────────────────

  handleResignationTyped(
    gameId: string,
    playerAddress: string,
    resignType: "normal" | "gammon" | "backgammon" = "normal",
  ): { offered: boolean; winner?: Player; loser?: Player; resignType: string } | null {
    const game = this.games.get(gameId);
    if (!game || game.status !== "playing") return null;
    const playerColor = this.getPlayerColor(game, playerAddress);
    if (!playerColor) return null;

    // If resign type is not "normal", offer it for opponent to accept/reject
    if (resignType !== "normal") {
      game.pendingResignation = { player: playerAddress, resignType };
      return { offered: true, resignType };
    }

    // Normal resignation — immediate
    const winner: Player = playerColor === "white" ? "black" : "white";
    game.status = "finished";
    game.gameState = { ...game.gameState, gameOver: true, winner, resultType: "normal" };
    this.clearTurnTimer(game);
    void this.deletePersistedGame(gameId);
    return { offered: false, winner, loser: playerColor, resignType: "normal" };
  }

  handleAcceptResignation(gameId: string, playerAddress: string): { winner: Player; resultType: ResultType } | null {
    const game = this.games.get(gameId);
    if (!game || !game.pendingResignation) return null;
    const resigningColor = this.getPlayerColor(game, game.pendingResignation.player);
    const acceptingColor = this.getPlayerColor(game, playerAddress);
    if (!resigningColor || !acceptingColor || resigningColor === acceptingColor) return null;

    const winner = acceptingColor;
    const resultType = game.pendingResignation.resignType as ResultType;
    game.status = "finished";
    game.gameState = { ...game.gameState, gameOver: true, winner, resultType };
    game.pendingResignation = null;
    this.clearTurnTimer(game);
    void this.deletePersistedGame(gameId);
    return { winner, resultType };
  }

  handleRejectResignation(gameId: string, playerAddress: string): boolean {
    const game = this.games.get(gameId);
    if (!game || !game.pendingResignation) return false;
    const resigningColor = this.getPlayerColor(game, game.pendingResignation.player);
    const rejectingColor = this.getPlayerColor(game, playerAddress);
    if (!resigningColor || !rejectingColor || resigningColor === rejectingColor) return false;
    game.pendingResignation = null;
    return true;
  }

  // ── Escrow Integration ────────────────────────────────────────

  async createEscrowForGame(gameId: string, playerA: string, playerB: string, wagerAmount: number): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    const game = this.games.get(gameId);
    if (!game) return false;

    const [balA, balB] = await Promise.all([
      escrow.queryBalance(playerA),
      escrow.queryBalance(playerB),
    ]);
    if (parseInt(balA) < wagerAmount || parseInt(balB) < wagerAmount) return false;

    const created = await escrow.createEscrow(gameId, playerA, playerB, String(wagerAmount));
    if (created) {
      game.escrowStatus = "pending_deposits";
      void this.persistGame(game);
    }
    return created;
  }

  async settleEscrow(gameId: string, winner: string, _resultType: ResultType): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    const game = this.games.get(gameId);
    if (!game || game.escrowStatus !== "active") return false;

    // Contract now uses actual deposited amounts (cube-aware), no multiplier needed
    const settled = await escrow.settle(gameId, winner);
    if (settled) game.escrowStatus = "settled";
    return settled;
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

  private startTurnTimer(game: ServerGame): void {
    this.clearTurnTimer(game);
    game.turnTimer = setTimeout(() => {
      if (game.status === "playing" && !game.gameState.gameOver) {
        if (game.pendingConfirmation) {
          // Auto-confirm on timeout
          game.pendingConfirmation = null;
          game.turnMoveStack = [];
          // Start timer for next player's roll phase
          this.startTurnTimer(game);
          this.broadcastToGame(game, {
            type: "turn_ended",
            game_id: game.id,
            next_player: game.gameState.currentPlayer,
            game_state: game.gameState,
          });
        } else {
          game.turnMoveStack = [];
          game.gameState = endTurn(game.gameState);
          // Start timer for next player's roll phase
          this.startTurnTimer(game);
          this.broadcastToGame(game, {
            type: "turn_ended",
            game_id: game.id,
            next_player: game.gameState.currentPlayer,
            game_state: game.gameState,
          });
        }
      }
    }, game.turnTimeLimit * 1000);
  }

  private clearTurnTimer(game: ServerGame): void {
    if (game.turnTimer) {
      clearTimeout(game.turnTimer);
      game.turnTimer = null;
    }
  }

  startDisconnectGracePeriod(game: ServerGame, address: string, onForfeit?: (gameId: string, winner: Player, resultType: ResultType) => void): void {
    this.cancelDisconnectGracePeriod(game);
    game.disconnectedPlayer = address;
    game.disconnectedAt = Date.now();
    // Extend grace period to 120s when double deposits are pending (on-chain tx takes time)
    const graceSec = game.pendingDoubleDeposit ? DISCONNECT_GRACE_DOUBLE_SEC : DISCONNECT_GRACE_SEC;

    const opponent = game.playerWhite?.address === address ? game.playerBlack : game.playerWhite;
    if (opponent) {
      this.sendToPlayer(opponent, {
        type: "opponent_disconnecting",
        game_id: game.id,
        grace_seconds: graceSec,
      });
    }

    let elapsed = 0;
    game.disconnectTimer = setInterval(() => {
      elapsed += DISCONNECT_CHECK_INTERVAL_MS / 1000;
      const remaining = graceSec - elapsed;

      if (remaining <= 0) {
        // Grace period expired — forfeit
        this.cancelDisconnectGracePeriod(game);
        const disconnectedColor = this.getPlayerColor(game, address);
        if (disconnectedColor && game.status === "playing") {
          const winner: Player = disconnectedColor === "white" ? "black" : "white";
          game.status = "finished";
          game.gameState.gameOver = true;
          game.gameState.winner = winner;
          game.gameState.resultType = "normal";
          this.clearTurnTimer(game);
          void this.deletePersistedGame(game.id);
          if (onForfeit) {
            onForfeit(game.id, winner, "normal");
          } else {
            this.broadcastToGame(game, {
              type: "game_over",
              game_id: game.id,
              winner,
              result_type: "normal",
              game_state: game.gameState,
            });
          }
        }
      } else if (opponent) {
        this.sendToPlayer(opponent, {
          type: "disconnect_countdown",
          game_id: game.id,
          seconds_remaining: remaining,
        });
      }
    }, DISCONNECT_CHECK_INTERVAL_MS);
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
    if (game.playerWhite?.ws.readyState === 1) game.playerWhite.ws.send(data);
    if (game.playerBlack?.ws.readyState === 1) game.playerBlack.ws.send(data);
    for (const spec of game.spectators) {
      if (spec.ws.readyState === 1) spec.ws.send(data);
    }
  }

  sendToPlayer(player: PlayerConnection | null, message: ServerMessage): void {
    if (player?.ws.readyState === 1) {
      player.ws.send(JSON.stringify(message));
    }
  }
}
