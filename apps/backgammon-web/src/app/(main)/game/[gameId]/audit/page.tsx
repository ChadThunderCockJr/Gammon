"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { API_BASE } from "@/lib/api";
import { deriveDice } from "@/lib/dice-verify";

interface DiceProof {
  turnNumber: number;
  player: string;
  dice: [number, number];
  drandRound: number | null;
  drandRandomness: string | null;
  drandSignature: string | null;
}

interface GameHistory {
  gameId: string;
  white: string;
  black: string;
  whiteName?: string;
  blackName?: string;
  winner: string;
  resultType: string;
  cubeValue: number;
  turnCount: number;
  wagerAmount: number;
  createdAt: string;
}

type VerifyStatus = "pending" | "verified" | "failed" | "unverifiable";

export default function GameAuditPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [proofs, setProofs] = useState<DiceProof[]>([]);
  const [history, setHistory] = useState<GameHistory | null>(null);
  const [verifyStatuses, setVerifyStatuses] = useState<Map<number, VerifyStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Fetch game data
  useEffect(() => {
    if (!gameId) return;
    setLoading(true);

    Promise.all([
      fetch(`${API_BASE}/api/game/${gameId}/dice-proofs`).then((r) => r.ok ? r.json() : null),
      fetch(`${API_BASE}/api/game/${gameId}/history`).then((r) => r.ok ? r.json() : null),
    ]).then(([proofsData, historyData]) => {
      if (proofsData?.proofs) setProofs(proofsData.proofs);
      if (historyData) setHistory(historyData);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [gameId]);

  // Progressive verification cascade
  useEffect(() => {
    if (proofs.length === 0) return;

    let cancelled = false;
    const statuses = new Map<number, VerifyStatus>();

    // Verify each roll at ~100ms intervals for the cascade effect
    proofs.forEach((proof, idx) => {
      setTimeout(async () => {
        if (cancelled) return;

        if (!proof.drandRound || !proof.drandRandomness) {
          statuses.set(proof.turnNumber, "unverifiable");
        } else {
          // Verify dice derivation client-side (async: uses crypto.subtle)
          const white = history?.white || "";
          const black = history?.black || "";
          const verified = await deriveDice(proof.drandRandomness, white, black, proof.turnNumber);
          const match = verified[0] === proof.dice[0] && verified[1] === proof.dice[1];
          statuses.set(proof.turnNumber, match ? "verified" : "failed");
        }

        setVerifyStatuses(new Map(statuses));
      }, idx * 100); // 100ms cascade
    });

    return () => { cancelled = true; };
  }, [proofs, history]);

  const verifiedCount = Array.from(verifyStatuses.values()).filter((s) => s === "verified").length;
  const totalRolls = proofs.length;
  const allVerified = verifiedCount === totalRolls && totalRolls > 0;

  const copyAuditUrl = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  if (loading) {
    return (
      <div style={{ padding: "32px", fontFamily: "var(--font-body)", color: "var(--color-text-muted)" }}>
        Loading audit data...
      </div>
    );
  }

  if (!history) {
    return (
      <div style={{ padding: "32px", fontFamily: "var(--font-body)", color: "var(--color-text-muted)" }}>
        Game not found or audit data not available.
      </div>
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Page title */}
      <h1 style={{
        fontFamily: "var(--font-display)",
        fontSize: "1.5rem",
        color: "var(--color-text-primary)",
        marginBottom: 8,
      }}>
        Game Audit
      </h1>

      {/* Game summary bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: 16,
        padding: "16px 20px",
        background: "var(--color-bg-surface)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
        marginBottom: 24,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: "1rem", color: "var(--color-text-primary)" }}>
            {history.whiteName || history.white?.slice(0, 10) + "..."}
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>vs</span>
          <span style={{ fontFamily: "var(--font-display)", fontSize: "1rem", color: "var(--color-text-primary)" }}>
            {history.blackName || history.black?.slice(0, 10) + "..."}
          </span>
        </div>

        {/* Verification badge */}
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 14px",
          borderRadius: "var(--radius-pill)",
          background: allVerified
            ? "var(--color-analysis-gold-faint, rgba(208,168,72,0.12))"
            : "var(--color-bg-elevated)",
          border: allVerified
            ? "1px solid rgba(208,168,72,0.2)"
            : "1px solid var(--color-border-subtle)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          color: allVerified
            ? "var(--color-analysis-gold, #D0A848)"
            : "var(--color-text-muted)",
        }}>
          {allVerified ? "✓" : "⋯"} {verifiedCount}/{totalRolls} rolls verified
        </div>

        <div style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6875rem",
          color: "var(--color-text-muted)",
        }}>
          {history.resultType} · Cube ×{history.cubeValue} · {history.turnCount} turns
          {history.wagerAmount > 0 && ` · ${history.wagerAmount} USDC`}
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 20,
      }}>
        {/* Left column: Dice Audit */}
        <div style={{
          background: "var(--color-bg-surface)",
          borderRadius: "var(--radius-card)",
          padding: 20,
          boxShadow: "var(--shadow-card)",
        }}>
          <h2 style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.6875rem",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-text-muted)",
            marginBottom: 16,
          }}>
            Dice Audit
          </h2>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 500, fontSize: "0.625rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>Turn</th>
                <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 500, fontSize: "0.625rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>Dice</th>
                <th style={{ padding: "8px 8px", textAlign: "left", fontWeight: 500, fontSize: "0.625rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>drand</th>
                <th style={{ padding: "8px 4px", textAlign: "center", fontWeight: 500, fontSize: "0.625rem", color: "var(--color-text-muted)" }}></th>
              </tr>
            </thead>
            <tbody>
              {proofs.map((proof) => {
                const status = verifyStatuses.get(proof.turnNumber) || "pending";
                return (
                  <tr
                    key={proof.turnNumber}
                    style={{ borderBottom: "1px solid var(--color-border-subtle)" }}
                  >
                    <td style={{ padding: "8px 8px", color: "var(--color-text-secondary)" }}>
                      {proof.turnNumber}
                    </td>
                    <td style={{ padding: "8px 8px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                      {proof.dice[0]}-{proof.dice[1]}
                    </td>
                    <td style={{ padding: "8px 8px" }}>
                      {proof.drandRound ? (
                        <a
                          href={`https://drand.love/rounds/${proof.drandRound}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.6875rem",
                            color: "var(--color-text-muted)",
                            textDecoration: "none",
                          }}
                        >
                          #{proof.drandRound}
                        </a>
                      ) : (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6875rem", color: "var(--color-text-faint)" }}>
                          CSPRNG
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "8px 4px", textAlign: "center" }}>
                      {status === "pending" && (
                        <span style={{ color: "var(--color-text-faint)" }}>⋯</span>
                      )}
                      {status === "verified" && (
                        <span style={{ color: "var(--color-analysis-gold, #D0A848)", fontWeight: "bold" }}>✓</span>
                      )}
                      {status === "failed" && (
                        <span style={{ color: "var(--color-danger)", fontWeight: "bold" }}>✕</span>
                      )}
                      {status === "unverifiable" && (
                        <span style={{ color: "var(--color-warning)", fontSize: "0.75rem" }} title="Roll used CSPRNG fallback (drand was unavailable)">⚠</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {proofs.length === 0 && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "0.8125rem", textAlign: "center", padding: "24px 0" }}>
              No dice roll data available for this game.
            </p>
          )}

          <p style={{
            marginTop: 12,
            fontSize: "0.6875rem",
            color: "var(--color-text-faint)",
          }}>
            Click any drand round to verify independently on drand.love
          </p>
        </div>

        {/* Right column: Analysis placeholder */}
        <div style={{
          background: "var(--color-bg-surface)",
          borderRadius: "var(--radius-card)",
          padding: 20,
          boxShadow: "var(--shadow-card)",
        }}>
          <h2 style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.6875rem",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-text-muted)",
            marginBottom: 16,
          }}>
            GNUBG Analysis
          </h2>

          <div style={{
            background: "var(--color-bg-elevated)",
            borderRadius: 6,
            padding: "48px 24px",
            textAlign: "center",
            color: "var(--color-text-muted)",
            fontSize: "0.8125rem",
          }}>
            <p>Analysis available after game replay.</p>
            <p style={{ fontSize: "0.75rem", marginTop: 8, color: "var(--color-text-faint)" }}>
              Post-game GNUBG analysis shows equity graph, blunder detection, and move-by-move ratings.
            </p>
          </div>
        </div>
      </div>

      {/* Share bar */}
      <div style={{
        display: "flex",
        justifyContent: "center",
        gap: 12,
        marginTop: 24,
        padding: "16px 0",
      }}>
        <button
          onClick={copyAuditUrl}
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.8125rem",
            padding: "8px 20px",
            borderRadius: "var(--radius-button)",
            background: "var(--color-bg-surface)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border-subtle)",
            cursor: "pointer",
          }}
        >
          {copied ? "Link copied!" : "Copy audit URL"}
        </button>
      </div>

      {/* Responsive: stack on mobile */}
      <style>{`
        @media (max-width: 768px) {
          div[style*="grid-template-columns: 1fr 1fr"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
