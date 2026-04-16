"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/layout";
import { useAuth } from "@/hooks/useAuth";
import { SocialProvider, useSocialContext } from "@/contexts/SocialContext";
import { FocusTrap } from "@/components/ui/FocusTrap";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isConnected, isConnecting } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isConnecting && !isConnected) {
      // Preserve the intended destination so the login page can return here after auth.
      // Without this, share links like /join/abc123 get swallowed by the redirect to /.
      if (typeof window !== "undefined") {
        const dest = window.location.pathname + window.location.search;
        if (dest && dest !== "/" && !dest.startsWith("/login")) {
          sessionStorage.setItem("postLoginPath", dest);
        }
      }
      router.replace("/login");
    }
  }, [isConnected, isConnecting, router]);

  if (isConnecting) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--color-bg-base)",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            border: "3px solid var(--color-border-subtle)",
            borderTopColor: "var(--color-gold-primary)",
            animation: "spin 1s linear infinite",
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!isConnected) {
    return null;
  }

  return (
    <SocialProvider>
      <UsernameGate>{children}</UsernameGate>
    </SocialProvider>
  );
}

function UsernameGate({ children }: { children: React.ReactNode }) {
  const gameRouter = useRouter();
  const social = useSocialContext();
  const { username, usernameError, connected, setUsername, acceptedGameId, clearAcceptedGame } = social;
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Navigate to game when a challenge is accepted
  useEffect(() => {
    if (acceptedGameId) {
      clearAcceptedGame();
      gameRouter.push(`/match/${acceptedGameId}`);
    }
  }, [acceptedGameId, clearAcceptedGame, gameRouter]);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed.length >= 3) {
      setUsername(trimmed);
      setSubmitted(true);
    }
  }, [input, setUsername]);

  // Show prompt if connected, no username, and we haven't just submitted successfully
  const showPrompt = connected && !username && !(submitted && !usernameError);

  // Reset submitted state when error comes back so user can retry
  useEffect(() => {
    if (usernameError) setSubmitted(false);
  }, [usernameError]);

  return (
    <>
      <AppShell>{children}</AppShell>
      {showPrompt && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--color-overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
            backdropFilter: "blur(4px)",
          }}
        >
          <FocusTrap>
            <div
              className="p-6 sm:p-8"
              role="dialog"
              aria-modal="true"
              aria-labelledby="username-dialog-title"
              style={{
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 16,
                maxWidth: 400,
                width: "90%",
                boxShadow: "var(--shadow-elevated)",
              }}
            >
              <div
                style={{
                  textAlign: "center",
                  marginBottom: 8,
                }}
              >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: "var(--color-bg-elevated)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 16,
                }}
              >
                <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="var(--color-gold-primary)" strokeWidth="1.5">
                  <circle cx="10" cy="7" r="3" />
                  <path d="M4 17c0-3.3 2.7-6 6-6s6 2.7 6 6" strokeLinecap="round" />
                </svg>
              </div>
            </div>
            <h2
              id="username-dialog-title"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "var(--color-text-primary)",
                margin: "0 0 8px",
                textAlign: "center",
              }}
            >
              Choose a Username
            </h2>
            <p
              style={{
                fontSize: "0.8125rem",
                color: "var(--color-text-muted)",
                textAlign: "center",
                margin: "0 0 24px",
                fontFamily: "var(--font-body)",
                lineHeight: 1.5,
              }}
            >
              Pick a unique username so friends can find you.
              3-20 characters, letters, numbers, and underscores.
            </p>
            <input
              type="text"
              placeholder="e.g. BackgammonKing"
              value={input}
              onChange={(e) => setInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              maxLength={20}
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: usernameError
                  ? "2px solid var(--color-danger)"
                  : "2px solid var(--color-border-subtle)",
                background: "var(--color-bg-base)",
                fontSize: "1rem",
                fontWeight: 600,
                color: "var(--color-text-primary)",
                fontFamily: "var(--font-body)",
                outline: "none",
                boxSizing: "border-box",
                textAlign: "center",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => {
                if (!usernameError) e.target.style.borderColor = "var(--color-gold-primary)";
              }}
              onBlur={(e) => {
                if (!usernameError) e.target.style.borderColor = "var(--color-border-subtle)";
              }}
              autoFocus
            />
            {usernameError && (
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-danger)",
                  marginTop: 8,
                  textAlign: "center",
                  fontFamily: "var(--font-body)",
                  fontWeight: 600,
                }}
              >
                {usernameError}
              </div>
            )}
            <button
              onClick={handleSubmit}
              disabled={input.trim().length < 3}
              style={{
                width: "100%",
                padding: "14px 0",
                borderRadius: 8,
                border: "none",
                background:
                  input.trim().length >= 3
                    ? "var(--color-gold-primary)"
                    : "var(--color-bg-subtle)",
                color:
                  input.trim().length >= 3
                    ? "var(--color-accent-fg)"
                    : "var(--color-text-faint)",
                fontSize: "0.9375rem",
                fontWeight: 700,
                cursor: input.trim().length >= 3 ? "pointer" : "not-allowed",
                fontFamily: "var(--font-body)",
                marginTop: 16,
                transition: "all 0.15s ease",
              }}
            >
              Continue
            </button>
            </div>
          </FocusTrap>
        </div>
      )}
    </>
  );
}
