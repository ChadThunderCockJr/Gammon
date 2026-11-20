import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../finance-crypto.js";
import { SettlementAuthorizerClient, SettlementAuthorizerError } from "../settlement-authorizer.js";

const contract = `xion1${"q".repeat(38)}`;
const signingKeyId = "authorizer-key-v1";
const input = {
  gameId: "6c4ab252-8785-4caf-993a-5e1dcf8a9d98",
  winner: `xion1${"p".repeat(38)}`,
  resultMultiplier: 2 as const,
  cubeValue: 4 as const,
  cubeWasTurned: true,
  settlementId: "37ea79f9-8c1a-4c79-a429-7d637cfe9789",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettlementAuthorizerClient", () => {
  it("accepts only a response signed over the canonical request hash and normalized transaction hash", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const txHash = "ab".repeat(32);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      const requestHash = createHash("sha256").update(body).digest("hex");
      const signature = sign(
        null,
        Buffer.from(canonicalJson({ contract, requestHash, signingKeyId, txHash: txHash.toUpperCase() })),
        privateKey,
      ).toString("base64url");
      return new Response(JSON.stringify({ txHash }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-response-signature-ed25519": signature,
          "x-signing-key-id": signingKeyId,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SettlementAuthorizerClient(
      "https://authorizer.example.test/",
      "secret",
      contract,
      publicKeyDer,
      signingKeyId,
    );

    const result = await client.settleGame(input, "settle-idempotency-key");

    expect(result.txHash).toBe(txHash.toUpperCase());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://authorizer.example.test/v1/escrow/settlements");
    expect(request?.body).toBe(canonicalJson({ contract, ...input }));
    expect(request?.headers).toMatchObject({
      authorization: "Bearer secret",
      "idempotency-key": "settle-idempotency-key",
      "x-request-sha256": result.requestHash,
    });
  });

  it("rejects an unsigned successful response as a non-retryable protocol violation", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ txHash: "ab".repeat(32) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const client = new SettlementAuthorizerClient(
      "https://authorizer.example.test",
      "secret",
      contract,
      publicKeyDer,
      signingKeyId,
    );

    await expect(client.settleGame(input, "settle-idempotency-key")).rejects.toEqual(
      expect.objectContaining<Partial<SettlementAuthorizerError>>({ status: 502, retryable: false }),
    );
  });
});
