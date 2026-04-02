import { describe, it, expect } from "vitest";
import { TournamentManager } from "../tournament.js";

describe("TournamentManager.generateBracket", () => {
  const tm = new TournamentManager();

  it("generates correct bracket for 4 players", () => {
    const { bracket, totalRounds } = tm.generateBracket(["A", "B", "C", "D"]);
    expect(totalRounds).toBe(2);
    // First round: 2 matches
    const round1 = bracket.filter((m) => m.round === 1);
    expect(round1).toHaveLength(2);
    // All 4 players should appear
    const players = round1.flatMap((m) => [m.playerA, m.playerB]).filter(Boolean);
    expect(players.sort()).toEqual(["A", "B", "C", "D"].sort());
    // Second round: 1 match (final)
    const round2 = bracket.filter((m) => m.round === 2);
    expect(round2).toHaveLength(1);
  });

  it("generates correct bracket for 8 players", () => {
    const players = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const { bracket, totalRounds } = tm.generateBracket(players);
    expect(totalRounds).toBe(3);
    expect(bracket.filter((m) => m.round === 1)).toHaveLength(4);
    expect(bracket.filter((m) => m.round === 2)).toHaveLength(2);
    expect(bracket.filter((m) => m.round === 3)).toHaveLength(1);
  });

  it("handles non-power-of-2 with byes", () => {
    const { bracket, totalRounds } = tm.generateBracket(["A", "B", "C"]);
    expect(totalRounds).toBe(2); // rounds up to 4-player bracket
    const round1 = bracket.filter((m) => m.round === 1);
    expect(round1).toHaveLength(2);
    // One match should have a bye (auto-advanced)
    const byeMatches = round1.filter((m) => m.playerA === null || m.playerB === null);
    expect(byeMatches).toHaveLength(1);
    expect(byeMatches[0].status).toBe("finished"); // auto-advanced
    expect(byeMatches[0].winner).toBeTruthy();
  });

  it("handles 2 players", () => {
    const { bracket, totalRounds } = tm.generateBracket(["A", "B"]);
    expect(totalRounds).toBe(1);
    expect(bracket).toHaveLength(1);
    expect(bracket[0].playerA).toBeTruthy();
    expect(bracket[0].playerB).toBeTruthy();
  });

  it("handles 16 players", () => {
    const players = Array.from({ length: 16 }, (_, i) => `P${i}`);
    const { bracket, totalRounds } = tm.generateBracket(players);
    expect(totalRounds).toBe(4);
    expect(bracket.filter((m) => m.round === 1)).toHaveLength(8);
    expect(bracket.filter((m) => m.round === 4)).toHaveLength(1); // final
  });
});

describe("TournamentManager.advanceWinner", () => {
  const tm = new TournamentManager();

  it("advances winner to next round", () => {
    const { bracket } = tm.generateBracket(["A", "B", "C", "D"]);
    const updated = tm.advanceWinner(bracket, 1, 0, "A");
    const match = updated.find((m) => m.round === 1 && m.matchIndex === 0);
    expect(match?.winner).toBe("A");
    expect(match?.status).toBe("finished");
    // Winner should appear in round 2
    const final = updated.find((m) => m.round === 2);
    expect(final?.playerA).toBe("A");
  });

  it("places winner in correct slot based on match index", () => {
    const { bracket } = tm.generateBracket(["A", "B", "C", "D"]);
    // Advance match 0 winner → playerA of final
    let updated = tm.advanceWinner(bracket, 1, 0, "A");
    // Advance match 1 winner → playerB of final
    updated = tm.advanceWinner(updated, 1, 1, "D");
    const final = updated.find((m) => m.round === 2);
    expect(final?.playerA).toBe("A");
    expect(final?.playerB).toBe("D");
  });
});
