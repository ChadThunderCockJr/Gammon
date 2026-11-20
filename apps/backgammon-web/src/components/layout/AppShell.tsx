"use client";

import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { useSocialContext } from "@/contexts/SocialContext";

interface AppShellProps {
  children: React.ReactNode;
  sidebar?: boolean;
}

export function AppShell({ children, sidebar = true }: AppShellProps) {
  return (
    <div className="flex min-h-dvh bg-bg-base">
      {sidebar && <Sidebar />}
      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden pb-16 lg:pb-0">{children}</main>
      {sidebar && <MobileNav />}
      <ChallengeOverlay />
    </div>
  );
}

function ChallengeOverlay() {
  const { pendingChallenges, acceptChallenge, declineChallenge, error } = useSocialContext();

  if (pendingChallenges.length === 0) return null;

  return (
    <div
      className="fixed z-[1000] flex flex-col gap-3 bottom-20 left-4 right-4 sm:bottom-6 sm:left-auto sm:right-6"
      role="alert"
      aria-label="Incoming game challenges"
    >
      {error && (
        <div role="alert" className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-bg-surface)] p-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {pendingChallenges.map((c) => (
        <div
          key={c.challengeId}
          style={{
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-gold-primary)",
            borderRadius: 12,
            padding: "16px 20px",
            boxShadow: "var(--shadow-elevated)",
            animation: "slideUp 0.3s ease",
          }}
        >
          <div
            style={{
              fontSize: "0.6875rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 1.5,
              color: "var(--color-gold-primary)",
              marginBottom: 8,
              fontFamily: "var(--font-body)",
            }}
          >
            Challenge!
          </div>
          <div
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--color-text-primary)",
              marginBottom: 14,
              fontFamily: "var(--font-body)",
            }}
          >
            {c.fromName || c.fromAddress.slice(0, 12) + "..."} wants to play
            <span style={{ display: "block", marginTop: 6, fontSize: "0.75rem", fontWeight: 500, color: "var(--color-text-secondary)" }}>
              Free · {c.config.matchLength} point{c.config.matchLength === 1 ? "" : "s"} · {c.config.timeControl}s turns · {c.config.doublingCube ? "doubling enabled" : "no doubling"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => acceptChallenge(c.challengeId)}
              aria-label={`Accept challenge from ${c.fromName || c.fromAddress.slice(0, 12)}`}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 6,
                border: "none",
                background: "var(--color-gold-primary)",
                color: "var(--color-accent-fg)",
                fontSize: "0.8125rem",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                minHeight: 44,
              }}
            >
              Accept
            </button>
            <button
              onClick={() => declineChallenge(c.challengeId)}
              aria-label={`Decline challenge from ${c.fromName || c.fromAddress.slice(0, 12)}`}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 6,
                border: "1px solid var(--color-border-subtle)",
                background: "transparent",
                color: "var(--color-text-secondary)",
                fontSize: "0.8125rem",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                minHeight: 44,
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
