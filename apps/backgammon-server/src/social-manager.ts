import { v4 as uuid } from "uuid";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, ServerGame } from "./types.js";
import type { GameManager } from "./game-manager.js";
import * as store from "./social-store.js";
import { logger } from "./logger.js";

export class SocialManager {
  constructor(
    private connections: Map<WebSocket, { address: string; rating: number }>,
    private gameManager: GameManager,
  ) {}

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  private findWsByAddress(address: string): WebSocket | null {
    let found: WebSocket | null = null;
    for (const [ws, conn] of this.connections) {
      if (conn.address === address && ws.readyState === 1) {
        found = ws; // keep iterating to get the latest connection
      }
    }
    return found;
  }

  /** Send a message to ALL open WebSockets for an address (handles multiple tabs/reconnects) */
  private sendToAll(address: string, msg: ServerMessage): number {
    let count = 0;
    for (const [ws, conn] of this.connections) {
      if (conn.address === address && ws.readyState === 1) {
        this.send(ws, msg);
        count++;
      }
    }
    return count;
  }

  async handle(ws: WebSocket, address: string, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "set_profile":
        return this.handleSetProfile(ws, address, msg.display_name);
      case "set_username":
        return this.handleSetUsername(ws, address, msg.username);
      case "search_players":
        return this.handleSearchPlayers(ws, address, msg.query);
      case "get_friends":
        return this.handleGetFriends(ws, address);
      case "send_friend_request":
        return this.handleSendFriendRequest(ws, address, msg.to_address);
      case "accept_friend_request":
        return this.handleAcceptFriendRequest(ws, address, msg.from_address);
      case "reject_friend_request":
        return this.handleRejectFriendRequest(ws, address, msg.from_address);
      case "remove_friend":
        return this.handleRemoveFriend(ws, address, msg.address);
      case "get_activity":
        return this.handleGetActivity(ws, address);
      case "challenge_friend":
        return this.handleChallengeFriend(ws, address, msg.to_address);
      case "accept_challenge":
        return this.handleAcceptChallenge(ws, address, msg.challenge_id);
      case "decline_challenge":
        return this.handleDeclineChallenge(ws, address, msg.challenge_id);
    }
  }

  /** Send the user's current profile on connect (called from index.ts after auth) */
  async sendProfile(ws: WebSocket, address: string): Promise<void> {
    const profile = await store.getProfile(address);
    // Send username first so client has it before profile_updated triggers the UI gate
    if (profile?.username) {
      this.send(ws, { type: "username_set", username: profile.username });
    }
    this.send(ws, {
      type: "profile_updated",
      address,
      display_name: profile?.displayName || "",
    });
  }

  private async handleSetUsername(ws: WebSocket, address: string, username: string): Promise<void> {
    const result = await store.setUsername(address, username);
    if (result.ok) {
      this.send(ws, { type: "username_set", username });
      // Also update display name if it was empty
      const profile = await store.getProfile(address);
      this.send(ws, { type: "profile_updated", address, display_name: profile?.displayName || username });
    } else {
      this.send(ws, { type: "username_error", message: result.error || "Failed to set username" });
    }
  }

  private async handleSearchPlayers(ws: WebSocket, _address: string, query: string): Promise<void> {
    if (query.length < 2 || query.length > 50) {
      this.send(ws, { type: "search_results", results: [] });
      return;
    }
    const results = await store.searchPlayers(query);
    this.send(ws, { type: "search_results", results });
  }

  private async handleSetProfile(ws: WebSocket, address: string, displayName: string): Promise<void> {
    // Validate display name
    if (typeof displayName !== "string" || displayName.length < 1 || displayName.length > 30) {
      this.send(ws, { type: "error", message: "Display name must be 1-30 characters" });
      return;
    }
    // Strip control characters
    const sanitized = displayName.replace(/[\x00-\x1F\x7F]/g, "").trim();
    if (sanitized.length < 1) {
      this.send(ws, { type: "error", message: "Display name cannot be empty" });
      return;
    }
    await store.setProfile(address, sanitized);
    this.send(ws, { type: "profile_updated", address, display_name: sanitized });
  }

  private async handleGetFriends(ws: WebSocket, address: string): Promise<void> {
    const friendAddresses = await store.getFriends(address);
    const friends = await Promise.all(
      friendAddresses.map(async (addr) => {
        const profile = await store.getProfile(addr);
        const online = await store.isOnline(addr);
        return {
          address: addr,
          displayName: profile?.displayName || "",
          online,
        };
      }),
    );

    const incomingAddresses = await store.getIncomingRequests(address);
    const incomingRequests = await Promise.all(
      incomingAddresses.map(async (addr) => {
        const profile = await store.getProfile(addr);
        return { address: addr, displayName: profile?.displayName || "" };
      }),
    );

    const outgoingRequests = await store.getOutgoingRequests(address);

    const rawChallenges = await store.getPendingChallengesFor(address);
    const pendingChallenges = rawChallenges.map((c) => ({
      challenge_id: c.id,
      from_address: c.from,
      from_name: c.fromName,
    }));

    this.send(ws, {
      type: "friends_list",
      friends,
      incoming_requests: incomingRequests,
      outgoing_requests: outgoingRequests,
      pending_challenges: pendingChallenges,
    });
  }

  private async handleSendFriendRequest(ws: WebSocket, address: string, toAddress: string): Promise<void> {
    if (address === toAddress) {
      this.send(ws, { type: "error", message: "Cannot friend yourself" });
      return;
    }

    const alreadyFriends = await store.areFriends(address, toAddress);
    if (alreadyFriends) {
      this.send(ws, { type: "error", message: "Already friends" });
      return;
    }

    const alreadyPending = await store.hasPendingRequest(address, toAddress);
    if (alreadyPending) {
      this.send(ws, { type: "error", message: "Request already sent" });
      return;
    }

    // Check if they already sent us a request — auto-accept
    const theyRequested = await store.hasPendingRequest(toAddress, address);
    if (theyRequested) {
      return this.handleAcceptFriendRequest(ws, address, toAddress);
    }

    await store.ensureProfile(toAddress);
    await store.sendFriendRequest(address, toAddress);

    // Notify target if online
    const targetWs = this.findWsByAddress(toAddress);
    if (targetWs) {
      const profile = await store.getProfile(address);
      this.send(targetWs, {
        type: "friend_request_received",
        from_address: address,
        from_name: profile?.displayName || "",
      });
    }

    // Refresh sender's friend list
    await this.handleGetFriends(ws, address);
  }

  private async handleAcceptFriendRequest(ws: WebSocket, address: string, fromAddress: string): Promise<void> {
    await store.removeFriendRequest(fromAddress, address);
    await store.addFriend(address, fromAddress);

    const now = Date.now();
    const myProfile = await store.getProfile(address);
    const theirProfile = await store.getProfile(fromAddress);

    // Activity for both
    await store.addActivity(address, {
      type: "friend_added",
      text: `You became friends with ${theirProfile?.displayName || fromAddress.slice(0, 12)}`,
      timestamp: now,
    });
    await store.addActivity(fromAddress, {
      type: "friend_added",
      text: `You became friends with ${myProfile?.displayName || address.slice(0, 12)}`,
      timestamp: now,
    });

    // Notify the requester if online
    const requesterWs = this.findWsByAddress(fromAddress);
    if (requesterWs) {
      this.send(requesterWs, {
        type: "friend_request_accepted",
        address,
        display_name: myProfile?.displayName || "",
      });
      // Also refresh their friends list
      await this.handleGetFriends(requesterWs, fromAddress);
    }

    // Refresh acceptor's friend list
    await this.handleGetFriends(ws, address);
  }

  private async handleRejectFriendRequest(ws: WebSocket, address: string, fromAddress: string): Promise<void> {
    await store.removeFriendRequest(fromAddress, address);
    await this.handleGetFriends(ws, address);
  }

  private async handleRemoveFriend(ws: WebSocket, address: string, friendAddress: string): Promise<void> {
    await store.removeFriend(address, friendAddress);

    // Notify the other party if online
    const friendWs = this.findWsByAddress(friendAddress);
    if (friendWs) {
      this.send(friendWs, { type: "friend_removed", address });
      await this.handleGetFriends(friendWs, friendAddress);
    }

    await this.handleGetFriends(ws, address);
  }

  private async handleGetActivity(ws: WebSocket, address: string): Promise<void> {
    const items = await store.getActivity(address);
    this.send(ws, { type: "activity_feed", items });
  }

  private async handleChallengeFriend(ws: WebSocket, address: string, toAddress: string): Promise<void> {
    logger.info("Challenge requested", { from: address, to: toAddress });

    const areFriends = await store.areFriends(address, toAddress);
    if (!areFriends) {
      logger.warn("Challenge rejected: not friends", { from: address, to: toAddress });
      this.send(ws, { type: "error", message: "Not friends with this player" });
      return;
    }

    const online = await store.isOnline(toAddress);
    if (!online) {
      logger.warn("Challenge rejected: target offline", { from: address, to: toAddress });
      this.send(ws, { type: "error", message: "Player is offline" });
      return;
    }

    const profile = await store.getProfile(address);
    const challengeId = uuid();
    const challenge: store.Challenge = {
      id: challengeId,
      from: address,
      fromName: profile?.displayName || "",
      to: toAddress,
      createdAt: Date.now(),
    };

    await store.createChallenge(challenge);
    logger.info("Challenge created", { challengeId, from: address, to: toAddress });

    const deliveredCount = this.sendToAll(toAddress, {
      type: "challenge_received",
      challenge_id: challengeId,
      from_address: address,
      from_name: profile?.displayName || "",
    });
    if (deliveredCount > 0) {
      logger.info("Challenge delivered", { challengeId, to: toAddress, sockets: deliveredCount });
    } else {
      logger.warn("Challenge created but no open WebSocket found for target", { challengeId, to: toAddress });
    }
  }

  private async handleAcceptChallenge(ws: WebSocket, address: string, challengeId: string): Promise<void> {
    logger.info("Accept challenge", { challengeId, address });
    const challenge = await store.getChallenge(challengeId);
    if (!challenge || challenge.to !== address) {
      logger.warn("Challenge not found or expired", { challengeId, address, found: !!challenge });
      this.send(ws, { type: "error", message: "Challenge not found or expired" });
      return;
    }

    await store.deleteChallenge(challengeId);

    // Create a game and join both players
    const game = this.gameManager.createGame(0);
    const challengerWs = this.findWsByAddress(challenge.from);
    const conn = this.connections.get(ws);
    logger.info("Creating game for challenge", { gameId: game.id, challengerFound: !!challengerWs, acceptorFound: !!conn });

    // Don't join players to the game yet — they need to connect via the game
    // WebSocket first (useGame hook). Just notify both sides to navigate.
    const acceptMsg: ServerMessage = {
      type: "challenge_accepted",
      challenge_id: challengeId,
      game_id: game.id,
    };

    // Notify the acceptor
    this.send(ws, acceptMsg);

    // Notify the challenger
    this.sendToAll(challenge.from, acceptMsg);

    logger.info("Challenge accepted, game created", { challengeId, gameId: game.id, from: challenge.from, to: address });
  }

  private async handleDeclineChallenge(ws: WebSocket, address: string, challengeId: string): Promise<void> {
    const challenge = await store.getChallenge(challengeId);
    if (!challenge || challenge.to !== address) return;

    await store.deleteChallenge(challengeId);

    const challengerWs = this.findWsByAddress(challenge.from);
    if (challengerWs) {
      this.send(challengerWs, { type: "challenge_declined", challenge_id: challengeId });
    }
  }

  // ── Presence Broadcasting ──────────────────────────────────────

  async broadcastPresence(address: string, status: "online" | "offline"): Promise<void> {
    const friends = await store.getFriends(address);
    const msgType = status === "online" ? "friend_online" : "friend_offline";

    for (const friendAddr of friends) {
      const friendWs = this.findWsByAddress(friendAddr);
      if (friendWs) {
        this.send(friendWs, { type: msgType, address });
      }
    }
  }

  // ── Match Result Recording ─────────────────────────────────────

  async recordMatchResult(game: ServerGame, winner: string, resultType: string): Promise<void> {
    const whiteAddr = game.playerWhite?.address;
    const blackAddr = game.playerBlack?.address;
    if (!whiteAddr || !blackAddr) return;

    const now = Date.now();
    const whiteProfile = await store.getProfile(whiteAddr);
    const blackProfile = await store.getProfile(blackAddr);
    const whiteName = whiteProfile?.displayName || whiteAddr.slice(0, 12);
    const blackName = blackProfile?.displayName || blackAddr.slice(0, 12);

    // Record for white
    await store.recordMatchResult(whiteAddr, {
      gameId: game.id,
      opponent: blackAddr,
      opponentName: blackName,
      result: winner === "white" ? "W" : "L",
      resultType,
      timestamp: now,
    });

    // Record for black
    await store.recordMatchResult(blackAddr, {
      gameId: game.id,
      opponent: whiteAddr,
      opponentName: whiteName,
      result: winner === "black" ? "W" : "L",
      resultType,
      timestamp: now,
    });

    // Update ratings and stats
    const winnerAddr = winner === "white" ? whiteAddr : blackAddr;
    const loserAddr = winner === "white" ? blackAddr : whiteAddr;
    await store.updateRatings(winnerAddr, loserAddr, resultType);
    await store.updateStats(winnerAddr, "W");
    await store.updateStats(loserAddr, "L");

    // Activity entries
    if (winner === "white") {
      await store.addActivity(whiteAddr, {
        type: "match",
        text: `You defeated ${blackName}`,
        result: "W",
        timestamp: now,
      });
      await store.addActivity(blackAddr, {
        type: "match",
        text: `${whiteName} defeated you`,
        result: "L",
        timestamp: now,
      });
    } else {
      await store.addActivity(blackAddr, {
        type: "match",
        text: `You defeated ${whiteName}`,
        result: "W",
        timestamp: now,
      });
      await store.addActivity(whiteAddr, {
        type: "match",
        text: `${blackName} defeated you`,
        result: "L",
        timestamp: now,
      });
    }
  }
}
