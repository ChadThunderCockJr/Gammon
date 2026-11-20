import { v4 as uuid } from "uuid";
import type { WebSocket } from "ws";
import type { ChallengeTerms, ClientMessage, ServerMessage, ServerGame } from "./types.js";
import * as store from "./social-store.js";
import * as durableStore from "./social-store-pg.js";
import { logger } from "./logger.js";
import { encryptSensitiveJson, sensitivePayloadHash } from "./finance-crypto.js";
import { sendWebSocketJson } from "./ws-send.js";
import { CHALLENGE_EXPIRY_SEC } from "./config.js";
import { publishGlobal } from "./pubsub.js";

interface DistributedChallengeEvent {
  readonly type: "friend_challenge" | "friend_challenge_accepted";
  readonly source: string;
  readonly recipient: string;
  readonly message: ServerMessage;
}

function isDistributedChallengeEvent(event: unknown): event is DistributedChallengeEvent {
  if (
    !event ||
    typeof event !== "object" ||
    !("type" in event) ||
    (event.type !== "friend_challenge" && event.type !== "friend_challenge_accepted")
  ) return false;
  if (!("source" in event) || typeof event.source !== "string") return false;
  if (!("recipient" in event) || typeof event.recipient !== "string") return false;
  return "message" in event && !!event.message && typeof event.message === "object" && "type" in event.message;
}

export class SocialManager {
  constructor(
    private connections: Map<WebSocket, { address: string; rating: number }>,
    private instanceId: string,
  ) {}

  private send(ws: WebSocket, msg: ServerMessage): boolean {
    return sendWebSocketJson(ws, msg);
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
      if (conn.address === address && this.send(ws, msg)) count++;
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
        return this.handleChallengeFriend(ws, address, msg.to_address, msg.config);
      case "accept_challenge":
        return this.handleAcceptChallenge(ws, address, msg.challenge_id);
      case "decline_challenge":
        return this.handleDeclineChallenge(ws, address, msg.challenge_id);
      case "block_user":
        return this.handleBlockUser(ws, address, msg.target_address, msg.request_id);
      case "unblock_user":
        return this.handleUnblockUser(ws, address, msg.target_address);
      case "report_user":
        return this.handleReportUser(ws, address, msg.target_address, msg.category, msg.description ?? "", msg.request_id);
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
  /** Durable replay makes challenge delivery independent of the notifying replica. */
  async replayChallenges(ws: WebSocket, address: string): Promise<void> {
    for (const challenge of await store.getPendingChallengesFor(address)) {
      this.send(ws, {
        type: "challenge_received",
        challenge_id: challenge.id,
        from_address: challenge.from,
        from_name: challenge.fromName,
        created_at: challenge.createdAt,
        expires_at: challenge.expiresAt,
        config: challenge.config,
      });
    }
    for (const challenge of await store.getAcceptedChallengesFor(address)) {
      if (!challenge.gameId) continue;
      this.send(ws, {
        type: "challenge_accepted",
        challenge_id: challenge.id,
        game_id: challenge.gameId,
      });
    }
  }
  deliverDistributedChallenge(event: unknown): void {
    if (!isDistributedChallengeEvent(event) || event.source === this.instanceId) return;
    this.sendToAll(event.recipient, event.message);
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

  private async handleSearchPlayers(ws: WebSocket, address: string, query: string): Promise<void> {
    if (query.length < 2 || query.length > 50) {
      this.send(ws, { type: "search_results", results: [] });
      return;
    }
    const results = await store.searchPlayers(query, address);
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
    const blockedUsers = await store.getBlockedUsers(address);
    const pendingChallenges = rawChallenges.map((challenge) => ({
      challenge_id: challenge.id,
      from_address: challenge.from,
      from_name: challenge.fromName,
      created_at: challenge.createdAt,
      expires_at: challenge.expiresAt,
      config: challenge.config,
    }));

    this.send(ws, {
      type: "friends_list",
      friends,
      incoming_requests: incomingRequests,
      outgoing_requests: outgoingRequests,
      blocked_users: blockedUsers,
      pending_challenges: pendingChallenges,
    });
  }

  private async handleSendFriendRequest(ws: WebSocket, address: string, toAddress: string): Promise<void> {
    if (address === toAddress) {
      this.send(ws, { type: "error", message: "Cannot friend yourself" });
      return;
    }

    if (await store.isBlockedEitherDirection(address, toAddress)) {
      this.send(ws, { type: "error", message: "You cannot contact this player" });
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
    if (await store.isBlockedEitherDirection(address, fromAddress)) {
      await store.removeFriendRequest(fromAddress, address);
      this.send(ws, { type: "error", message: "This friend request is unavailable" });
      return;
    }
    if (!(await store.acceptFriendRequest(fromAddress, address))) {
      this.send(ws, { type: "error", message: "Friend request no longer exists" });
      return;
    }

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

  private async handleBlockUser(ws: WebSocket, address: string, targetAddress: string, requestId: string): Promise<void> {
    if (address === targetAddress) {
      this.send(ws, { type: "error", message: "You cannot block yourself" });
      return;
    }
    if (!await store.blockUser(address, targetAddress)) {
      this.send(ws, { type: "error", message: "Could not block this player" });
      return;
    }
    this.send(ws, { type: "user_blocked", target_address: targetAddress, request_id: requestId });
    await this.handleGetFriends(ws, address);
    const targetWs = this.findWsByAddress(targetAddress);
    if (targetWs) {
      this.send(targetWs, { type: "friend_removed", address });
      await this.handleGetFriends(targetWs, targetAddress);
    }
  }

  private async handleUnblockUser(ws: WebSocket, address: string, targetAddress: string): Promise<void> {
    if (!await store.unblockUser(address, targetAddress)) {
      this.send(ws, { type: "error", message: "This player is not blocked" });
      return;
    }
    this.send(ws, { type: "user_unblocked", target_address: targetAddress });
    await this.handleGetFriends(ws, address);
  }

  private async handleReportUser(
    ws: WebSocket,
    address: string,
    targetAddress: string,
    category: "cheating" | "harassment" | "inappropriate_name" | "other",
    description: string,
    requestId: string,
  ): Promise<void> {
    if (address === targetAddress) {
      this.send(ws, { type: "error", message: "You cannot report yourself" });
      return;
    }
    if (description.length > 500) {
      this.send(ws, { type: "error", message: "Report description is too long" });
      return;
    }
    let report: { id: string } | null;
    try {
      const reportId = uuid();
      report = await store.createUserReport({
        id: reportId,
        reporter: address,
        requestId,
        target: targetAddress,
        category,
        payloadHash: sensitivePayloadHash({ target: targetAddress, category, description }),
        descriptionEncrypted: encryptSensitiveJson({ description }, reportId),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "REPORT_IDEMPOTENCY_CONFLICT") {
        this.send(ws, {
          type: "error",
          code: "REPORT_IDEMPOTENCY_CONFLICT",
          message: "This report request was already used with different details",
        });
        return;
      }
      if (error instanceof Error && error.message === "REPORT_RATE_LIMITED") {
        this.send(ws, {
          type: "error",
          code: "REPORT_RATE_LIMITED",
          message: "Too many reports submitted",
        });
        return;
      }
      this.send(ws, {
        type: "error",
        code: "REPORT_SUBMISSION_UNAVAILABLE",
        message: "Report submission is temporarily unavailable",
      });
      return;
    }
    if (!report) {
      this.send(ws, {
        type: "error",
        code: "REPORT_SUBMISSION_UNAVAILABLE",
        message: "Report submission is temporarily unavailable",
      });
      return;
    }
    this.send(ws, {
      type: "user_reported",
      target_address: targetAddress,
      report_id: report.id,
      request_id: requestId,
    });
  }

  private async handleGetActivity(ws: WebSocket, address: string): Promise<void> {
    const items = await store.getActivity(address);
    this.send(ws, { type: "activity_feed", items });
  }

  private async handleChallengeFriend(
    ws: WebSocket,
    address: string,
    toAddress: string,
    config: ChallengeTerms,
  ): Promise<void> {
    logger.info("Challenge requested", { from: address, to: toAddress });
    if (await store.isBlockedEitherDirection(address, toAddress)) {
      this.send(ws, { type: "error", message: "You cannot contact this player" });
      return;
    }

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
    const createdAt = Date.now();
    const challenge: store.Challenge = {
      id: challengeId,
      from: address,
      fromName: profile?.displayName || "",
      to: toAddress,
      createdAt,
      expiresAt: createdAt + CHALLENGE_EXPIRY_SEC * 1_000,
      config,
    };

    if (!await store.createChallenge(challenge)) {
      this.send(ws, { type: "error", message: "Could not create this challenge" });
      return;
    }
    logger.info("Challenge created", { challengeId, from: address, to: toAddress });

    const deliveredCount = this.sendToAll(toAddress, {
      type: "challenge_received",
      challenge_id: challengeId,
      from_address: address,
      from_name: profile?.displayName || "",
      created_at: challenge.createdAt,
      expires_at: challenge.expiresAt,
      config,
    });
    void publishGlobal({
      type: "friend_challenge",
      source: this.instanceId,
      recipient: toAddress,
      message: {
        type: "challenge_received",
        challenge_id: challengeId,
        from_address: address,
        from_name: profile?.displayName || "",
        created_at: challenge.createdAt,
        expires_at: challenge.expiresAt,
        config,
      },
    });
    if (deliveredCount > 0) {
      logger.info("Challenge delivered", { challengeId, to: toAddress, sockets: deliveredCount });
    } else {
      logger.warn("Challenge created but no open WebSocket found for target", { challengeId, to: toAddress });
    }
    this.send(ws, {
      type: "challenge_sent",
      challenge_id: challengeId,
      to_address: toAddress,
      to_name: (await store.getProfile(toAddress))?.displayName || "",
      created_at: challenge.createdAt,
      expires_at: challenge.expiresAt,
      config,
    });
  }

  private async handleAcceptChallenge(ws: WebSocket, address: string, challengeId: string): Promise<void> {
    logger.info("Accept challenge", { challengeId, address });
    const challenge = await store.acceptChallenge(challengeId, address, this.instanceId);
    if (!challenge?.gameId) {
      this.send(ws, { type: "error", message: "Challenge not found or expired" });
      return;
    }
    const acceptMsg: ServerMessage = {
      type: "challenge_accepted",
      challenge_id: challengeId,
      game_id: challenge.gameId,
    };
    this.sendToAll(challenge.to, acceptMsg);
    this.sendToAll(challenge.from, acceptMsg);
    logger.info("Challenge accepted and durably published", {
      challengeId,
      gameId: challenge.gameId,
      from: challenge.from,
      to: challenge.to,
    });
    for (const recipient of [challenge.from, challenge.to]) {
      void publishGlobal({
        type: "friend_challenge_accepted",
        source: this.instanceId,
        recipient,
        message: acceptMsg,
      });
    }
  }

  private async handleDeclineChallenge(ws: WebSocket, address: string, challengeId: string): Promise<void> {
    const challenge = await store.getChallenge(challengeId);
    if (!challenge || challenge.to !== address) return;
    await store.deleteChallenge(challengeId, address);
    this.send(ws, { type: "challenge_declined", challenge_id: challengeId });
    this.sendToAll(challenge.from, { type: "challenge_declined", challenge_id: challengeId });
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

  async recordMatchResult(
    game: ServerGame,
    winner: "white" | "black",
    resultType: string,
  ): Promise<void> {
    const whiteAddr = game.playerWhite?.address;
    const blackAddr = game.playerBlack?.address;
    if (!whiteAddr || !blackAddr) return;

    const [whiteProfile, blackProfile] = await Promise.all([
      store.getProfile(whiteAddr),
      store.getProfile(blackAddr),
    ]);
    const whiteName = whiteProfile?.displayName || whiteAddr.slice(0, 12);
    const blackName = blackProfile?.displayName || blackAddr.slice(0, 12);
    const wagerAmount = Number.isSafeInteger(game.wagerAmount) && game.wagerAmount >= 0
      ? BigInt(game.wagerAmount)
      : 0n;
    const committed = await durableStore.applyCompletedGameEffect({
      gameId: game.id,
      whiteAddress: whiteAddr,
      blackAddress: blackAddr,
      whiteName,
      blackName,
      winner,
      resultType,
      wagerAmount,
    });
    if (!committed.applied) return;

    const now = Date.now();
    if (winner === "white") {
      await Promise.all([
        store.addActivity(whiteAddr, { type: "match", text: `You defeated ${blackName}`, result: "W", timestamp: now }),
        store.addActivity(blackAddr, { type: "match", text: `${whiteName} defeated you`, result: "L", timestamp: now }),
      ]);
    } else {
      await Promise.all([
        store.addActivity(blackAddr, { type: "match", text: `You defeated ${whiteName}`, result: "W", timestamp: now }),
        store.addActivity(whiteAddr, { type: "match", text: `${blackName} defeated you`, result: "L", timestamp: now }),
      ]);
    }
  }
}
