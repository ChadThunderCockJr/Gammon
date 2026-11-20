import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionChallenge, requestOriginAllowed, trustedAuthorizationRpcUrl, verifySessionChallenge } from "../session.js";

function challengeRequest(origin: string) {
  const principal = `xion1${"a".repeat(38)}`;
  return {
    body: { principal, signer: principal },
    get: (name: string) => name === "origin" ? origin : undefined,
  };
}

function responseRecorder() {
  const record: { status: number; body: Record<string, unknown> | null } = { status: 200, body: null };
  const response = {
    status(code: number) {
      record.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      record.body = body;
      return response;
    },
  };
  return { record, response };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session and WebSocket origin policy", () => {
  it("fails closed in production without an explicit HTTPS allowlist", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS", "");

    expect(requestOriginAllowed(undefined)).toBe(false);
    expect(requestOriginAllowed("https://gammon.nyc")).toBe(false);
    expect(requestOriginAllowed("http://localhost:3000")).toBe(false);
  });

  it("accepts only exact HTTPS production origins", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS", "https://gammon.nyc, https://admin.gammon.nyc");

    expect(requestOriginAllowed("https://gammon.nyc")).toBe(true);
    expect(requestOriginAllowed("https://admin.gammon.nyc")).toBe(true);
    expect(requestOriginAllowed("http://gammon.nyc")).toBe(false);
    expect(requestOriginAllowed("https://gammon.nyc.attacker.example")).toBe(false);
    expect(requestOriginAllowed("https://gammon.nyc/")).toBe(false);
  });

  it("requires and embeds an explicit production authentication chain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS", "https://gammon.nyc");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("AUTH_CHAIN_ID", "");
    vi.stubEnv("VERUSD_CHAIN_ID", "");
    const unavailable = responseRecorder();

    createSessionChallenge(challengeRequest("https://gammon.nyc") as never, unavailable.response as never);

    expect(unavailable.record).toEqual({
      status: 503,
      body: { error: "authentication_not_configured" },
    });

    vi.stubEnv("AUTH_CHAIN_ID", "xion-mainnet-1");
    const configured = responseRecorder();
    createSessionChallenge(challengeRequest("https://gammon.nyc") as never, configured.response as never);

    expect(configured.record.status).toBe(200);
    expect(JSON.parse(String(configured.record.body?.message))).toMatchObject({
      chainId: "xion-mainnet-1",
      origin: "https://gammon.nyc",
    });

    vi.stubEnv("AUTH_CHAIN_ID", "xion-mainnet-2");
    const stale = responseRecorder();
    await verifySessionChallenge({
      body: {
        challengeToken: configured.record.body?.challengeToken,
        signature: "",
        publicKey: "",
      },
      get: (name: string) => name === "origin" ? "https://gammon.nyc" : undefined,
    } as never, stale.response as never);
    expect(stale.record).toEqual({
      status: 401,
      body: { error: "invalid_or_expired_challenge" },
    });
  });

  it("rejects an unapproved authentication RPC in paid production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FUNDS_MODE", "verusd_production");
    vi.stubEnv("VERUSD_RPC_URL", "https://approved-rpc.example");
    vi.stubEnv("VERUSD_APPROVED_RPC_URL", "https://approved-rpc.example");
    vi.stubEnv("AUTH_RPC_URL", "https://attacker-rpc.example");

    expect(trustedAuthorizationRpcUrl()).toBeNull();

    vi.stubEnv("AUTH_RPC_URL", "https://approved-rpc.example");
    expect(trustedAuthorizationRpcUrl()).toBe("https://approved-rpc.example");
  });

  it("requires an exact explicit approval for free-mode production delegation", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FUNDS_MODE", "free");
    vi.stubEnv("AUTH_RPC_URL", "https://auth-rpc.example");
    vi.stubEnv("AUTH_APPROVED_RPC_URL", "https://other-rpc.example");

    expect(trustedAuthorizationRpcUrl()).toBeNull();

    vi.stubEnv("AUTH_APPROVED_RPC_URL", "https://auth-rpc.example");
    expect(trustedAuthorizationRpcUrl()).toBe("https://auth-rpc.example");
  });

  it("keeps the local-development default without weakening production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOWED_ORIGINS", "");

    expect(requestOriginAllowed(undefined)).toBe(true);
    expect(requestOriginAllowed("http://localhost:3000")).toBe(true);
    expect(requestOriginAllowed("http://127.0.0.1:3000")).toBe(false);
  });
});
