"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout";
import { useAuth } from "@/hooks/useAuth";
import { SocialProvider, useSocialContext } from "@/contexts/SocialContext";
import { FocusTrap } from "@/components/ui/FocusTrap";
import { withReturnTo } from "@/lib/return-to";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isConnected, isConnecting } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!isConnecting && !isConnected) {
      const query = searchParams.toString();
      window.location.replace(withReturnTo("/login", `${pathname}${query ? `?${query}` : ""}`));
    }
  }, [isConnected, isConnecting, pathname, searchParams]);

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
  const { logout } = useAuth();
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const usernameValid = /^[A-Za-z0-9_]{3,20}$/.test(input);
  const showInputError = attempted && !usernameValid;

  // Navigate to game when a challenge is accepted
  useEffect(() => {
    if (acceptedGameId) {
      clearAcceptedGame();
      gameRouter.push(`/match/${acceptedGameId}`);
    }
  }, [acceptedGameId, clearAcceptedGame, gameRouter]);

  const handleSubmit = useCallback(() => {
    setAttempted(true);
    if (!usernameValid) {
      inputRef.current?.focus();
      return;
    }
    setUsername(input);
    setSubmitted(true);
  }, [input, setUsername, usernameValid]);

  // Keep the dialog open until the server confirms the username.
  const showPrompt = connected && !username;

  // Reset submitted state after the server rejects the username so the user can retry.
  useEffect(() => {
    if (!usernameError) return;
    const frame = window.requestAnimationFrame(() => {
      setSubmitted(false);
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
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
              id="username-rules"
              style={{
                fontSize: "0.8125rem",
                color: "var(--color-text-muted)",
                textAlign: "center",
                margin: "0 0 24px",
                fontFamily: "var(--font-body)",
                lineHeight: 1.5,
              }}
            >
              Pick a unique public username so friends can find you.
              Use 3-20 letters, numbers, or underscores. Display names can change later;
              username changes currently require support.
            </p>
            <label htmlFor="username" style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-secondary)", marginBottom: 6 }}>Username</label>
            <input
              ref={inputRef}
              id="username"
              type="text"
              placeholder="e.g. BackgammonKing"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              aria-invalid={Boolean(usernameError) || showInputError}
              aria-describedby="username-rules username-counter username-error"
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
                setAttempted(true);
                if (!usernameError) e.target.style.borderColor = "var(--color-border-subtle)";
              }}
              autoFocus
            />
            <div id="username-counter" aria-live="polite" style={{ marginTop: 6, textAlign: "right", fontSize: "0.6875rem", color: input.length > 20 ? "var(--color-danger)" : "var(--color-text-muted)" }}>
              {input.length}/20 characters
            </div>
            {(usernameError || showInputError) && (
              <div
                id="username-error"
                role="alert"
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-danger)",
                  marginTop: 8,
                  textAlign: "center",
                  fontFamily: "var(--font-body)",
                  fontWeight: 600,
                }}
              >
                {usernameError || "Use exactly 3–20 letters, numbers, or underscores; remove spaces and unsupported characters."}
              </div>
            )}
            <button
              onClick={handleSubmit}
              disabled={!usernameValid || submitted}
              style={{
                width: "100%",
                padding: "14px 0",
                borderRadius: 8,
                border: "none",
                background:
                  usernameValid && !submitted
                    ? "var(--color-gold-primary)"
                    : "var(--color-bg-subtle)",
                color:
                  usernameValid && !submitted
                    ? "var(--color-accent-fg)"
                    : "var(--color-text-faint)",
                fontSize: "0.9375rem",
                fontWeight: 700,
                cursor: usernameValid && !submitted ? "pointer" : "not-allowed",
                fontFamily: "var(--font-body)",
                marginTop: 16,
                transition: "all 0.15s ease",
              }}
            >
              {submitted ? "Saving…" : "Continue"}
            </button>
            <button
              type="button"
              onClick={() => { void logout(); gameRouter.replace("/login"); }}
              style={{ width: "100%", minHeight: 44, marginTop: 8, border: 0, background: "transparent", color: "var(--color-text-secondary)", textDecoration: "underline", cursor: "pointer" }}
            >
              Cancel and log out
            </button>
            </div>
          </FocusTrap>
        </div>
      )}
    </>
  );
}
