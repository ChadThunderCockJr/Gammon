import { describe, expect, it } from "vitest";
import { redactLogData } from "../logger.js";

describe("structured log redaction", () => {
  it("redacts secrets and pseudonymizes personal identifiers recursively", () => {
    const source = {
      authorization: "Bearer live-secret",
      address: "xion1customerwallet",
      count: 3,
      nested: {
        password: "correct horse battery staple",
        playerAddress: "xion1customerwallet",
        error: "postgres://user:password@database.internal/gammon",
      },
    };

    const redacted = redactLogData(source);
    const nested = redacted.nested as Record<string, unknown>;

    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.address).toMatch(/^id:[a-f0-9]{12}$/);
    expect(nested.playerAddress).toBe(redacted.address);
    expect(nested.password).toBe("[REDACTED]");
    expect(nested.error).toBe("[REDACTED]");
    expect(redacted.count).toBe(3);
    expect(JSON.stringify(redacted)).not.toContain("live-secret");
    expect(JSON.stringify(redacted)).not.toContain("customerwallet");
    expect(JSON.stringify(redacted)).not.toContain("database.internal");
  });

  it("serializes bigint and circular values without throwing", () => {
    const circular: Record<string, unknown> = { amount: 1_000_000n };
    circular.self = circular;

    const redacted = redactLogData(circular);
    expect(redacted.amount).toBe("1000000");
    expect(redacted.self).toBe("[CIRCULAR]");
    expect(() => JSON.stringify(redacted)).not.toThrow();
  });
});
