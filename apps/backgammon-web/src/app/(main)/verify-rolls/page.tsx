"use client";

import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout";
import { Card, SectionLabel, Avatar, Badge } from "@/components/ui";
import { useAuth } from "@/hooks/useAuth";
import { formatMove } from "@xion-beginner/backgammon-core";
import type { MoveRecord } from "@xion-beginner/backgammon-core";
import { API_BASE } from "@/lib/api";
import type { MatchResult } from "@/lib/api";
import { getLocalMatches, type AIMatchRecord } from "@/lib/local-stats";
import { verifyDiceRoll, DRAND_CHAIN_HASH, type DiceProof, type DiceProofsResponse } from "@/lib/dice-verify";

// ─── Icons ─────────────────────────────────────────────────────────

function ShieldIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="var(--color-gold-primary)" strokeWidth="1.5">
      <path d="M8 1.5L3 4v3c0 3 2 5.5 5 6.5 3-1 5-3.5 5-6.5V4L8 1.5z" />
      <path d="M6 8l1.5 1.5L10.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="var(--color-text-muted)"
      strokeWidth="1.5"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
      }}
    >
      <path d="M5 3l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" fill="#22c55e" opacity="0.15" />
      <path d="M5 8l2 2 4-4" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" fill="#ef4444" opacity="0.15" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ animation: "spin 1s linear infinite" }}>
      <circle cx="8" cy="8" r="6" stroke="var(--color-text-faint)" strokeWidth="1.5" strokeDasharray="20 12" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

// ─── Dice Face (small inline) ──────────────────────────────────────

function DiceFace({ value }: { value: number }) {
  const dotPositions: Record<number, [number, number][]> = {
    1: [[5, 5]],
    2: [[2, 2], [8, 8]],
    3: [[2, 2], [5, 5], [8, 8]],
    4: [[2, 2], [8, 2], [2, 8], [8, 8]],
    5: [[2, 2], [8, 2], [5, 5], [2, 8], [8, 8]],
    6: [[2, 2], [8, 2], [2, 5], [8, 5], [2, 8], [8, 8]],
  };
  const dots = dotPositions[value] || [];
  return (
    <svg width="20" height="20" viewBox="0 0 11 11">
      <rect x="0.5" y="0.5" width="10" height="10" rx="2" fill="var(--color-bg-elevated)" stroke="var(--color-bg-subtle)" strokeWidth="0.5" />
      {dots.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="1.1" fill="var(--color-text-primary)" />
      ))}
    </svg>
  );
}

// ─── Distribution Bar ──────────────────────────────────────────────

function DistributionBar({ face, count, total }: { face: number; count: number; total: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const expected = 100 / 6;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <DiceFace value={face} />
      <div style={{ flex: 1, height: 14, background: "var(--color-bg-subtle)", borderRadius: 3, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: Math.abs(pct - expected) > 5 ? "var(--color-gold-primary)" : "var(--color-text-muted)",
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <span style={{ fontSize: "0.6875rem", fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", minWidth: 55, textAlign: "right" }}>
        {count} ({pct.toFixed(1)}%)
      </span>
    </div>
  );
}

// ─── Verification Status ──────────────────────────────────────────

type VerifyStatus = "pending" | "verifying" | "valid" | "invalid";

function VerifyBadge({ status, details }: { status: VerifyStatus; details?: string }) {
  if (status === "pending") return null;
  if (status === "verifying") return <SpinnerIcon />;
  return (
    <span title={details} style={{ cursor: details ? "help" : undefined }}>
      {status === "valid" ? <CheckIcon /> : <CrossIcon />}
    </span>
  );
}

// ─── Roll Log Table (with drand verification) ──────────────────────

function RollLog({
  moveHistory,
  diceProofs,
}: {
  moveHistory: MoveRecord[];
  diceProofs: DiceProof[] | null;
}) {
  const [verifyResults, setVerifyResults] = useState<Map<number, { status: VerifyStatus; details?: string }>>(new Map());
  const [verifyingAll, setVerifyingAll] = useState(false);

  const verifyOne = useCallback(async (proof: DiceProof) => {
    setVerifyResults((prev) => {
      const next = new Map(prev);
      next.set(proof.turnNumber, { status: "verifying" });
      return next;
    });
    const result = await verifyDiceRoll(proof);
    setVerifyResults((prev) => {
      const next = new Map(prev);
      next.set(proof.turnNumber, { status: result.valid ? "valid" : "invalid", details: result.details });
      return next;
    });
  }, []);

  const verifyAll = useCallback(async () => {
    if (!diceProofs || diceProofs.length === 0) return;
    setVerifyingAll(true);
    for (const proof of diceProofs) {
      await verifyOne(proof);
    }
    setVerifyingAll(false);
  }, [diceProofs, verifyOne]);

  if (moveHistory.length === 0) {
    return (
      <p style={{ fontSize: "0.75rem", color: "var(--color-text-faint)", textAlign: "center", padding: "12px 0" }}>
        No moves recorded for this game.
      </p>
    );
  }

  // Build a map from turnNumber to proof for quick lookup
  const proofMap = new Map<number, DiceProof>();
  if (diceProofs) {
    for (const proof of diceProofs) {
      proofMap.set(proof.turnNumber, proof);
    }
  }

  // Dice distribution stats
  const faceCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  let totalDice = 0;
  for (const record of moveHistory) {
    faceCounts[record.dice[0]]++;
    faceCounts[record.dice[1]]++;
    totalDice += 2;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Verify All button */}
      {diceProofs && diceProofs.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={verifyAll}
            disabled={verifyingAll}
            style={{
              padding: "6px 14px",
              fontSize: "0.75rem",
              fontWeight: 600,
              background: "var(--color-bg-subtle)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 6,
              color: "var(--color-text-primary)",
              cursor: verifyingAll ? "wait" : "pointer",
              opacity: verifyingAll ? 0.6 : 1,
            }}
          >
            {verifyingAll ? "Verifying..." : "Verify All Rolls"}
          </button>
        </div>
      )}

      {/* Turn-by-turn log */}
      <div>
        <SectionLabel>Turn Log</SectionLabel>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                <th style={thStyle}>#</th>
                <th style={thStyle}>Player</th>
                <th style={thStyle}>Dice</th>
                <th style={{ ...thStyle, textAlign: "left" }}>Moves</th>
                {diceProofs && <th style={thStyle}>drand</th>}
                {diceProofs && <th style={thStyle}>Proof</th>}
              </tr>
            </thead>
            <tbody>
              {moveHistory.map((record) => {
                const proof = proofMap.get(record.turnNumber);
                const vResult = verifyResults.get(record.turnNumber);
                return (
                  <tr key={record.turnNumber} style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                    <td style={tdStyle}>{record.turnNumber}</td>
                    <td style={tdStyle}>
                      <span style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: record.player === "white" ? "var(--color-text-primary)" : "var(--color-checker-black)",
                        border: `1px solid ${record.player === "white" ? "var(--color-text-secondary)" : "var(--color-border-subtle)"}`,
                        marginRight: 4,
                        verticalAlign: "middle",
                      }} />
                      <span style={{ verticalAlign: "middle", textTransform: "capitalize" }}>{record.player}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
                        <DiceFace value={record.dice[0]} />
                        <DiceFace value={record.dice[1]} />
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "left", fontFamily: "var(--font-mono)", fontSize: "0.6875rem" }}>
                      {record.moves.length > 0
                        ? record.moves.map((m) => formatMove(m, record.player)).join(", ")
                        : "No moves"}
                    </td>
                    {diceProofs && (
                      <td style={tdStyle}>
                        {proof ? (
                          <a
                            href={`https://api.drand.sh/${DRAND_CHAIN_HASH}/public/${proof.drandRound}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: "0.625rem",
                              fontFamily: "var(--font-mono)",
                              color: "var(--color-gold-primary)",
                              textDecoration: "none",
                            }}
                            title={`drand round #${proof.drandRound}`}
                          >
                            #{proof.drandRound}
                          </a>
                        ) : (
                          <span style={{ fontSize: "0.625rem", color: "var(--color-text-faint)" }}>—</span>
                        )}
                      </td>
                    )}
                    {diceProofs && (
                      <td style={tdStyle}>
                        {proof ? (
                          vResult ? (
                            <VerifyBadge status={vResult.status} details={vResult.details} />
                          ) : (
                            <button
                              onClick={() => verifyOne(proof)}
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                fontSize: "0.625rem",
                                color: "var(--color-gold-primary)",
                                textDecoration: "underline",
                                padding: 0,
                              }}
                            >
                              verify
                            </button>
                          )
                        ) : (
                          <span style={{ fontSize: "0.625rem", color: "var(--color-text-faint)" }}>—</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dice distribution */}
      <div>
        <SectionLabel>Dice Distribution</SectionLabel>
        <p style={{ fontSize: "0.6875rem", color: "var(--color-text-faint)", marginBottom: 10 }}>
          {totalDice} dice rolled across {moveHistory.length} turns. Expected: ~16.7% each.
        </p>
        {[1, 2, 3, 4, 5, 6].map((face) => (
          <DistributionBar key={face} face={face} count={faceCounts[face]} total={totalDice} />
        ))}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: "0.625rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--color-text-muted)",
  textAlign: "center",
  fontFamily: "var(--font-mono)",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 8px",
  textAlign: "center",
  color: "var(--color-text-secondary)",
  verticalAlign: "middle",
};

// ─── Match Row (accordion) ─────────────────────────────────────────

function MatchRow({ match }: { match: MatchResult }) {
  const [expanded, setExpanded] = useState(false);
  const [moveHistory, setMoveHistory] = useState<MoveRecord[] | null>(null);
  const [diceProofs, setDiceProofs] = useState<DiceProof[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggleExpand = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (moveHistory) return; // already loaded
    setLoading(true);
    try {
      const [histRes, proofsRes] = await Promise.all([
        fetch(`${API_BASE}/api/game/${match.gameId}/history`),
        fetch(`${API_BASE}/api/game/${match.gameId}/dice-proofs`),
      ]);
      if (histRes.ok) {
        const data = await histRes.json();
        setMoveHistory(data.moveHistory);
      } else {
        setMoveHistory([]);
      }
      if (proofsRes.ok) {
        const data: DiceProofsResponse = await proofsRes.json();
        setDiceProofs(data.rolls);
      }
    } catch {
      setMoveHistory([]);
    } finally {
      setLoading(false);
    }
  }, [expanded, moveHistory, match.gameId]);

  const date = new Date(match.timestamp);
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <div style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
      <button
        onClick={toggleExpand}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 4px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Avatar name={match.opponentName || match.opponent} size="xs" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.8125rem", fontWeight: 500, color: "var(--color-text-primary)" }}>
            vs {match.opponentName || `${match.opponent.slice(0, 8)}...`}
          </div>
          <div style={{ fontSize: "0.6875rem", color: "var(--color-text-faint)" }}>{dateStr}</div>
        </div>
        <Badge variant={match.result === "W" ? "win" : "loss"}>
          {match.result === "W" ? "Win" : "Loss"}
        </Badge>
        <span style={{ fontSize: "0.625rem", color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}>
          {match.gameId.slice(0, 6)}
        </span>
        <ChevronIcon open={expanded} />
      </button>

      {expanded && (
        <div style={{ padding: "0 4px 14px" }}>
          {loading ? (
            <p style={{ fontSize: "0.75rem", color: "var(--color-text-faint)", textAlign: "center", padding: "12px 0" }}>
              Loading roll history...
            </p>
          ) : moveHistory ? (
            <RollLog moveHistory={moveHistory} diceProofs={diceProofs} />
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─── AI Match Row (local, no server fetch) ──────────────────────────

function AIMatchRow({ match }: { match: AIMatchRecord }) {
  const [expanded, setExpanded] = useState(false);

  const date = new Date(match.timestamp);
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const diffLabel = match.difficulty.charAt(0).toUpperCase() + match.difficulty.slice(1);

  return (
    <div style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 4px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Avatar name={`AI ${diffLabel}`} size="xs" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.8125rem", fontWeight: 500, color: "var(--color-text-primary)" }}>
            vs AI ({diffLabel})
          </div>
          <div style={{ fontSize: "0.6875rem", color: "var(--color-text-faint)" }}>{dateStr}</div>
        </div>
        <Badge variant={match.result === "W" ? "win" : "loss"}>
          {match.result === "W" ? "Win" : "Loss"}
        </Badge>
        <ChevronIcon open={expanded} />
      </button>

      {expanded && (
        <div style={{ padding: "0 4px 14px" }}>
          {match.moveHistory && match.moveHistory.length > 0 ? (
            <RollLog moveHistory={match.moveHistory} diceProofs={null} />
          ) : (
            <p style={{ fontSize: "0.75rem", color: "var(--color-text-faint)", textAlign: "center", padding: "12px 0" }}>
              No roll history available for this game.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// VERIFY ROLLS PAGE
// ═══════════════════════════════════════════════════════════════════

export default function VerifyRollsPage() {
  const { address } = useAuth();
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [aiMatches, setAiMatches] = useState<AIMatchRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load local AI matches immediately
    setAiMatches(getLocalMatches(50));

    if (!address) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/matches/${address}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setMatches(data.matches);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address]);

  // Merge and sort all matches by timestamp (newest first)
  const allMatches = [
    ...matches.map(m => ({ type: "online" as const, data: m, timestamp: m.timestamp })),
    ...aiMatches.map(m => ({ type: "ai" as const, data: m, timestamp: m.timestamp })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const hasAnyMatches = allMatches.length > 0;

  return (
    <div style={{ width: "100%", minHeight: "100dvh" }}>
      <Header title="Verify Rolls" backHref="/" />

      <div className="p-4 md:px-6 md:py-7" style={{ maxWidth: 700, margin: "0 auto" }}>
        {/* Explanation Card */}
        <Card
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border-subtle)",
            borderLeft: "3px solid var(--color-burgundy-primary)",
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <ShieldIcon size={22} />
            <h2 style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.125rem",
              fontWeight: 700,
              margin: 0,
              color: "var(--color-text-primary)",
            }}>
              Verifiable Random Dice
            </h2>
          </div>
          <p style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)", margin: 0, lineHeight: 1.6 }}>
            All dice rolls use <strong>drand verifiable randomness</strong> from the{" "}
            <a
              href="https://drand.love"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-gold-primary)", textDecoration: "none" }}
            >
              League of Entropy
            </a>
            . Each roll fetches a BLS-signed random beacon published every 3 seconds by a distributed
            network of independent organizations. The server cannot influence the randomness — it can only
            choose which round to use. Dice are derived as{" "}
            <code style={{ fontSize: "0.75rem", background: "var(--color-bg-subtle)", padding: "1px 4px", borderRadius: 3 }}>
              SHA256(randomness + white + black + turn)
            </code>
            . Click &quot;Verify All&quot; on any match to cryptographically verify every roll client-side.
          </p>
        </Card>

        {/* Match List */}
        <Card>
          <SectionLabel>Past Matches</SectionLabel>

          {loading && aiMatches.length === 0 ? (
            <p style={{ fontSize: "0.8125rem", color: "var(--color-text-faint)", textAlign: "center", padding: "24px 0" }}>
              Loading matches...
            </p>
          ) : !hasAnyMatches ? (
            <p style={{ fontSize: "0.8125rem", color: "var(--color-text-faint)", textAlign: "center", padding: "24px 0" }}>
              No matches found. Play a game to see your roll history here.
            </p>
          ) : (
            allMatches.map((entry) =>
              entry.type === "online" ? (
                <MatchRow key={(entry.data as MatchResult).gameId} match={entry.data as MatchResult} />
              ) : (
                <AIMatchRow key={(entry.data as AIMatchRecord).id} match={entry.data as AIMatchRecord} />
              )
            )
          )}
        </Card>
      </div>
    </div>
  );
}
