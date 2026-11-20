"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ─── Local Card Component ───────────────────────────────────────
function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: 8,
        padding: 20,
        boxShadow: "var(--shadow-card)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function parseInviteId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  try {
    const url = new URL(trimmed, window.location.origin);
    const match = url.pathname.match(/^\/join\/([^/]+)$/);
    if (match) candidate = decodeURIComponent(match[1]);
  } catch {
    // Fall through to typed identifier validation.
  }
  return /^(?:free|cash)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

// ═════════════════════════════════════════════════════════════════
// JOIN PAGE — "Enter Code" Screen
// ═════════════════════════════════════════════════════════════════
export default function JoinPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);


  const handleLookUp = () => {
    const inviteId = parseInviteId(code);
    if (!inviteId) {
      setError("Enter a valid typed Gammon invite ID or complete invite link.");
      return;
    }
    setError(null);
    router.push(`/join/${encodeURIComponent(inviteId)}`);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        fontFamily: "var(--font-body)",
        color: "var(--color-text-primary)",
      }}
    >
      {/* ─── Header ─────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 24px",
          borderBottom: "1px solid var(--color-border-subtle)",
          background: "var(--color-bg-surface)",
        }}
      >
        <button
          onClick={() => router.push("/")}
          style={{
            background: "none",
            border: "none",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-body)",
          }}
        >
          &larr; Back to lobby
        </button>
        <span
          style={{
            fontSize: "1.0625rem",
            fontWeight: 700,
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-display)",
          }}
        >
          Join Match
        </span>
        <div style={{ width: 96 }} aria-hidden="true" />
      </header>

      {/* ─── Main Content ───────────────────────────────────── */}
      <main
        className="px-4 py-6 sm:px-6 sm:py-10"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          overflow: "auto",
        }}
      >
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 24,
            }}
          >
            {/* Heading */}
            <div style={{ textAlign: "center" }}>
              <h1
                className="text-2xl sm:text-4xl"
                style={{
                  fontWeight: 700,
                  margin: "0 0 8px",
                  letterSpacing: "-0.02em",
                  fontFamily: "var(--font-display)",
                  color: "var(--color-text-primary)",
                }}
              >
                Join a Match
              </h1>
              <p
                style={{
                  fontSize: "0.875rem",
                  color: "var(--color-text-secondary)",
                  margin: 0,
                }}
              >
                Enter the match code shared by your opponent
              </p>
            </div>

            {/* Card with inputs */}
            <Card style={{ width: "100%" }}>
              {/* Code input label */}
              <label
                htmlFor="match-invite"
                style={{
                  display: "block",
                  fontSize: "0.625rem",
                  fontWeight: 700,
                  color: "var(--color-text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: 8,
                }}
              >
                Match ID or invite link
              </label>

              {/* Code input */}
              <input
                id="match-invite"
                type="text"
                placeholder="Paste the match ID or invite link"
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLookUp();
                }}
                aria-invalid={Boolean(error)}
                aria-describedby="match-invite-help match-invite-error"
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 6,
                  border: `2px solid ${code.length > 0 ? "var(--color-gold-primary)" : "var(--color-border-subtle)"}`,
                  background: "var(--color-bg-base)",
                  fontSize: "1.25rem",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  color: "var(--color-text-primary)",
                  outline: "none",
                  textAlign: "center",
                  fontFamily: "var(--font-mono)",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s ease",
                }}
              />

              <p id="match-invite-help" style={{ margin: "10px 0 0", fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                Opening an invite only loads its terms. Cash games require a separate review and explicit acceptance before any reserve transaction.
              </p>
              {error ? <p id="match-invite-error" role="alert" style={{ margin: "10px 0 0", fontSize: "0.75rem", color: "var(--color-danger)" }}>{error}</p> : null}
            </Card>

            {/* Look Up Match button */}
            <button
              type="button"
              disabled={!code.trim()}
              onClick={handleLookUp}
              style={{
                width: "100%",
                padding: "14px 20px",
                borderRadius: 6,
                border: "none",
                background:
                  "linear-gradient(135deg, var(--color-gold-primary) 0%, var(--color-gold-light) 100%)",
                color: "var(--color-accent-fg)",
                fontSize: "0.9375rem",
                fontWeight: 700,
                fontFamily: "var(--font-body)",
                opacity: code.trim() ? 1 : 0.4,
                cursor: code.trim() ? "pointer" : "not-allowed",
                boxShadow: "var(--shadow-gold)",
                transition: "opacity 0.2s",
              }}
            >
              Look Up Match &rarr;
            </button>

          </div>
        </div>
      </main>
    </div>
  );
}
