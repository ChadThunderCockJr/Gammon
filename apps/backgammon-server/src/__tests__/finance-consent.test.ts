import { describe, expect, it } from "vitest";
import { validatedConsentAcceptedAt } from "../finance-router.js";

describe("financial consent timestamp boundary", () => {
  const now = Date.parse("2028-05-01T12:00:00.000Z");

  it("accepts only a canonical recent server-comparable timestamp", () => {
    expect(validatedConsentAcceptedAt("2028-05-01T11:55:00.000Z", now))
      .toBe("2028-05-01T11:55:00.000Z");
  });

  it("rejects malformed and noncanonical timestamps", () => {
    for (const value of [
      "not-a-date",
      "2028-05-01T11:55:00Z",
      "2028-05-01 11:55:00.000Z",
      "2028-05-01T11:55:00.000+00:00",
      "2028-02-30T11:55:00.000Z",
    ]) {
      expect(() => validatedConsentAcceptedAt(value, now)).toThrow("Consent timestamp is invalid");
    }
  });

  it("rejects timestamps outside the ten-minute review window", () => {
    expect(() => validatedConsentAcceptedAt("2028-05-01T11:49:59.999Z", now))
      .toThrow("Consent timestamp is stale");
    expect(() => validatedConsentAcceptedAt("2028-05-01T12:10:00.001Z", now))
      .toThrow("Consent timestamp is stale");
  });
});
