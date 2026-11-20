import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { getRedis } from "./redis.js";

interface RateLimitOptions {
  readonly scope: string;
  readonly max: number;
  readonly windowMs: number;
  readonly identity?: (request: Request) => string;
}

interface LocalCounter {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function trustedWebSocketClientIp(
  request: Pick<IncomingMessage, "headers" | "socket">,
): string {
  const flyClientIp = request.headers["fly-client-ip"];
  if (process.env.FLY_APP_NAME && typeof flyClientIp === "string" && isIP(flyClientIp) !== 0) {
    return flyClientIp;
  }
  const directPeer = request.socket.remoteAddress;
  return directPeer && isIP(directPeer) !== 0 ? directPeer : "unknown";
}

function validate(options: Pick<RateLimitOptions, "scope" | "max" | "windowMs">): void {
  if (!/^[a-z0-9_-]+$/i.test(options.scope)) throw new TypeError("Invalid rate-limit scope");
  if (!Number.isSafeInteger(options.max) || options.max <= 0) throw new RangeError("Invalid rate-limit maximum");
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) throw new RangeError("Invalid rate-limit window");
}

async function consume(
  options: Pick<RateLimitOptions, "scope" | "max" | "windowMs">,
  identity: string,
  local: Map<string, LocalCounter>,
  requireShared = false,
): Promise<RateLimitResult> {
  const now = Date.now();
  const subject = digest(identity);
  const bucket = Math.floor(now / options.windowMs);
  const redisKey = `rate:${options.scope}:${subject}:${bucket}`;
  const localKey = `${options.scope}:${subject}`;
  let count: number | null = null;

  const redis = getRedis();
  if (redis?.status === "ready") {
    try {
      const result = await redis
        .multi()
        .incr(redisKey)
        .pexpire(redisKey, options.windowMs * 2)
        .exec();
      const increment = result?.[0];
      if (increment && increment[0] === null && typeof increment[1] === "number") {
        count = increment[1];
      }
    } catch {
      count = null;
    }
  }

  const resetAt = (bucket + 1) * options.windowMs;
  if (count === null && requireShared) {
    return { allowed: false, remaining: 0, resetAt };
  }
  if (count === null) {
    const current = local.get(localKey);
    if (!current || current.resetAt <= now) {
      count = 1;
      local.set(localKey, { count, resetAt });
    } else {
      current.count += 1;
      count = current.count;
    }
    if (local.size > 10_000) {
      for (const [entryKey, entry] of local) {
        if (entry.resetAt <= now) local.delete(entryKey);
      }
    }
  }

  return {
    allowed: count <= options.max,
    remaining: Math.max(0, options.max - count),
    resetAt,
  };
}

const sharedLocalCounters = new Map<string, LocalCounter>();

export async function consumeRateLimit(input: {
  readonly scope: string;
  readonly identity: string;
  readonly max: number;
  readonly windowMs: number;
}): Promise<RateLimitResult> {
  validate(input);
  return consume(input, input.identity, sharedLocalCounters);
}

export async function consumeDistributedRateLimit(input: {
  readonly scope: string;
  readonly identity: string;
  readonly max: number;
  readonly windowMs: number;
}): Promise<RateLimitResult> {
  validate(input);
  return consume(input, input.identity, sharedLocalCounters, true);
}

const CONCURRENCY_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 2)
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 2)
return 1
`;
const localConcurrency = new Map<string, Map<string, number>>();

export async function claimConcurrencyLease(input: {
  readonly scope: string;
  readonly identity: string;
  readonly token: string;
  readonly max: number;
  readonly ttlMs: number;
}): Promise<boolean> {
  validate({ scope: input.scope, max: input.max, windowMs: input.ttlMs });
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(input.token)) throw new TypeError("Invalid concurrency token");
  const key = `concurrency:${input.scope}:${digest(input.identity)}`;
  const now = Date.now();
  const expiresAt = now + input.ttlMs;
  const redis = getRedis();
  if (redis?.status === "ready") {
    try {
      const result = await redis.eval(
        CONCURRENCY_SCRIPT,
        1,
        key,
        now,
        expiresAt,
        input.token,
        input.ttlMs,
        input.max,
      );
      return Number(result) === 1;
    } catch {
      if (process.env.NODE_ENV === "production") return false;
    }
  } else if (process.env.NODE_ENV === "production") {
    return false;
  }

  const leases = localConcurrency.get(key) ?? new Map<string, number>();
  for (const [token, expiry] of leases) {
    if (expiry <= now) leases.delete(token);
  }
  if (!leases.has(input.token) && leases.size >= input.max) return false;
  leases.set(input.token, expiresAt);
  localConcurrency.set(key, leases);
  return true;
}

export async function releaseConcurrencyLease(input: {
  readonly scope: string;
  readonly identity: string;
  readonly token: string;
}): Promise<void> {
  const key = `concurrency:${input.scope}:${digest(input.identity)}`;
  const redis = getRedis();
  if (redis?.status === "ready") {
    await redis.zrem(key, input.token).catch(() => undefined);
  }
  const leases = localConcurrency.get(key);
  leases?.delete(input.token);
  if (leases?.size === 0) localConcurrency.delete(key);
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  validate(options);
  const local = new Map<string, LocalCounter>();

  return async (request, response, next) => {
    const identity = options.identity?.(request)
      ?? request.ip
      ?? request.socket.remoteAddress
      ?? "unknown";
    const result = await consume(options, identity, local);
    response.setHeader("RateLimit-Limit", String(options.max));
    response.setHeader("RateLimit-Remaining", String(result.remaining));
    response.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1_000)));
    if (!result.allowed) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000))));
      response.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }
    next();
  };
}
