import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../redis.js", () => ({ getRedis: () => null }));

import { consumeRateLimit, createRateLimiter, trustedWebSocketClientIp } from "../rate-limit.js";

function responseDouble() {
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    body: null as unknown,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { response, headers };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("rejects requests after the configured per-identity maximum", async () => {
    const limiter = createRateLimiter({ scope: "test", max: 2, windowMs: 60_000 });
    const run = limiter as unknown as (
      request: { ip: string; socket: { remoteAddress: string } },
      response: ReturnType<typeof responseDouble>["response"],
      next: () => void,
    ) => Promise<void>;
    const request = { ip: "203.0.113.1", socket: { remoteAddress: "127.0.0.1" } };
    const first = responseDouble();
    const second = responseDouble();
    const third = responseDouble();
    const next = vi.fn();

    await run(request, first.response, next);
    await run(request, second.response, next);
    await run(request, third.response, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(third.response.statusCode).toBe(429);
    expect(third.response.body).toEqual({ error: "rate_limit_exceeded" });
    expect(third.headers.get("Retry-After")).toBeTruthy();
  });

  it("uses independent counters for different identities", async () => {
    const limiter = createRateLimiter({ scope: "isolation", max: 1, windowMs: 60_000 });
    const run = limiter as unknown as (
      request: { ip: string; socket: { remoteAddress: string } },
      response: ReturnType<typeof responseDouble>["response"],
      next: () => void,
    ) => Promise<void>;
    const next = vi.fn();

    await run({ ip: "203.0.113.2", socket: { remoteAddress: "127.0.0.1" } }, responseDouble().response, next);
    await run({ ip: "203.0.113.3", socket: { remoteAddress: "127.0.0.1" } }, responseDouble().response, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("shares WebSocket counters by scope and identity", async () => {
    const first = await consumeRateLimit({
      scope: "ws_test_shared",
      identity: "xion1player",
      max: 1,
      windowMs: 60_000,
    });
    const second = await consumeRateLimit({
      scope: "ws_test_shared",
      identity: "xion1player",
      max: 1,
      windowMs: 60_000,
    });
    const otherPrincipal = await consumeRateLimit({
      scope: "ws_test_shared",
      identity: "xion1other",
      max: 1,
      windowMs: 60_000,
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(otherPrincipal.allowed).toBe(true);
  });

  it("isolates Fly WebSocket clients without trusting spoofable forwarded chains", async () => {
    vi.stubEnv("FLY_APP_NAME", "gammon-server");
    const request = (clientIp: string, forwardedFor: string) => ({
      headers: { "fly-client-ip": clientIp, "x-forwarded-for": forwardedFor },
      socket: { remoteAddress: "fdaa::3" },
    });
    const firstIdentity = trustedWebSocketClientIp(request("203.0.113.10", "198.51.100.200, 203.0.113.99") as never);
    const secondIdentity = trustedWebSocketClientIp(request("203.0.113.11", "198.51.100.200, 203.0.113.99") as never);
    const spoofedChainIdentity = trustedWebSocketClientIp(request("203.0.113.10", "192.0.2.123, 198.51.100.200, 203.0.113.99") as never);

    expect(firstIdentity).toBe("203.0.113.10");
    expect(secondIdentity).toBe("203.0.113.11");
    expect(spoofedChainIdentity).toBe(firstIdentity);
    expect((await consumeRateLimit({
      scope: "ws_fly_client_a",
      identity: firstIdentity,
      max: 1,
      windowMs: 60_000,
    })).allowed).toBe(true);
    expect((await consumeRateLimit({
      scope: "ws_fly_client_a",
      identity: secondIdentity,
      max: 1,
      windowMs: 60_000,
    })).allowed).toBe(true);
  });

  it("ignores Fly headers outside a Fly runtime", () => {
    vi.stubEnv("FLY_APP_NAME", "");
    expect(trustedWebSocketClientIp({
      headers: { "fly-client-ip": "203.0.113.10" },
      socket: { remoteAddress: "127.0.0.1" },
    } as never)).toBe("127.0.0.1");
  });
});
