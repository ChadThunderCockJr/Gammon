import { describe, expect, it } from "vitest";
import { sanitizeReturnTo, withReturnTo } from "../return-to";

describe("safe authentication return targets", () => {
  it("preserves an internal pathname and query exactly", () => {
    expect(sanitizeReturnTo("/activity?operation=123&view=receipt")).toBe(
      "/activity?operation=123&view=receipt",
    );
  });

  it.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/\\attacker.example/steal",
    "javascript:alert(1)",
  ])("rejects a target that can leave the application origin: %s", (target) => {
    expect(sanitizeReturnTo(target)).toBe("/");
  });

  it("encodes a validated target as one login query value", () => {
    expect(withReturnTo("/login", "/join/cash_offer?review=1")).toBe(
      "/login?returnTo=%2Fjoin%2Fcash_offer%3Freview%3D1",
    );
  });
});
