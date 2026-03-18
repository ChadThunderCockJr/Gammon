"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@xion-beginner/ui";
import {
  Card,
  Avatar,
  PillGroup,
  SegmentToggle,
  SectionLabel,
  FocusTrap,
} from "@/components/ui";
import { useGame } from "@/hooks/useGame";
import { useAuth } from "@/hooks/useAuth";
import { useBalance } from "@/hooks/useBalance";
import { useSocialContext } from "@/contexts/SocialContext";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";
import { WS_URL } from "@/lib/ws-config";
import { PULSE_INTERVAL_MS, COUNTDOWN_TICK_MS, INVITE_TIMEOUT_MS } from "@/lib/constants";

/* ── Constants ── */

const MATCH_LENGTHS = [
  { id: "1", label: "1pt" },
  { id: "3", label: "3pt" },
  { id: "5", label: "5pt" },
  { id: "7", label: "7pt" },
  { id: "11", label: "11pt" },
  { id: "15", label: "15pt" },
  { id: "0", label: "Money Game" },
];

const TIME_OPTIONS = [
  { id: "3", label: "3 min" },
  { id: "5", label: "5 min" },
  { id: "10", label: "10 min" },
  { id: "15", label: "15 min" },
];

const STAKE_AMOUNTS = [0, 0.25, 0.50, 1, 5, 10, 25];

const MAX_CUBE_VALUES = [2, 4, 8, 16, 32, 64];

const INVITE_SEGMENTS = [
  { id: "friend", label: "Select a Friend" },
  { id: "anyone", label: "Anyone with Code" },
];

/* ── Icons ── */

const ShieldIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="var(--color-gold-primary)"
    strokeWidth="1.5"
  >
    <path d="M8 1.5L3 4v3c0 3 2 5.5 5 6.5 3-1 5-3.5 5-6.5V4L8 1.5z" />
    <path d="M6 8l1.5 1.5L10.5 6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SearchIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="var(--color-text-muted)"
    strokeWidth="1.5"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" strokeLinecap="round" />
  </svg>
);

const WalletIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 20 20"
    fill="none"
    stroke="var(--color-text-muted)"
    strokeWidth="1.5"
  >
    <rect x="2" y="5" width="16" height="11" rx="2" />
    <path d="M14 10.5a1 1 0 100 2 1 1 0 000-2z" fill="var(--color-text-muted)" />
    <path d="M2 8h16" />
  </svg>
);

/* ── Pulsing Dot ── */

function PulsingDot() {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const interval = setInterval(() => setPulse((p) => !p), PULSE_INTERVAL_MS);
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

/* ── Match Summary Strip ── */

function MatchSummary({
  matchLength,
  timeControl,
  stakePerPoint,
  cubeEnabled,
  maxCube,
  opponent,
}: {
  matchLength: number;
  timeControl: number;
  stakePerPoint: number;
  cubeEnabled: boolean;
  maxCube: number;
  opponent?: string;
}) {
  const items = [
    { label: "Match", value: matchLength === 0 ? "Money game" : `${matchLength}pt` },
    { label: "Clock", value: `${timeControl} min` },
    { label: "Per Point", value: stakePerPoint === 0 ? "Free" : `$${stakePerPoint}` },
    ...(stakePerPoint > 0
      ? [{ label: "Cube", value: cubeEnabled ? `Up to ${maxCube}\u00d7` : "Off" }]
      : []),
    ...(opponent ? [{ label: "Opponent", value: opponent }] : []),
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "12px 16px",
        background: "var(--color-bg-base)",
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--color-border-subtle)",
        marginBottom: 20,
        flexWrap: "wrap",
      }}
    >
      {items.map((item, i) => (
        <div key={i} style={{ textAlign: "center", minWidth: 64 }}>
          <div
            style={{
              fontSize: "0.5625rem",
              color: "var(--color-text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
              marginBottom: 3,
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: "var(--color-text-primary)",
            }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Friend Row ── */

function FriendRow({
  name,
  rating,
  online,
  selected,
  onSelect,
}: {
  name: string;
  rating: string;
  online: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: "var(--radius-button)",
        cursor: "pointer",
        background: selected ? "var(--color-bg-base)" : "transparent",
        border: `1px solid ${selected ? "var(--color-border-subtle)" : "transparent"}`,
        transition: "all 0.1s ease",
      }}
    >
      <div style={{ position: "relative" }}>
        <Avatar name={name} size="sm" />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: online ? "var(--color-success)" : "var(--color-text-muted)",
            border: "2px solid var(--color-bg-surface)",
          }}
        />
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "var(--color-text-primary)",
          }}
        >
          {name}
        </div>
        <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)" }}>{rating}</div>
      </div>
      {selected && (
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--color-gold-primary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="var(--color-accent-fg)"
            strokeWidth="2"
          >
            <path d="M2 6l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

/* ── Session Time Reminder Toast ── */

function SessionToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 20px",
        borderRadius: "var(--radius-card)",
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border-subtle)",
        boxShadow: "var(--shadow-elevated)",
        maxWidth: 420,
        animation: "slideUp 0.3s ease",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-gold-primary)" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 5v3.5l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: "0.8125rem", color: "var(--color-text-secondary)", flex: 1, lineHeight: 1.4 }}>
        {message}
      </span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          color: "var(--color-text-muted)",
          cursor: "pointer",
          fontSize: "1rem",
          padding: "0 4px",
          lineHeight: 1,
        }}
      >
        x
      </button>
      <style>{`@keyframes slideUp { from { opacity: 0; transform: translateX(-50%) translateY(12px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`}</style>
    </div>
  );
}

/* ── Wager Confirmation Modal ── */

function WagerConfirmModal({
  stakePerPoint,
  matchLength,
  cubeEnabled,
  maxCube,
  maxExposure,
  onConfirm,
  onCancel,
}: {
  stakePerPoint: number;
  matchLength: number;
  cubeEnabled: boolean;
  maxCube: number;
  maxExposure: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isHighExposure = maxExposure >= 100;
  const [confirmEnabled, setConfirmEnabled] = useState(!isHighExposure);
  const [delayRemaining, setDelayRemaining] = useState(isHighExposure ? 2 : 0);

  // For high exposure ($100+), add a 2-second pause before confirm becomes active
  useEffect(() => {
    if (!isHighExposure) return;
    const timer = setInterval(() => {
      setDelayRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setConfirmEnabled(true);
          return 0;
        }
        return prev - 1;
      });
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [isHighExposure]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--color-overlay)",
          zIndex: 100,
          animation: "fadeIn 0.15s ease",
        }}
      />

      {/* Modal */}
      <FocusTrap>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="wager-confirm-title"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 101,
            width: "90%",
            maxWidth: 440,
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-card, 12px)",
            boxShadow: "var(--shadow-elevated)",
            overflow: "hidden",
            animation: "modalIn 0.2s ease",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "20px 24px 16px",
              borderBottom: "1px solid var(--color-border-subtle)",
            }}
          >
            <h3
              id="wager-confirm-title"
              style={{
                fontSize: "1.125rem",
                fontWeight: 700,
                margin: 0,
                color: "var(--color-text-primary)",
                fontFamily: "var(--font-display)",
              }}
            >
              Confirm Wager
          </h3>
          <p
            style={{
              fontSize: "0.8125rem",
              color: "var(--color-text-muted)",
              margin: "6px 0 0",
            }}
          >
            Review your match settings before creating.
          </p>
        </div>

        {/* Details */}
        <div style={{ padding: "16px 24px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <div style={{ fontSize: "0.625rem", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                Wager per Point
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
                ${stakePerPoint % 1 === 0 ? stakePerPoint : stakePerPoint.toFixed(2)} USDC
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.625rem", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                Match Length
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
                {matchLength === 0 ? "Money Game" : `${matchLength} pts`}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.625rem", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                Doubling Cube
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
                {cubeEnabled ? `On (max ${maxCube}x)` : "Off"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.625rem", color: "var(--color-text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                Max Exposure
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: isHighExposure ? "var(--color-danger)" : "var(--color-text-primary)", fontFamily: "var(--font-mono)" }}>
                ${maxExposure % 1 === 0 ? maxExposure : maxExposure.toFixed(2)} USDC
              </div>
            </div>
          </div>

          {/* High exposure warning with delay */}
          {isHighExposure && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                borderRadius: 8,
                background: "var(--color-danger-muted)",
                border: "1px solid var(--color-danger)",
                marginBottom: 16,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-danger)" strokeWidth="1.5">
                <path d="M8 1.5L1.5 13h13L8 1.5z" strokeLinejoin="round" />
                <path d="M8 6v3" strokeLinecap="round" />
                <circle cx="8" cy="11" r="0.5" fill="var(--color-danger)" />
              </svg>
              <span style={{ fontSize: "0.75rem", color: "var(--color-danger)", fontWeight: 600, flex: 1, lineHeight: 1.4 }}>
                {!confirmEnabled
                  ? `Please review your wager carefully (${delayRemaining}s)`
                  : "High exposure wager. Please confirm you are comfortable with this amount."}
              </span>
            </div>
          )}

          {/* Escrow note */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--color-bg-base)",
              border: "1px solid var(--color-border-subtle)",
              marginBottom: 16,
            }}
          >
            <ShieldIcon size={12} />
            <span style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", lineHeight: 1.4 }}>
              Funds are held in on-chain escrow and released to the winner automatically.
            </span>
          </div>
        </div>

        {/* Actions */}
        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "0 24px 20px",
          }}
        >
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "12px 20px",
              borderRadius: "var(--radius-card, 12px)",
              border: "1.5px solid var(--color-border-subtle)",
              background: "var(--color-bg-surface)",
              color: "var(--color-text-secondary)",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "var(--font-body)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmEnabled}
            style={{
              flex: 1,
              padding: "12px 20px",
              borderRadius: "var(--radius-card, 12px)",
              border: "none",
              background: "var(--color-gold-primary)",
              color: "var(--color-accent-fg, var(--color-bg-deepest))",
              fontSize: "0.875rem",
              fontWeight: 700,
              cursor: confirmEnabled ? "pointer" : "not-allowed",
              fontFamily: "var(--font-body)",
              boxShadow: "var(--shadow-gold)",
              opacity: confirmEnabled ? 1 : 0.4,
              transition: "opacity 0.2s ease",
            }}
          >
            Confirm & Create Match
          </button>
        </div>
        </div>
      </FocusTrap>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes modalIn { from { opacity: 0; transform: translate(-50%, -48%); } to { opacity: 1; transform: translate(-50%, -50%); } }
      `}</style>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN — CREATE MATCH PAGE
   ═══════════════════════════════════════════════════════════════════ */

export default function CreateMatchPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<"config" | "codeGen" | "waiting">("config");

  const [matchLength, setMatchLength] = useState("5");
  const [timeControl, setTimeControl] = useState("5");
  const [stakePerPoint, setStakePerPoint] = useState(0);
  const [customStake, setCustomStake] = useState("");
  const [cubeEnabled, setCubeEnabled] = useState(true);
  const [maxCube, setMaxCube] = useState(64);
  const [selectedFriend, setSelectedFriend] = useState<string | null>(null);
  const [inviteMode, setInviteMode] = useState("anyone");
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [wantCreate, setWantCreate] = useState(false);
  const createdRef = useRef(false);

  const [showWagerConfirm, setShowWagerConfirm] = useState(false);
  const [sessionToast, setSessionToast] = useState(false);
  const sessionToastDismissed = useRef(false);

  const { address, isConnected } = useAuth();
  const { balance, isLoading: balanceLoading } = useBalance();
  const social = useSocialContext();
  const isNativeApp = useIsNativeApp();

  const {
    connected,
    authenticated,
    status,
    gameId,
    opponent,
    error,
    createGame,
    reset,
  } = useGame(WS_URL, address);

  const matchLengthNum = parseInt(matchLength);
  const timeControlNum = parseInt(timeControl);

  // Max exposure: worst case is a backgammon (3x) at max cube value
  const maxExposure =
    stakePerPoint > 0
      ? stakePerPoint * (cubeEnabled ? maxCube : 1) * 3
      : 0;

  const shortAddr = (addr: string | null) => {
    if (!addr) return "?";
    if (addr.length <= 12) return addr;
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  };

  // Compute the join link using the real game ID
  const matchLink = gameId
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/join/${gameId}`
    : "";

  // Send create_game once authenticated (not just connected — auth must complete first)
  useEffect(() => {
    if (wantCreate && authenticated && !createdRef.current) {
      createdRef.current = true;
      createGame(0, matchLengthNum, timeControlNum * 60); // wager=0 for MVP; timeControl in seconds
    }
  }, [wantCreate, authenticated, createGame, matchLengthNum, timeControlNum]);

  // When status transitions to "playing" (opponent joined + game_start), show waiting/countdown
  useEffect(() => {
    if (status === "playing" && screen === "codeGen") {
      setScreen("waiting");
    }
  }, [status, screen]);

  // Countdown timer for waiting screen → navigate to match
  useEffect(() => {
    if (screen === "waiting" && countdown > 0) {
      const timer = setTimeout(() => setCountdown((c) => c - 1), COUNTDOWN_TICK_MS);
      return () => clearTimeout(timer);
    }
    if (screen === "waiting" && countdown === 0 && gameId) {
      const navTimer = setTimeout(() => router.push(`/match/${gameId}`), 500);
      return () => clearTimeout(navTimer);
    }
  }, [screen, countdown, gameId, router]);

  // Session time reminder: after 10 minutes, show a gentle reminder toast
  useEffect(() => {
    if (sessionToastDismissed.current) return;
    const timer = setTimeout(() => {
      if (!sessionToastDismissed.current) {
        setSessionToast(true);
      }
    }, INVITE_TIMEOUT_MS); // 10 minutes
    return () => clearTimeout(timer);
  }, []);

  const handleCreateMatch = () => {
    // For wager matches, show confirmation modal first
    if (stakePerPoint > 0) {
      setShowWagerConfirm(true);
      return;
    }
    // Free matches skip confirmation
    setWantCreate(true);
    setScreen("codeGen");
  };

  const handleConfirmWager = () => {
    setShowWagerConfirm(false);
    setWantCreate(true);
    setScreen("codeGen");
  };

  const handleCopyCode = () => {
    if (gameId) navigator.clipboard.writeText(gameId);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 1500);
  };

  const handleCopyLink = () => {
    if (matchLink) navigator.clipboard.writeText(matchLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  const opponentLabel =
    inviteMode === "friend" && selectedFriend
      ? selectedFriend
      : "Anyone with code";

  const handleBack = () => {
    if (screen === "config") {
      router.push("/");
    } else if (screen === "codeGen") {
      reset();
      createdRef.current = false;
      setWantCreate(false);
      setScreen("config");
    } else if (screen === "waiting") {
      setScreen("codeGen");
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: "var(--color-bg-deepest)",
        fontFamily: "var(--font-body)",
        color: "var(--color-text-primary)",
      } as React.CSSProperties}
    >
      {/* ─── Header ─── */}
      <header
        className="px-4 py-3 md:px-6"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--color-border-subtle)",
          background: "var(--color-bg-surface)",
        }}
      >
        <button
          onClick={handleBack}
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
          &larr; {screen === "config" ? "Back to lobby" : "Back"}
        </button>
        <span
          className="text-lg sm:text-[22px]"
          style={{
            fontWeight: 700,
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-display)",
          }}
        >
          Play a Friend
        </span>
        {!isNativeApp && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-button)",
            background: "var(--color-bg-surface)",
          }}
        >
          <span
            style={{
              fontSize: "0.8125rem",
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
            }}
          >
            {balanceLoading || balance === null ? "$--" : `$${balance}`}
          </span>
          <span style={{ fontSize: "0.625rem", color: "var(--color-text-muted)" }}>USDC</span>
        </div>
        )}
      </header>

      {/* ─── Main Content ─── */}
      <main
        className="p-4 md:px-6 md:py-7"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          overflow: "auto",
        }}
      >
        <div style={{ width: "100%", maxWidth: 600 }}>
          {/* ═══ CONFIG ═══ */}
          {screen === "config" && (
            <>
              {/* ── Invite Method ── */}
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Who are you playing?</SectionLabel>
                <SegmentToggle
                  segments={INVITE_SEGMENTS}
                  activeId={inviteMode}
                  onSelect={setInviteMode}
                />

                {inviteMode === "friend" && (
                  <div style={{ marginTop: 14 }}>
                    {/* Search bar */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        borderRadius: "var(--radius-button)",
                        border: "1px solid var(--color-border-subtle)",
                        background: "var(--color-bg-base)",
                        marginBottom: 10,
                      }}
                    >
                      <SearchIcon />
                      <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                        Search friends...
                      </span>
                    </div>

                    {/* Friend list */}
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        maxHeight: 220,
                        overflow: "auto",
                      }}
                    >
                      {social.friends.map((f) => (
                        <FriendRow
                          key={f.address}
                          name={f.displayName || f.address.slice(0, 12)}
                          rating="--"
                          online={f.online}
                          selected={selectedFriend === (f.displayName || f.address.slice(0, 12))}
                          onSelect={() => {
                            const name = f.displayName || f.address.slice(0, 12);
                            setSelectedFriend(selectedFriend === name ? null : name);
                          }}
                        />
                      ))}
                      {social.friends.length === 0 && (
                        <div
                          style={{
                            padding: "16px 12px",
                            fontSize: "0.75rem",
                            color: "var(--color-text-muted)",
                            textAlign: "center",
                          }}
                        >
                          No friends yet. Add friends from the social tab.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {inviteMode === "anyone" && (
                  <div
                    style={{
                      marginTop: 14,
                      padding: "12px 16px",
                      borderRadius: "var(--radius-card)",
                      background: "var(--color-bg-base)",
                      border: "1px solid var(--color-border-subtle)",
                      fontSize: "0.75rem",
                      color: "var(--color-text-secondary)",
                      lineHeight: 1.6,
                    }}
                  >
                    A shareable match code will be generated. Anyone with the code can
                    join — no friend request needed.
                  </div>
                )}
              </Card>

              {/* ── Match Settings ── */}
              <Card style={{ paddingBottom: 36 }}>
                <div
                  style={{
                    fontSize: "0.8125rem",
                    fontWeight: 700,
                    color: "var(--color-text-primary)",
                    marginBottom: 18,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  Match Settings
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: "0.625rem",
                      color: "var(--color-text-muted)",
                      fontWeight: 500,
                      background: "var(--color-bg-elevated)",
                      padding: "3px 8px",
                      borderRadius: 4,
                    }}
                  >
                    <ShieldIcon size={10} />
                    Provably fair dice
                  </div>
                </div>

                {/* Match Length */}
                <SectionLabel>Match Length</SectionLabel>
                <PillGroup
                  pills={MATCH_LENGTHS}
                  activeId={matchLength}
                  onSelect={setMatchLength}
                  className="mb-5"
                />

                {/* Time Control */}
                <SectionLabel>Time per Player</SectionLabel>
                <PillGroup
                  pills={TIME_OPTIONS}
                  activeId={timeControl}
                  onSelect={setTimeControl}
                  className="mb-5"
                />

                {/* Stake per Point */}
                {!isNativeApp && (
                <div style={{ marginBottom: 20 }}>
                  <SectionLabel>Stake per Point</SectionLabel>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      marginBottom: 10,
                    }}
                  >
                    {STAKE_AMOUNTS.map((amt) => (
                      <button
                        key={amt}
                        onClick={() => {
                          setStakePerPoint(amt);
                          setCustomStake("");
                        }}
                        style={{
                          padding: "7px 14px",
                          borderRadius: "var(--radius-button)",
                          border: `1.5px solid ${
                            stakePerPoint === amt && !customStake
                              ? "var(--color-gold-primary)"
                              : "var(--color-border-subtle)"
                          }`,
                          background:
                            stakePerPoint === amt && !customStake
                              ? "var(--color-gold-primary)"
                              : "var(--color-bg-surface)",
                          color:
                            stakePerPoint === amt && !customStake
                              ? "var(--color-accent-fg, var(--color-bg-deepest))"
                              : "var(--color-text-secondary)",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "var(--font-body)",
                        }}
                      >
                        {amt === 0
                          ? "Free"
                          : `$${amt % 1 === 0 ? amt : amt.toFixed(2)}`}
                      </button>
                    ))}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        border: `1.5px solid ${
                          customStake
                            ? "var(--color-gold-primary)"
                            : "var(--color-border-subtle)"
                        }`,
                        borderRadius: "var(--radius-button)",
                        padding: "0 10px",
                        background: customStake
                          ? "var(--color-bg-base)"
                          : "var(--color-bg-surface)",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--color-text-muted)",
                          fontWeight: 600,
                        }}
                      >
                        $
                      </span>
                      <input
                        type="text"
                        placeholder="Custom"
                        value={customStake}
                        onChange={(e) => {
                          setCustomStake(e.target.value);
                          const n = parseFloat(e.target.value);
                          if (!isNaN(n) && n > 0) setStakePerPoint(n);
                        }}
                        style={{
                          width: 64,
                          padding: "7px 0",
                          border: "none",
                          outline: "none",
                          background: "transparent",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "var(--color-text-primary)",
                          fontFamily: "var(--font-body)",
                        }}
                      />
                    </div>
                  </div>
                  {stakePerPoint > 0 && (
                    <div
                      style={{
                        fontSize: "0.6875rem",
                        color: "var(--color-text-muted)",
                        lineHeight: 1.5,
                        marginBottom: 6,
                      }}
                    >
                      Each point won/lost = $
                      {stakePerPoint % 1 === 0
                        ? stakePerPoint
                        : stakePerPoint.toFixed(2)}{" "}
                      USDC &middot; Gammons pay 2&times; &middot; Backgammons pay
                      3&times;
                    </div>
                  )}
                  <div style={{ marginTop: stakePerPoint > 0 ? 4 : 8 }}>
                    <a
                      href="https://www.ncpgambling.org/help-treatment/national-helpline-1-800-522-4700/"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: "0.625rem",
                        color: "var(--color-text-faint)",
                        textDecoration: "none",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontFamily: "var(--font-body)",
                        transition: "color 0.15s ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-text-muted)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-text-faint)"; }}
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <circle cx="8" cy="8" r="6.5" />
                        <path d="M8 7v4" strokeLinecap="round" />
                        <circle cx="8" cy="5" r="0.5" fill="currentColor" />
                      </svg>
                      Play responsibly
                    </a>
                  </div>
                </div>
                )}

                {/* Doubling Cube */}
                {!isNativeApp && stakePerPoint > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <SectionLabel>Doubling Cube</SectionLabel>
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "flex-start",
                      }}
                    >
                      {/* On/Off toggle */}
                      <div
                        style={{
                          display: "flex",
                          borderRadius: "var(--radius-card)",
                          overflow: "hidden",
                          border: "1px solid var(--color-border-subtle)",
                          flexShrink: 0,
                        }}
                      >
                        {[
                          { label: "On", value: true },
                          { label: "Off", value: false },
                        ].map((opt, i) => (
                          <button
                            key={i}
                            onClick={() => setCubeEnabled(opt.value)}
                            style={{
                              padding: "8px 16px",
                              background:
                                cubeEnabled === opt.value
                                  ? "var(--color-gold-primary)"
                                  : "var(--color-bg-surface)",
                              color:
                                cubeEnabled === opt.value
                                  ? "var(--color-accent-fg, var(--color-bg-deepest))"
                                  : "var(--color-text-muted)",
                              border: "none",
                              borderLeft:
                                i > 0
                                  ? "1px solid var(--color-border-subtle)"
                                  : "none",
                              fontSize: "0.75rem",
                              fontWeight: 700,
                              cursor: "pointer",
                              fontFamily: "var(--font-body)",
                            }}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>

                      {/* Max cube value */}
                      {cubeEnabled && (
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              fontSize: "0.625rem",
                              color: "var(--color-text-muted)",
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                              marginBottom: 6,
                            }}
                          >
                            Max Cube
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 4,
                              flexWrap: "wrap",
                            }}
                          >
                            {MAX_CUBE_VALUES.map((val) => (
                              <button
                                key={val}
                                onClick={() => setMaxCube(val)}
                                style={{
                                  padding: "5px 10px",
                                  borderRadius: 5,
                                  border: `1.5px solid ${
                                    maxCube === val
                                      ? "var(--color-gold-primary)"
                                      : "var(--color-border-subtle)"
                                  }`,
                                  background:
                                    maxCube === val
                                      ? "var(--color-gold-primary)"
                                      : "var(--color-bg-surface)",
                                  color:
                                    maxCube === val
                                      ? "var(--color-accent-fg, var(--color-bg-deepest))"
                                      : "var(--color-text-secondary)",
                                  fontSize: "0.6875rem",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  fontFamily: "var(--font-mono)",
                                }}
                              >
                                {val}&times;
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Doubling cube illustration */}
                    {cubeEnabled && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          marginTop: 10,
                          padding: "8px 12px",
                          borderRadius: "var(--radius-button)",
                          background: "var(--color-bg-base)",
                          border: "1px solid var(--color-border-subtle)",
                        }}
                      >
                        {/* Mini cube icon */}
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 4,
                            background: "var(--color-bg-elevated)",
                            border: "1.5px solid var(--color-border-subtle)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.6875rem",
                            fontWeight: 700,
                            color: "var(--color-text-primary)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {maxCube}
                        </div>
                        <div
                          style={{
                            fontSize: "0.6875rem",
                            color: "var(--color-text-secondary)",
                            lineHeight: 1.4,
                          }}
                        >
                          Either player can offer to double the stakes during their turn.
                          Opponent must accept or forfeit the game at current value.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Max Exposure + Wallet */}
                <div style={{ marginBottom: 24 }}>
                  {stakePerPoint > 0 && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 14px",
                        borderRadius: "var(--radius-card)",
                        background: "var(--color-bg-surface)",
                        border: "1.5px solid var(--color-border-subtle)",
                        marginBottom: 10,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: "0.625rem",
                            color: "var(--color-text-muted)",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            marginBottom: 3,
                          }}
                        >
                          Max Exposure per Game
                        </div>
                        <div
                          style={{
                            fontSize: "1.125rem",
                            fontWeight: 700,
                            color: "var(--color-text-primary)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          ${maxExposure % 1 === 0 ? maxExposure : maxExposure.toFixed(2)}{" "}
                          USDC
                        </div>
                        <div
                          style={{
                            fontSize: "0.625rem",
                            color: "var(--color-text-muted)",
                            marginTop: 2,
                          }}
                        >
                          ${stakePerPoint} &times; {cubeEnabled ? `${maxCube}` : "1"} cube
                          &times; 3 (backgammon)
                        </div>
                      </div>
                      <ShieldIcon size={20} />
                    </div>
                  )}

                  {/* Wallet balance */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      borderRadius: "var(--radius-button)",
                      background: "var(--color-bg-base)",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <WalletIcon />
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "var(--color-text-primary)",
                        }}
                      >
                        {balanceLoading || balance === null ? "$--" : `$${balance}`}
                      </span>
                      <span
                        style={{
                          fontSize: "0.6875rem",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        USDC available
                      </span>
                    </div>
                    {stakePerPoint > 0 && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "0.625rem",
                          color: "var(--color-text-secondary)",
                          fontWeight: 600,
                        }}
                      >
                        <ShieldIcon size={12} />
                        On-chain escrow
                      </div>
                    )}
                  </div>

                  {maxExposure > 100 && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: "0.6875rem",
                        color: "var(--color-danger)",
                        fontWeight: 600,
                      }}
                    >
                      High exposure: your maximum loss could be ${maxExposure.toFixed(2)}
                    </div>
                  )}
                </div>

                {/* Divider */}
                <div
                  style={{
                    height: 1,
                    background: "var(--color-bg-subtle)",
                    marginBottom: 20,
                  }}
                />

                {/* Summary */}
                <MatchSummary
                  matchLength={matchLengthNum}
                  timeControl={timeControlNum}
                  stakePerPoint={stakePerPoint}
                  cubeEnabled={cubeEnabled}
                  maxCube={maxCube}
                  opponent={opponentLabel}
                />

                {/* CTA */}
                <button
                  onClick={handleCreateMatch}
                  style={{
                    width: "100%",
                    padding: "14px 20px",
                    borderRadius: "var(--radius-card)",
                    border: "none",
                    background: "var(--color-gold-primary)",
                    color: "var(--color-accent-fg, var(--color-bg-deepest))",
                    fontSize: "0.9375rem",
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                    letterSpacing: "-0.01em",
                    boxShadow: "var(--shadow-gold)",
                    opacity:
                      (inviteMode === "friend" && !selectedFriend) ||
                      false
                        ? 0.4
                        : 1,
                    pointerEvents:
                      (inviteMode === "friend" && !selectedFriend) ||
                      false
                        ? "none"
                        : "auto",
                  }}
                >
                  Create Match &rarr;
                </button>
              </Card>
            </>
          )}

          {/* ═══ CODE GENERATED ═══ */}
          {screen === "codeGen" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 20,
                maxWidth: 480,
                margin: "0 auto",
              }}
            >
              <div style={{ textAlign: "center" }}>
                <h2
                  style={{
                    fontSize: "1.375rem",
                    fontWeight: 700,
                    margin: "0 0 6px",
                    letterSpacing: "-0.02em",
                    fontFamily: "var(--font-display)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  Match Created
                </h2>
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "var(--color-text-secondary)",
                    margin: 0,
                  }}
                >
                  {inviteMode === "friend" && selectedFriend
                    ? `Send this code to ${selectedFriend}`
                    : "Share this code with your opponent"}
                </p>
              </div>

              <Card className="w-full text-center">
                {/* Connection status */}
                {!connected && (
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--color-danger)",
                      fontWeight: 600,
                      marginBottom: 8,
                    }}
                  >
                    Reconnecting...
                  </div>
                )}

                {/* Error display */}
                {error && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-danger)",
                      fontWeight: 600,
                      marginBottom: 12,
                      padding: "8px 12px",
                      borderRadius: "var(--radius-button)",
                      background: "var(--color-danger-muted)",
                      border: "1px solid var(--color-danger)",
                    }}
                  >
                    {error}
                  </div>
                )}

                {/* Match code */}
                <div
                  style={{
                    fontSize: "1.75rem",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-gold-primary)",
                    margin: "8px 0 16px",
                    wordBreak: "break-all",
                  }}
                >
                  {gameId || "Creating..."}
                </div>

                {/* Copy buttons */}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    justifyContent: "center",
                    marginBottom: 20,
                  }}
                >
                  <button
                    onClick={handleCopyCode}
                    style={{
                      padding: "8px 20px",
                      borderRadius: "var(--radius-button)",
                      border: "none",
                      background: "var(--color-gold-primary)",
                      color: "var(--color-accent-fg, var(--color-bg-deepest))",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      cursor: "pointer",
                      fontFamily: "var(--font-body)",
                      minWidth: 100,
                      boxShadow: "var(--shadow-gold)",
                      opacity: gameId ? 1 : 0.4,
                      pointerEvents: gameId ? "auto" : "none",
                    }}
                  >
                    {codeCopied ? "Copied!" : "Copy Code"}
                  </button>
                  <button
                    onClick={handleCopyLink}
                    style={{
                      padding: "8px 20px",
                      borderRadius: "var(--radius-button)",
                      border: "1.5px solid var(--color-border-subtle)",
                      background: "var(--color-bg-surface)",
                      color: "var(--color-text-secondary)",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "var(--font-body)",
                      opacity: gameId ? 1 : 0.4,
                      pointerEvents: gameId ? "auto" : "none",
                    }}
                  >
                    {linkCopied ? "Copied!" : "Copy Link"}
                  </button>
                </div>

                {/* Link display */}
                <div
                  style={{
                    padding: "8px 12px",
                    borderRadius: "var(--radius-button)",
                    background: "var(--color-bg-base)",
                    border: "1px solid var(--color-border-subtle)",
                    fontSize: "0.75rem",
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-muted)",
                    marginBottom: 20,
                    wordBreak: "break-all",
                  }}
                >
                  {matchLink || "..."}
                </div>

                {/* QR placeholder */}
                <div
                  style={{
                    width: 120,
                    height: 120,
                    margin: "0 auto",
                    border: "2px dashed var(--color-border-subtle)",
                    borderRadius: "var(--radius-card)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--color-text-muted)"
                    strokeWidth="1.5"
                  >
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="4" height="4" rx="0.5" />
                    <path d="M21 14h-3v3M18 21h3v-4" strokeLinecap="round" />
                  </svg>
                  <span style={{ fontSize: "0.625rem", color: "var(--color-text-muted)" }}>
                    [QR Code]
                  </span>
                </div>
              </Card>

              {/* Match details + waiting */}
              <Card className="w-full">
                <MatchSummary
                  matchLength={matchLengthNum}
                  timeControl={timeControlNum}
                  stakePerPoint={stakePerPoint}
                  cubeEnabled={cubeEnabled}
                  maxCube={maxCube}
                  opponent={opponentLabel}
                />

                {/* Waiting */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    padding: "12px 0",
                  }}
                >
                  <PulsingDot />
                  <span
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 500,
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {inviteMode === "friend" && selectedFriend
                      ? `Waiting for ${selectedFriend} to join...`
                      : "Waiting for opponent to join..."}
                  </span>
                </div>
              </Card>

              {/* Actions */}
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={handleBack}
                  style={{
                    padding: "10px 24px",
                    borderRadius: "var(--radius-card)",
                    border: "1.5px solid var(--color-border-subtle)",
                    background: "var(--color-bg-surface)",
                    color: "var(--color-text-secondary)",
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                  }}
                >
                  Cancel Match
                </button>
              </div>
            </div>
          )}

          {/* ═══ WAITING / OPPONENT JOINED ═══ */}
          {screen === "waiting" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 24,
                maxWidth: 480,
                margin: "0 auto",
              }}
            >
              {/* VS display */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 24,
                  padding: "8px 0",
                }}
              >
                <div style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: "50%",
                      background: "var(--color-bg-elevated)",
                      border: "2px solid var(--color-border-subtle)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "1.5rem",
                      fontWeight: 700,
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {(shortAddr(address) || "?")[0]}
                  </div>
                  <div
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 700,
                      marginTop: 8,
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {shortAddr(address)}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: "1.125rem",
                    fontWeight: 700,
                    color: "var(--color-gold-dark)",
                    padding: "0 8px",
                  }}
                >
                  vs
                </div>
                <div style={{ textAlign: "center" }}>
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: "50%",
                      background: "var(--color-bg-elevated)",
                      border: "2px solid var(--color-border-subtle)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "1.5rem",
                      fontWeight: 700,
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {(shortAddr(opponent) || "?")[0]}
                  </div>
                  <div
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 700,
                      marginTop: 8,
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {shortAddr(opponent)}
                  </div>
                </div>
              </div>

              <div style={{ textAlign: "center" }}>
                <h2
                  style={{
                    fontSize: "1.5rem",
                    fontWeight: 700,
                    margin: "0 0 6px",
                    letterSpacing: "-0.02em",
                    fontFamily: "var(--font-display)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  Opponent Joined!
                </h2>
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "var(--color-text-secondary)",
                    margin: 0,
                  }}
                >
                  Match starting in...
                </p>
              </div>

              {/* Countdown */}
              <div
                style={{
                  fontSize: "4rem",
                  fontWeight: 700,
                  color: "var(--color-gold-primary)",
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "-0.02em",
                }}
              >
                {countdown > 0 ? countdown : "GO"}
              </div>

              {/* Match summary */}
              <MatchSummary
                matchLength={matchLengthNum}
                timeControl={timeControlNum}
                stakePerPoint={stakePerPoint}
                cubeEnabled={cubeEnabled}
                maxCube={maxCube}
              />

              {stakePerPoint > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    borderRadius: "var(--radius-button)",
                    background: "var(--color-bg-base)",
                    border: "1px solid var(--color-border-subtle)",
                  }}
                >
                  <ShieldIcon size={14} />
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    ${stakePerPoint}/pt
                    {cubeEnabled ? ` \u00b7 Cube up to ${maxCube}\u00d7` : ""} &middot; $
                    {maxExposure} max escrowed
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Wager Confirmation Modal */}
      {showWagerConfirm && (
        <WagerConfirmModal
          stakePerPoint={stakePerPoint}
          matchLength={matchLengthNum}
          cubeEnabled={cubeEnabled}
          maxCube={maxCube}
          maxExposure={maxExposure}
          onConfirm={handleConfirmWager}
          onCancel={() => setShowWagerConfirm(false)}
        />
      )}

      {/* Session Time Reminder Toast */}
      {sessionToast && (
        <SessionToast
          message="You've been setting up matches for a while. Take a break if needed."
          onDismiss={() => {
            setSessionToast(false);
            sessionToastDismissed.current = true;
          }}
        />
      )}
    </div>
  );
}
