import { describe, it, expect } from "vitest";
import { gnubgMovesToOurs } from "../gnubg";

// Regression suite for the GNUBG over-bearing die-mapping bug
// (commit 6d84fb2 / learning: gnubg-bearoff-die-not-point).
//
// GNUBG reports bear-off plays as { from: pointNumber, to: "off" }. The die
// actually used is NOT always the point number: for over-bears it's the die
// that was >= the point. gnubgMovesToOurs must assign the real die.

describe("gnubgMovesToOurs — bear-off die assignment", () => {
  it("prefers exact-match die when available", () => {
    // White bears off point 3 with dice [3, 6]. Exact die 3 wins.
    const moves = gnubgMovesToOurs(
      [{ from: "3", to: "off" }],
      "white",
      [3, 6],
    );
    expect(moves).toEqual([{ from: 3, to: 0, die: 3 }]);
  });

  it("uses over-bear die when no exact match is available", () => {
    // White bears off point 3 with dice [6, 1]. Only 6 can over-bear.
    const moves = gnubgMovesToOurs(
      [{ from: "3", to: "off" }],
      "white",
      [6, 1],
    );
    expect(moves[0].die).toBe(6);
    expect(moves[0].from).toBe(3);
    expect(moves[0].to).toBe(0);
  });

  it("doubles: four bear-offs from 3 with [5,5] consume four 5s", () => {
    const plays = [
      { from: "3", to: "off" },
      { from: "3", to: "off" },
      { from: "3", to: "off" },
      { from: "3", to: "off" },
    ];
    const moves = gnubgMovesToOurs(plays, "white", [5, 5]);
    expect(moves.map((m) => m.die)).toEqual([5, 5, 5, 5]);
  });

  it("mixed move + bear-off assigns each die correctly", () => {
    // White plays 8→2 (die 6) and 4→off (exact die 4).
    const plays = [
      { from: "8", to: "2" },
      { from: "4", to: "off" },
    ];
    const moves = gnubgMovesToOurs(plays, "white", [6, 4]);
    expect(moves[0].die).toBe(6);
    expect(moves[1].die).toBe(4);
  });

  it("black over-bear: dice [6,1], bear off point 3 uses die 6", () => {
    // GNUBG reports in X-perspective; for black, our point = 25 - gnubgPoint.
    const moves = gnubgMovesToOurs(
      [{ from: "3", to: "off" }],
      "black",
      [6, 1],
    );
    expect(moves[0].die).toBe(6);
    expect(moves[0].from).toBe(22);
    expect(moves[0].to).toBe(25);
  });

  it("bar entry consumes the correct die", () => {
    // White enters on point 22 with doubles [3,3]: die = 25 - 22 = 3.
    const moves = gnubgMovesToOurs(
      [{ from: "bar", to: "22" }],
      "white",
      [3, 3],
    );
    expect(moves[0]).toEqual({ from: 0, to: 22, die: 3 });
  });

  it("normal move assigns die equal to distance", () => {
    const moves = gnubgMovesToOurs(
      [{ from: "8", to: "2" }],
      "white",
      [6, 4],
    );
    expect(moves[0].die).toEqual(6);
  });

  it("exact bear-off preferred over over-bear when both would apply", () => {
    // Dice [3, 6]: bearing off point 3 could use exact 3 or over-bear 6.
    // Exact must win so die 6 remains available for a subsequent sub-move.
    const moves = gnubgMovesToOurs(
      [
        { from: "3", to: "off" },
        { from: "8", to: "2" },
      ],
      "white",
      [3, 6],
    );
    expect(moves[0].die).toBe(3);
    expect(moves[1].die).toBe(6);
  });
});
