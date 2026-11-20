"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useGame } from "@/hooks/useGame";
import { useAuth } from "@/hooks/useAuth";
import { WS_URL } from "@/lib/ws-config";

// ─── Pulsing dot animation ───────────────────────────────────────────────
function PulsingDot() {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const interval = setInterval(() => setPulse((p) => !p), 800);
    return () => clearInterval(interval);
  }, []);
  return (
    <div
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: "var(--color-gold-primary)",
        opacity: pulse ? 1 : 0.3,
        transition: "opacity 0.4s ease",
      }}
    />
  );
}

// ─── Matchmaking Avatar ──────────────────────────────────────────────────
function MatchAvatar({ name, size = 64 }: { name: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-bg-elevated)",
        border: "2px solid var(--color-gold-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.35,
        fontWeight: 700,
        color: "var(--color-text-primary)",
        fontFamily: "var(--font-body)",
      }}
    >
      {name[0]}
    </div>
  );
}

// ─── Timer display ───────────────────────────────────────────────────────
function Timer({ seconds }: { seconds: number }) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "2rem",
        fontWeight: 700,
        color: "var(--color-gold-primary)",
        letterSpacing: "0.04em",
      }}
    >
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// MAIN MATCHMAKING PAGE
// ═════════════════════════════════════════════════════════════════════════
export default function MatchmakingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedLength = parseInt(searchParams.get("length") || "1", 10);
  const matchLength = [1, 3, 5, 7].includes(requestedLength) ? requestedLength : 1;
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [uiState, setUiState] = useState<"review" | "searching" | "queue-error" | "found" | "countdown">("review");
  const joinedRef = useRef(false);

  const { address, isConnected, login, logout } = useAuth();
  const {
    connected,
    authenticated,
    gameId,
    opponent,
    error,
    sessionStatus,
    retrySession,
    retryConnection,
    joinQueue,
    leaveQueue,
    reset,
  } = useGame(WS_URL, address);

  const startSearch = () => {
    if (!authenticated || joinedRef.current) return;
    joinedRef.current = true;
    setElapsed(0);
    setCountdown(3);
    setUiState("searching");
    joinQueue(matchLength);
  };

  const handleRetry = () => {
    reset();
    joinedRef.current = false;
    startSearch();
  };

  // Reset join flag on disconnect so we re-join on reconnect.
  useEffect(() => {
    if (!connected) joinedRef.current = false;
  }, [connected]);

  useEffect(() => {
    if (uiState !== "searching" || !authenticated || joinedRef.current) return;
    joinedRef.current = true;
    joinQueue(matchLength);
  }, [authenticated, joinQueue, matchLength, uiState]);

  useEffect(() => {
    if (uiState !== "searching" || !authenticated) return;
    const heartbeat = window.setInterval(() => joinQueue(matchLength), 30_000);
    return () => window.clearInterval(heartbeat);
  }, [authenticated, joinQueue, matchLength, uiState]);

  // A server can reject a queue request while the socket stays open. Stop all
  // queue activity immediately instead of leaving the UI searching indefinitely.
  useEffect(() => {
    if (uiState !== "searching" || !error) return;
    leaveQueue();
    joinedRef.current = false;
    setUiState("queue-error");
  }, [error, leaveQueue, uiState]);


  // Track elapsed search time
  useEffect(() => {
    if (uiState === "searching") {
      const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
      return () => clearInterval(interval);
    }
  }, [uiState]);

  // The durable queue allocates and routes the game before both sockets join it.
  useEffect(() => {
    if (uiState === "searching" && gameId) {
      setUiState("found");
    }
  }, [uiState, gameId]);

  // Auto-start countdown after "found" state shows briefly
  useEffect(() => {
    if (uiState === "found") {
      const timer = setTimeout(() => setUiState("countdown"), 1500);
      return () => clearTimeout(timer);
    }
  }, [uiState]);

  // Countdown timer → navigate to match
  useEffect(() => {
    if (uiState === "countdown" && countdown > 0) {
      const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
      return () => clearTimeout(timer);
    }
    if (uiState === "countdown" && countdown === 0 && gameId) {
      const navTimer = setTimeout(() => router.push(`/match/${gameId}`), 500);
      return () => clearTimeout(navTimer);
    }
  }, [uiState, countdown, gameId, router]);

  const handleCancel = () => {
    leaveQueue();
    reset();
    router.push("/");
  };

  const shortAddr = (addr: string | null) => {
    if (!addr) return "?";
    if (addr.length <= 12) return addr;
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  };

  const accessIssue = !isConnected
    ? "wallet-disconnected"
    : sessionStatus === "authorizing"
      ? "authorizing"
      : sessionStatus === "error"
        ? "session-error"
        : !connected
          ? "deployment-unavailable"
          : null;

  const handleChangeWallet = () => {
    void logout().finally(() => router.push("/login"));
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--color-bg-deepest)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-body)",
        color: "var(--color-text-primary)",
      }}
    >
      {/* ─── Top Bar ──────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 24px",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <Link
          href="/"
          onClick={(e) => {
            e.preventDefault();
            handleCancel();
          }}
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
            textDecoration: "none",
          }}
        >
          &larr; Back to lobby
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {!connected && (
            <span style={{ fontSize: "0.6875rem", color: "var(--color-danger)", fontWeight: 600 }}>
              Reconnecting...
            </span>
          )}
          <span
            style={{
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-body)",
            }}
          >
            Quick Match
          </span>
        </div>
      </header>

      {/* ─── Main Content ─────────────────────────────────── */}
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 24px",
          gap: 32,
        }}
      >
        {accessIssue && (
          <section
            aria-live="polite"
            style={{
              width: "min(100%, 420px)",
              display: "grid",
              gap: 16,
              padding: 24,
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 10,
            }}
          >
            {accessIssue === "wallet-disconnected" && (
              <>
                <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>Wallet disconnected</h1>
                <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>Connect a wallet before finding a rated opponent.</p>
                <button type="button" onClick={login} className="btn-primary min-h-11">Connect wallet</button>
              </>
            )}
            {accessIssue === "authorizing" && (
              <>
                <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>Authorizing secure session</h1>
                <p role="status" style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>Verifying this wallet before it can join the rated queue.</p>
              </>
            )}
            {accessIssue === "session-error" && (
              <>
                <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>Session authorization failed</h1>
                <p role="alert" style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>Your wallet could not be authorized for matchmaking. No queue request was sent.</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" onClick={retrySession} className="btn-primary min-h-11">Retry authorization</button>
                  <button type="button" onClick={handleChangeWallet} className="btn-secondary min-h-11">Change wallet</button>
                </div>
              </>
            )}
            {accessIssue === "deployment-unavailable" && (
              <>
                <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>Matchmaking unavailable</h1>
                <p role="alert" style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>The matchmaking service is unavailable right now. No queue request was sent.</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" onClick={retryConnection} className="btn-primary min-h-11">Retry connection</button>
                  <button type="button" onClick={handleCancel} className="btn-secondary min-h-11">Back to lobby</button>
                </div>
              </>
            )}
          </section>
        )}
        {!accessIssue && uiState === "queue-error" && (
          <section
            aria-labelledby="queue-error-title"
            style={{
              width: "min(100%, 420px)",
              display: "grid",
              gap: 16,
              padding: 24,
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 10,
            }}
          >
            <h1 id="queue-error-title" style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>Queue unavailable</h1>
            <p role="alert" style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>
              {error || "The queue could not accept your request."} Searching has stopped and no match was started.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={handleRetry} className="btn-primary min-h-11">Retry</button>
              <button type="button" onClick={handleCancel} className="btn-secondary min-h-11">Back to lobby</button>
            </div>
          </section>
        )}
        {!accessIssue && uiState === "review" && (
          <section
            aria-labelledby="queue-review-title"
            style={{
              width: "min(100%, 420px)",
              display: "grid",
              gap: 20,
              padding: 24,
              background: "var(--color-bg-surface)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 10,
            }}
          >
            <div>
              <h1 id="queue-review-title" style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.5rem" }}>
                Join a free match queue
              </h1>
              <p style={{ margin: "8px 0 0", color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>
                Review the match settings before searching. Joining this queue never reserves or moves money.
              </p>
            </div>
            <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: 0 }}>
              <div><dt style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>Length</dt><dd style={{ margin: 0, fontWeight: 600 }}>{matchLength} point{matchLength === 1 ? "" : "s"}</dd></div>
              <div><dt style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>Wager</dt><dd style={{ margin: 0, fontWeight: 600 }}>Free</dd></div>
              <div><dt style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>Mode</dt><dd style={{ margin: 0, fontWeight: 600 }}>Rated</dd></div>
              <div><dt style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>Opponent</dt><dd style={{ margin: 0, fontWeight: 600 }}>Any available player</dd></div>
            </dl>
            {!isConnected || !authenticated ? (
              <p role="status" style={{ margin: 0, color: "var(--color-warning)", fontSize: "0.875rem" }}>
                Complete wallet login and secure session setup before joining.
              </p>
            ) : null}
            <div style={{ display: "grid", gap: 10 }}>
              <button
                type="button"
                onClick={startSearch}
                disabled={!isConnected || !authenticated}
                style={{ minHeight: 44, border: 0, borderRadius: 8, background: "var(--color-gold-primary)", color: "var(--color-accent-fg)", fontWeight: 700, cursor: isConnected && authenticated ? "pointer" : "not-allowed" }}
              >
                Find an opponent
              </button>
              <Link href="/create-match" style={{ minHeight: 44, display: "grid", placeItems: "center", color: "var(--color-text-secondary)" }}>
                Create a private invite
              </Link>
            </div>
          </section>
        )}

        {/* ═══ SEARCHING STATE ════════════════════════════ */}
        {!accessIssue && uiState === "searching" && (
          <>
            {/* Searching animation area */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 24,
              }}
            >
              {/* Your avatar + searching indicator */}
              <div style={{ position: "relative" }}>
                <MatchAvatar name={shortAddr(address)} size={64} />
                {/* Spinning ring placeholder */}
                <div
                  style={{
                    position: "absolute",
                    inset: -8,
                    borderRadius: "50%",
                    border: "2.5px solid var(--color-border-subtle)",
                    borderTopColor: "var(--color-gold-primary)",
                  }}
                />
              </div>

              <div style={{ textAlign: "center" }}>
                <h2
                  className="text-xl sm:text-[26px]"
                  style={{
                    fontWeight: 700,
                    margin: "0 0 8px",
                    letterSpacing: "-0.02em",
                    fontFamily: "var(--font-display)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  Finding opponent...
                </h2>
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "var(--color-text-secondary)",
                    margin: 0,
                    fontFamily: "var(--font-body)",
                  }}
                >
                  Searching for an available player
                </p>
              </div>

              {/* Elapsed time */}
              <Timer seconds={elapsed} />

              {/* Search status dots */}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <PulsingDot />
                <PulsingDot />
                <PulsingDot />
              </div>
            </div>

            {/* Match settings summary */}
            <div
              style={{
                display: "flex",
                gap: 12,
                padding: "12px 16px",
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 10,
              }}
            >
              {[
                { label: "Length", value: `${matchLength}pt` },
                { label: "Wager", value: "Free" },
                { label: "Mode", value: "Rated" },
              ].map((item, i) => (
                <div key={i} style={{ textAlign: "center", minWidth: 60 }}>
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--color-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      fontWeight: 600,
                      marginBottom: 4,
                      fontFamily: "var(--font-body)",
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      color: "var(--color-text-primary)",
                      fontFamily: "var(--font-body)",
                    }}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Expanding range notice */}
            {elapsed > 5 && (
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-text-muted)",
                  fontStyle: "italic",
                  fontFamily: "var(--font-body)",
                }}
              >
                Still searching for an opponent...
              </p>
            )}

            {/* Cancel */}
            <button
              onClick={handleCancel}
              style={{
                padding: "12px 32px",
                borderRadius: 8,
                border: "1.5px solid var(--color-border-default)",
                background: "var(--color-bg-surface)",
                color: "var(--color-text-secondary)",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Cancel Search
            </button>
          </>
        )}

        {/* ═══ OPPONENT FOUND STATE ═══════════════════════ */}
        {!accessIssue && uiState === "found" && (
          <>
            <div
              className="gap-6 sm:gap-10"
              style={{
                display: "flex",
                alignItems: "center",
              }}
            >
              {/* You */}
              <div style={{ textAlign: "center" }}>
                <MatchAvatar name={shortAddr(address)} size={80} />
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      fontSize: "1rem",
                      fontWeight: 700,
                      fontFamily: "var(--font-body)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    You
                  </div>
                  <div
                    style={{
                      fontSize: "0.8125rem",
                      color: "var(--color-text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {shortAddr(address)}
                  </div>
                </div>
              </div>

              {/* VS */}
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  color: "var(--color-gold-dark)",
                  letterSpacing: "0.1em",
                  fontFamily: "var(--font-body)",
                }}
              >
                VS
              </div>

              {/* Opponent */}
              <div style={{ textAlign: "center" }}>
                <MatchAvatar name={shortAddr(opponent)} size={80} />
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      fontSize: "1rem",
                      fontWeight: 700,
                      fontFamily: "var(--font-body)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    Opponent
                  </div>
                  <div
                    style={{
                      fontSize: "0.8125rem",
                      color: "var(--color-text-muted)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {shortAddr(opponent)}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ textAlign: "center" }}>
              <h2
                className="text-xl sm:text-[26px]"
                style={{
                  fontWeight: 700,
                  margin: "0 0 8px",
                  letterSpacing: "-0.02em",
                  fontFamily: "var(--font-display)",
                  color: "var(--color-text-primary)",
                }}
              >
                Opponent found!
              </h2>
              <p
                style={{
                  fontSize: "0.875rem",
                  color: "var(--color-text-secondary)",
                  margin: 0,
                  fontFamily: "var(--font-body)",
                }}
              >
                Get ready to play
              </p>
            </div>
          </>
        )}

        {/* ═══ COUNTDOWN STATE ════════════════════════════ */}
        {!accessIssue && uiState === "countdown" && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 48,
              }}
            >
              {/* You */}
              <div style={{ textAlign: "center" }}>
                <MatchAvatar name={shortAddr(address)} size={72} />
                <div style={{ marginTop: 10 }}>
                  <div
                    style={{
                      fontSize: "0.9375rem",
                      fontWeight: 700,
                      fontFamily: "var(--font-body)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    You
                  </div>
                </div>
              </div>

              {/* Countdown number */}
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: "50%",
                  border: "3px solid var(--color-gold-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "2.25rem",
                  fontWeight: 800,
                  color: "var(--color-gold-primary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {countdown > 0 ? countdown : "GO"}
              </div>

              {/* Opponent */}
              <div style={{ textAlign: "center" }}>
                <MatchAvatar name={shortAddr(opponent)} size={72} />
                <div style={{ marginTop: 10 }}>
                  <div
                    style={{
                      fontSize: "0.9375rem",
                      fontWeight: 700,
                      fontFamily: "var(--font-body)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {shortAddr(opponent)}
                  </div>
                </div>
              </div>
            </div>

            <p
              style={{
                fontSize: "0.9375rem",
                color: "var(--color-text-secondary)",
                fontWeight: 500,
                fontFamily: "var(--font-body)",
              }}
            >
              {countdown > 0 ? "Match starting..." : "Loading board..."}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
