import {
  createMatch,
  scoreGame as applyGameScore,
  isMatchOver,
  isCrawfordGame,
  type MatchState,
  type Player,
  type ResultType,
} from "@xion-beginner/backgammon-core";
import {
  createDurableMatch,
  loadDurableMatch,
  loadDurableMatches,
  scoreDurableMatchGame,
  setDurableCurrentGame,
  type DurableMatchScore,
} from "./match-store.js";

export interface ServerMatch {
  id: string;
  matchState: MatchState;
  currentGameId: string;
  playerWhiteAddress: string;
  playerBlackAddress: string;
  wagerAmount: number;
  status: "playing" | "finished";
}

export class MatchManager {
  private matches = new Map<string, ServerMatch>();
  private gameToMatch = new Map<string, string>(); // gameId -> matchId
  private scoredGames = new Map<string, DurableMatchScore>();

  async createMatch(
    matchId: string,
    matchLength: number,
    playerWhite: string,
    playerBlack: string,
    initialGameId: string,
    wagerAmount: number = 0,
  ): Promise<ServerMatch> {
    if (wagerAmount !== 0) throw new Error("PAID_MATCH_UNSUPPORTED");
    const match: ServerMatch = {
      id: matchId,
      matchState: createMatch(matchLength),
      currentGameId: initialGameId,
      playerWhiteAddress: playerWhite,
      playerBlackAddress: playerBlack,
      wagerAmount,
      status: "playing",
    };
    await createDurableMatch(match);
    this.matches.set(matchId, match);
    this.gameToMatch.set(initialGameId, matchId);
    return match;
  }

  getMatch(matchId: string): ServerMatch | undefined {
    return this.matches.get(matchId);
  }

  async hydrateMatch(matchId: string): Promise<ServerMatch | undefined> {
    const stored = await loadDurableMatch(matchId);
    if (!stored) return undefined;
    const { gameIds, ...match } = stored;
    this.matches.set(match.id, match);
    for (const gameId of gameIds) this.gameToMatch.set(gameId, match.id);
    return match;
  }

  getMatchForGame(gameId: string): ServerMatch | undefined {
    const matchId = this.gameToMatch.get(gameId);
    if (!matchId) return undefined;
    return this.matches.get(matchId);
  }

  /** Score a completed game within a match. Returns match result info. */
  async scoreGame(
    gameId: string,
    winner: Player,
    resultType: ResultType,
    cubeValue: number,
  ): Promise<DurableMatchScore | null> {
    const durable = await scoreDurableMatchGame(gameId, winner, resultType, cubeValue);
    if (durable !== undefined) {
      if (!durable) return null;
      const matchId = this.gameToMatch.get(gameId);
      const match = matchId ? this.matches.get(matchId) : undefined;
      if (match) {
        match.matchState = durable.matchState;
        match.status = durable.matchOver ? "finished" : "playing";
      }
      return durable;
    }

    const replay = this.scoredGames.get(gameId);
    if (replay) return { ...replay, applied: false };
    const matchId = this.gameToMatch.get(gameId);
    if (!matchId) return null;
    const match = this.matches.get(matchId);
    if (!match || match.status !== "playing") return null;
    match.matchState = applyGameScore(match.matchState, winner, resultType, cubeValue);
    const result = isMatchOver(match.matchState);
    if (result.over) match.status = "finished";
    const score: DurableMatchScore = {
      matchOver: result.over,
      matchWinner: result.winner,
      matchState: match.matchState,
      isCrawfordNext: isCrawfordGame(match.matchState),
      continuationDurable: false,
      applied: true,
    };
    this.scoredGames.set(gameId, score);
    return score;
  }

  /** Set the current game ID for the next game in the match */
  async setCurrentGame(matchId: string, gameId: string): Promise<void> {
    const match = this.matches.get(matchId);
    if (!match) throw new Error("MATCH_NOT_FOUND");
    await setDurableCurrentGame(matchId, gameId);
    match.currentGameId = gameId;
    this.gameToMatch.set(gameId, matchId);
  }

  async restoreMatches(): Promise<number> {
    const matches = await loadDurableMatches();
    for (const stored of matches) {
      const { gameIds, ...match } = stored;
      this.matches.set(match.id, match);
      for (const gameId of gameIds) this.gameToMatch.set(gameId, match.id);
    }
    return matches.length;
  }

  /** Check if doubling is allowed (Crawford rule) */
  isDoublingAllowed(gameId: string): boolean {
    const match = this.getMatchForGame(gameId);
    if (!match) return true; // not a match game, doubling allowed
    return !isCrawfordGame(match.matchState);
  }

  removeMatch(matchId: string): void {
    const match = this.matches.get(matchId);
    if (match) {
      // Clean up game-to-match mappings
      for (const [gId, mId] of this.gameToMatch) {
        if (mId === matchId) this.gameToMatch.delete(gId);
      }
      this.matches.delete(matchId);
    }
  }
}
