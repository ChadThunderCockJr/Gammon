"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { sanitizeReturnTo, withReturnTo } from "@/lib/return-to";

/* ══════════════════════════════════════════════════════════════════
   Local Components
   ══════════════════════════════════════════════════════════════════ */

function GammonButton({
  children,
  onClick,
  disabled,
  style: s,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        width: "100%",
        padding: "14px 20px",
        borderRadius: 10,
        fontSize: "0.9375rem",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "all 0.2s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        fontFamily: "var(--font-body)",
        letterSpacing: "-0.01em",
        background: disabled
          ? "var(--color-bg-subtle)"
          : h
            ? "var(--color-gold-light)"
            : "var(--color-gold-primary)",
        color: disabled ? "var(--color-text-muted)" : "var(--color-accent-fg)",
        border: "none",
        boxShadow: h && !disabled ? "var(--shadow-gold)" : "none",
        opacity: disabled ? 0.6 : 1,
        ...s,
      }}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Icons
   ══════════════════════════════════════════════════════════════════ */

function GLogo({ size = 48 }: { size?: number }) {
  return (
    <img
      src="/logo-transparent.png"
      alt="Gammon"
      style={{
        width: size,
        height: size,
        display: "block",
        margin: "0 auto",
        objectFit: "contain",
      }}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════
   Board Illustration SVG
   ══════════════════════════════════════════════════════════════════ */

function BoardIllustration() {
  return (
    <svg
      width="260"
      height="180"
      viewBox="0 0 260 180"
      fill="none"
      style={{ opacity: 0.9, display: "block", margin: "0 auto" }}
    >
      {/* Board outline */}
      <rect
        x="10"
        y="10"
        width="240"
        height="160"
        rx="8"
        stroke="var(--color-gold-primary)"
        strokeWidth="2"
        fill="none"
      />
      {/* Center bar */}
      <line
        x1="130"
        y1="10"
        x2="130"
        y2="170"
        stroke="var(--color-gold-dark)"
        strokeWidth="1"
      />
      {/* Top triangles (left) */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <polygon
          key={`tl${i}`}
          points={`${18 + i * 19},15 ${28 + i * 19},60 ${38 + i * 19},15`}
          fill={
            i % 2 === 0
              ? "var(--color-burgundy-accent)"
              : "var(--color-gold-muted)"
          }
          stroke="var(--color-border-subtle)"
          strokeWidth="0.5"
        />
      ))}
      {/* Top triangles (right) */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <polygon
          key={`tr${i}`}
          points={`${138 + i * 19},15 ${148 + i * 19},60 ${158 + i * 19},15`}
          fill={
            i % 2 === 0
              ? "var(--color-gold-muted)"
              : "var(--color-burgundy-accent)"
          }
          stroke="var(--color-border-subtle)"
          strokeWidth="0.5"
        />
      ))}
      {/* Bottom triangles (left) */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <polygon
          key={`bl${i}`}
          points={`${18 + i * 19},165 ${28 + i * 19},120 ${38 + i * 19},165`}
          fill={
            i % 2 === 0
              ? "var(--color-gold-muted)"
              : "var(--color-burgundy-accent)"
          }
          stroke="var(--color-border-subtle)"
          strokeWidth="0.5"
        />
      ))}
      {/* Bottom triangles (right) */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <polygon
          key={`br${i}`}
          points={`${138 + i * 19},165 ${148 + i * 19},120 ${158 + i * 19},165`}
          fill={
            i % 2 === 0
              ? "var(--color-burgundy-accent)"
              : "var(--color-gold-muted)"
          }
          stroke="var(--color-border-subtle)"
          strokeWidth="0.5"
        />
      ))}
      {/* White checkers */}
      {(
        [
          [28, 28],
          [28, 42],
          [148, 28],
          [148, 42],
          [148, 56],
        ] as [number, number][]
      ).map(([cx, cy], i) => (
        <circle
          key={`cw${i}`}
          cx={cx}
          cy={cy}
          r="8"
          fill="var(--color-gold-dark)"
          stroke="var(--color-gold-primary)"
          strokeWidth="1"
          opacity="0.9"
        />
      ))}
      {/* Dark checkers */}
      {(
        [
          [85, 152],
          [85, 138],
          [85, 124],
          [218, 152],
          [218, 138],
        ] as [number, number][]
      ).map(([cx, cy], i) => (
        <circle
          key={`cb${i}`}
          cx={cx}
          cy={cy}
          r="8"
          fill="var(--color-checker-black)"
          stroke="var(--color-burgundy-primary)"
          strokeWidth="1"
          opacity="0.9"
        />
      ))}
      {/* Dice */}
      <rect
        x="100"
        y="78"
        width="24"
        height="24"
        rx="4"
        fill="var(--color-bg-elevated)"
        stroke="var(--color-gold-dark)"
        strokeWidth="1"
      />
      <circle cx="107" cy="85" r="2" fill="var(--color-gold-primary)" />
      <circle cx="117" cy="95" r="2" fill="var(--color-gold-primary)" />
      <rect
        x="130"
        y="78"
        width="24"
        height="24"
        rx="4"
        fill="var(--color-bg-elevated)"
        stroke="var(--color-gold-dark)"
        strokeWidth="1"
      />
      <circle cx="137" cy="85" r="2" fill="var(--color-gold-primary)" />
      <circle cx="147" cy="85" r="2" fill="var(--color-gold-primary)" />
      <circle cx="137" cy="95" r="2" fill="var(--color-gold-primary)" />
      <circle cx="147" cy="95" r="2" fill="var(--color-gold-primary)" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MAIN — Login Page
   ══════════════════════════════════════════════════════════════════ */

const WALLET_RETURN_TO = "gammon-wallet-return-to";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isConnected, isConnecting, login } = useAuth();
  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));

  useEffect(() => {
    if (isConnected) {
      let destination = returnTo;
      try {
        const saved = sessionStorage.getItem(WALLET_RETURN_TO);
        sessionStorage.removeItem(WALLET_RETURN_TO);
        if (!searchParams.has("returnTo") && saved !== null) destination = sanitizeReturnTo(saved);
      } catch { /* Storage can be unavailable; use the current URL. */ }
      router.replace(destination);
    }
  }, [isConnected, returnTo, router, searchParams]);

  return (
    <main
      className="flex flex-col lg:flex-row"
      style={{
        minHeight: "100dvh",
        fontFamily: "var(--font-body)",
        color: "var(--color-text-secondary)",
      }}
    >
      {/* ── Left: Branding Panel ── */}
      <div
        className="hidden lg:flex lg:flex-[0_0_45%]"
        style={{
          background: "var(--color-bg-deepest)",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: 60,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Geometric pattern background */}
        <div style={{ position: "absolute", inset: 0, opacity: 0.06, pointerEvents: "none" }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                top: `${(i * 9) % 100}%`,
                left: `${(i * 13 + 10) % 100}%`,
                width: 60 + (i * 17) % 40,
                height: 60 + (i * 17) % 40,
                borderRadius: i % 3 === 0 ? "50%" : 8,
                border: "2px solid var(--color-gold-primary)",
              }}
            />
          ))}
        </div>

        <div
          style={{
            position: "relative",
            zIndex: 1,
            textAlign: "center",
            maxWidth: 380,
          }}
        >
          <BoardIllustration />

          <h2
            className="text-2xl lg:text-[32px]"
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              color: "var(--color-text-primary)",
              margin: "32px 0 16px",
              lineHeight: 1.3,
            }}
          >
            Play. Practice.
            <br />
            Review.
          </h2>
          <p
            style={{
              fontSize: "0.9375rem",
              color: "var(--color-text-secondary)",
              lineHeight: 1.6,
              margin: 0,
              fontFamily: "var(--font-body)",
            }}
          >
            Play free backgammon online, practice with the computer, and review saved match records.
            Cash games remain hidden unless their required controls are enabled.
          </p>

          {/* Feature pills */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              marginTop: 32,
            }}
          >
            {["Free Online Play", "Practice vs AI", "Match Records", "Cash Games Gated"].map(
              (feat) => (
                <span
                  key={feat}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 20,
                    border: "1px solid var(--color-gold-dark)",
                    fontSize: "0.75rem",
                    color: "var(--color-text-primary)",
                    fontWeight: 500,
                    fontFamily: "var(--font-body)",
                  }}
                >
                  {feat}
                </span>
              ),
            )}
          </div>
        </div>
      </div>

      {/* ── Right: Connect Panel ── */}
      <div
        className="p-6 sm:p-10 lg:px-[60px] lg:py-10"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          position: "relative",
          background: "var(--color-bg-base)",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 400,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 20,
          }}
        >
          {/* Logo + Brand */}
          <div style={{ textAlign: "center", marginBottom: 8 }}>
            <GLogo size={80} />
            <h1
              className="text-2xl lg:text-[32px]"
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                color: "var(--color-text-primary)",
                letterSpacing: "-0.03em",
                margin: "16px 0 0",
              }}
            >
              Sign in
            </h1>
            <p
              style={{
                fontSize: "0.9375rem",
                color: "var(--color-text-secondary)",
                margin: "10px 0 0",
                lineHeight: 1.5,
                fontFamily: "var(--font-body)",
              }}
            >
              Online backgammon with a free practice mode
            </p>
          </div>

          {/* Login Button */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              width: "100%",
              marginTop: 8,
            }}
          >
            <GammonButton onClick={() => {
              try { sessionStorage.setItem(WALLET_RETURN_TO, returnTo); } catch { /* Login still works. */ }
              void login();
            }} disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border: "2px solid var(--color-accent-fg)",
                      borderTopColor: "transparent",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                  Logging in...
                </>
              ) : (
                "Login"
              )}
            </GammonButton>
            <button
              type="button"
              onClick={() => router.push("/ai-match?difficulty=beginner")}
              style={{
                width: "100%",
                minHeight: 48,
                borderRadius: 10,
                border: "1px solid var(--color-border-strong)",
                background: "transparent",
                color: "var(--color-text-primary)",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Play free vs AI
            </button>
          </div>

          {/* Footer */}
          <div
            style={{
              color: "var(--color-text-faint)",
              textAlign: "center",
              marginTop: 8,
              fontFamily: "var(--font-body)",
            }}
          >
            <p className="text-xs">By continuing, you agree to:</p>
            <nav aria-label="Sign-in legal links" className="flex flex-wrap items-center justify-center gap-1 text-xs">
              <a
                href={withReturnTo("/terms", searchParams.get("returnTo"))}
                target="_blank"
                className="inline-flex min-h-11 items-center rounded px-2 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: "var(--color-text-muted)" }}
              >
                Terms of Service
              </a>
              <a
                href={withReturnTo("/privacy", searchParams.get("returnTo"))}
                target="_blank"
                className="inline-flex min-h-11 items-center rounded px-2 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: "var(--color-text-muted)" }}
              >
                Privacy Policy
              </a>
            </nav>
          </div>
        </div>

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </main>
  );
}
