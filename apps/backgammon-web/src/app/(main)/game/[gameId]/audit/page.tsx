"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { z } from "zod";
import { verifyDiceRoll, type AuditDiceRoll } from "@/lib/dice-verify";
import { authenticatedFetch } from "@/lib/server-session";

const GameHistorySchema = z.object({
  gameId: z.string(),
  white: z.string(),
  black: z.string(),
  whiteName: z.string().nullable(),
  blackName: z.string().nullable(),
  winner: z.enum(["white", "black"]).nullable(),
  resultType: z.enum(["normal", "gammon", "backgammon"]).nullable(),
  cubeValue: z.number().int().positive(),
  turnCount: z.number().int().nonnegative(),
  cashStakeMicroUsd: z.string().regex(/^\d+$/).nullable(),
  cashState: z.string().nullable(),
  createdAt: z.string().datetime(),
});
type GameHistory = z.infer<typeof GameHistorySchema>;
const ProofsSchema = z.object({ rolls: z.array(z.unknown()) });

function dollars(microUsd: string): string {
  const value = BigInt(microUsd);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}

type VerifyStatus = "pending" | "verified" | "failed" | "unverifiable";

export default function GameAuditPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [proofs, setProofs] = useState<AuditDiceRoll[]>([]);
  const [history, setHistory] = useState<GameHistory | null>(null);
  const [verifyStatuses, setVerifyStatuses] = useState<Map<number, VerifyStatus>>(new Map());
  const [status, setStatus] = useState<"loading" | "ready" | "not_found" | "unavailable">("loading");
  const [proofsUnavailable, setProofsUnavailable] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!gameId) return;
    const controller = new AbortController();
    setStatus("loading");
    setProofsUnavailable(false);
    void authenticatedFetch(`/api/game/${gameId}/history`, { signal: controller.signal })
      .then(async (historyResponse) => {
        if (historyResponse.status === 404) {
          setStatus("not_found");
          return;
        }
        if (!historyResponse.ok) throw new Error("AUDIT_HISTORY_UNAVAILABLE");
        const nextHistory = GameHistorySchema.parse(await historyResponse.json());
        setHistory(nextHistory);
        const proofsResponse = await authenticatedFetch(`/api/game/${gameId}/dice-proofs`, { signal: controller.signal });
        if (!proofsResponse.ok) {
          setProofs([]);
          setProofsUnavailable(true);
        } else {
          const parsed = ProofsSchema.parse(await proofsResponse.json());
          setProofs(parsed.rolls as AuditDiceRoll[]);
        }
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("unavailable");
      });
    return () => controller.abort();
  }, [gameId, retryVersion]);

  // Progressive verification cascade
  useEffect(() => {
    if (proofs.length === 0) return;

    let cancelled = false;
    const statuses = new Map<number, VerifyStatus>();

    // Verify each roll at ~100ms intervals for the cascade effect
    proofs.forEach((proof, idx) => {
      setTimeout(async () => {
        if (cancelled) return;

        if ("proofStatus" in proof) {
          statuses.set(proof.turnNumber, "unverifiable");
        } else {
          try {
            const verification = await verifyDiceRoll(proof);
            statuses.set(proof.turnNumber, verification.valid ? "verified" : "failed");
          } catch {
            statuses.set(proof.turnNumber, "unverifiable");
          }
        }

        setVerifyStatuses(new Map(statuses));
      }, idx * 100); // 100ms cascade
    });

    return () => { cancelled = true; };
  }, [proofs]);

  const verifiedCount = Array.from(verifyStatuses.values()).filter((s) => s === "verified").length;
  const totalRolls = proofs.length;
  const allVerified = verifiedCount === totalRolls && totalRolls > 0;
  const failedCount = Array.from(verifyStatuses.values()).filter((value) => value === "failed").length;
  const unverifiableCount = Array.from(verifyStatuses.values()).filter((value) => value === "unverifiable").length;

  const copyAuditUrl = useCallback(async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopyError(true);
    }
  }, []);

  if (status === "loading") {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <h1 className="font-display text-2xl">Game fairness audit</h1>
        <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">Loading authoritative game and proof records…</p>
      </main>
    );
  }

  if (status !== "ready" || !history) {
    return (
      <main className="mx-auto max-w-xl p-4 sm:p-6">
        <h1 className="font-display text-2xl">{status === "not_found" ? "Game audit not found" : "Game audit unavailable"}</h1>
        <p role="alert" className="mt-3 text-sm text-[var(--color-text-muted)]">
          {status === "not_found"
            ? "This game does not exist or the signed-in wallet is not a participant. No result or proof data is inferred."
            : "The audit service could not load the durable record. Try again; the game result has not been replaced with a placeholder."}
        </p>
        <button type="button" className="btn-secondary mt-4 min-h-11" onClick={() => setRetryVersion((value) => value + 1)}>Retry audit</button>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Page title */}
      <h1 style={{
        fontFamily: "var(--font-display)",
        fontSize: "1.5rem",
        color: "var(--color-text-primary)",
        marginBottom: 8,
      }}>
        Game fairness audit
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
          {proofsUnavailable
            ? "⚠ Proof records unavailable"
            : totalRolls === 0
              ? "— No proof records"
              : allVerified
                ? `✓ ${verifiedCount}/${totalRolls} rolls verified`
                : `… ${verifiedCount}/${totalRolls} rolls verified`}
        </div>

        <div style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6875rem",
          color: "var(--color-text-muted)",
        }}>
          {history.resultType ? `${history.resultType} · ` : ""}Cube ×{history.cubeValue} · {history.turnCount} turns
          {history.winner ? ` · ${history.winner} won` : " · result pending"}
          {history.cashStakeMicroUsd ? ` · $${dollars(history.cashStakeMicroUsd)} per point in verUSD · ${history.cashState ?? "status unavailable"}` : " · Free"}
          {` · ${new Date(history.createdAt).toLocaleString()}`}
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
                      {"proofStatus" in proof ? (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6875rem", color: "var(--color-warning)" }}>
                          unavailable
                        </span>
                      ) : (
                        <a
                          href={`https://drand.love/rounds/${proof.drandRound}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.6875rem",
                            color: "var(--color-text-muted)",
                            textDecoration: "underline",
                          }}
                        >
                          #{proof.drandRound}
                        </a>
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
                        <span role="img" aria-label="Unverifiable roll" style={{ color: "var(--color-warning)", fontSize: "0.75rem" }} title="No verifiable drand proof is available for this roll">⚠</span>
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
            Verification result
          </h2>
          <div className="space-y-3 text-sm text-[var(--color-text-secondary)]">
            <p>Each verified row checks the drand BLS signature, derives randomness from that signature, and replays Gammon’s domain-separated rejection-sampling algorithm.</p>
            {allVerified && <p role="status" className="rounded border border-[var(--color-success)] p-3">All recorded rolls independently verified.</p>}
            {failedCount > 0 && <p role="alert" className="rounded border border-[var(--color-danger)] p-3">{failedCount} recorded roll{failedCount === 1 ? "" : "s"} failed verification. A cash game with failed proof must not settle normally.</p>}
            {(unverifiableCount > 0 || proofsUnavailable || totalRolls === 0) && (
              <p role="status" className="rounded border border-[var(--color-warning)] p-3">
                {proofsUnavailable
                  ? "Proof records could not be loaded."
                  : totalRolls === 0
                    ? "No durable dice proof records are available."
                    : `${unverifiableCount} roll${unverifiableCount === 1 ? "" : "s"} cannot be independently verified.`}
                {" "}Unverifiable is not the same as verified.
              </p>
            )}
            <p>Financial settlement status is separate from proof status. Open Activity for the authoritative settlement, refund, or review receipt.</p>
          </div>
        </div>
      </div>

      {/* Share bar */}
      <div style={{
        display: "flex",
        justifyContent: "center",
        gap: 12,
        flexWrap: "wrap",
        marginTop: 24,
        padding: "16px 0",
      }}>
        <p className="w-full text-center text-xs text-[var(--color-text-muted)]">Audit access is limited to the game’s signed-in participants.</p>
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
            minHeight: 44,
          }}
        >
          {copied ? "Private audit URL copied" : "Copy private audit URL"}
        </button>
        {copyError && <p role="alert" className="w-full text-center text-sm text-[var(--color-danger)]">The URL could not be copied. Copy it from the address bar.</p>}
      </div>

      {/* Responsive: stack on mobile */}
      <style>{`
        @media (max-width: 768px) {
          div[style*="grid-template-columns: 1fr 1fr"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </main>
  );
}
