import Redis from "ioredis";
import { REDIS_MAX_RETRIES, REDIS_RETRY_DELAY_MIN_MS, REDIS_RETRY_DELAY_MAX_MS } from "./config.js";
import { logger } from "./logger.js";


let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > REDIS_MAX_RETRIES) return null; // stop retrying
        return Math.min(times * REDIS_RETRY_DELAY_MIN_MS, REDIS_RETRY_DELAY_MAX_MS);
      },
    });

    redis.on("error", (err) => {
      logger.error("Redis connection error", { errorCode: err.name });
    });

    redis.on("connect", () => {
      logger.info("Redis connected");
    });

    redis.connect().catch(() => {
      logger.warn("Redis initial connection failed; disposable features are unavailable");
    });

    return redis;
  } catch (err) {
    logger.error("Failed to create Redis client", {
      errorCode: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
