"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

export default function AnalysisPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();

  return (
    <main
      className="min-h-dvh p-6"
      style={{
        display: "grid",
        placeItems: "center",
        background: "var(--color-bg-base)",
        color: "var(--color-text-primary)",
      }}
    >
      <section
        aria-labelledby="analysis-title"
        style={{
          width: "100%",
          maxWidth: 520,
          padding: 24,
          border: "1px solid var(--color-border-strong)",
          borderRadius: 12,
          background: "var(--color-bg-surface)",
        }}
      >
        <h1 id="analysis-title" style={{ margin: "0 0 12px", fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>
          Match analysis unavailable
        </h1>
        <p style={{ color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          Gammon does not have an authoritative analysis record for match <code>{matchId}</code>.
          No result or opponent data is inferred.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20 }}>
          <button type="button" className="btn-secondary" onClick={() => router.back()}>
            Go back
          </button>
          <Link className="btn-primary" href="/create-match">
            Play another game
          </Link>
        </div>
      </section>
    </main>
  );
}
