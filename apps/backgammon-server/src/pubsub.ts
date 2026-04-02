/**
 * Redis pub/sub for cross-instance WebSocket message broadcasting.
 *
 * When running multiple server instances behind a load balancer,
 * WebSocket messages need to reach players on other instances.
 * This module publishes game events to Redis channels and subscribes
 * to them, forwarding messages to local WebSocket connections.
 *
 * Channel naming: "game:{gameId}" for game events, "global" for broadcasts.
 */

import { logger } from "./logger.js";

let pubClient: any = null;
let subClient: any = null;
let initialized = false;

type MessageHandler = (channel: string, message: string) => void;
const handlers: MessageHandler[] = [];

export async function initPubSub(): Promise<boolean> {
  if (initialized) return !!pubClient;
  initialized = true;

  try {
    const { getRedis } = await import("./redis.js");
    const redis = getRedis();
    if (!redis) {
      logger.warn("Redis not available — pub/sub disabled (single-instance mode)");
      return false;
    }

    // Create dedicated pub and sub clients (sub client can't do regular commands)
    pubClient = redis.duplicate();
    subClient = redis.duplicate();

    await pubClient.ping();
    await subClient.ping();

    subClient.on("message", (channel: string, message: string) => {
      for (const handler of handlers) {
        try {
          handler(channel, message);
        } catch (err) {
          logger.error("PubSub handler error", { channel, error: String(err) });
        }
      }
    });

    logger.info("Redis pub/sub initialized for multi-instance support");
    return true;
  } catch (err) {
    logger.error("Failed to initialize pub/sub", { error: String(err) });
    return false;
  }
}

/** Publish a message to a game channel */
export async function publishGameEvent(gameId: string, event: object): Promise<void> {
  if (!pubClient) return;
  try {
    await pubClient.publish(`game:${gameId}`, JSON.stringify(event));
  } catch (err) {
    logger.error("Failed to publish game event", { gameId, error: String(err) });
  }
}

/** Publish a global broadcast (e.g., online count updates) */
export async function publishGlobal(event: object): Promise<void> {
  if (!pubClient) return;
  try {
    await pubClient.publish("global", JSON.stringify(event));
  } catch (err) {
    logger.error("Failed to publish global event", { error: String(err) });
  }
}

/** Subscribe to a game channel (for players on this instance) */
export async function subscribeToGame(gameId: string): Promise<void> {
  if (!subClient) return;
  try {
    await subClient.subscribe(`game:${gameId}`);
  } catch (err) {
    logger.error("Failed to subscribe to game", { gameId, error: String(err) });
  }
}

/** Unsubscribe from a game channel */
export async function unsubscribeFromGame(gameId: string): Promise<void> {
  if (!subClient) return;
  try {
    await subClient.unsubscribe(`game:${gameId}`);
  } catch (err) {
    logger.error("Failed to unsubscribe from game", { gameId, error: String(err) });
  }
}

/** Subscribe to the global channel */
export async function subscribeGlobal(): Promise<void> {
  if (!subClient) return;
  try {
    await subClient.subscribe("global");
  } catch (err) {
    logger.error("Failed to subscribe to global", { error: String(err) });
  }
}

/** Register a handler for incoming pub/sub messages */
export function onMessage(handler: MessageHandler): () => void {
  handlers.push(handler);
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/** Graceful shutdown */
export async function closePubSub(): Promise<void> {
  if (subClient) { await subClient.quit().catch(() => {}); subClient = null; }
  if (pubClient) { await pubClient.quit().catch(() => {}); pubClient = null; }
}
