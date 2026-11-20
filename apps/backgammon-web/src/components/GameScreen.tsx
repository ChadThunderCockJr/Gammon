"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameState, Player, Move, MatchState } from "@xion-beginner/backgammon-core";
import { getPipCount } from "@xion-beginner/backgammon-core";
import { Board, Die, DoublingCube } from "./Board";
import { PostGameAnalysis } from "./PostGameAnalysis";
import { EmojiReactions } from "./EmojiReactions";
import { FocusTrap } from "./ui/FocusTrap";
import { useTheme } from "@/contexts/ThemeContext";
import type { TurnRecord } from "@/hooks/useLocalGame";
import type { CandidateMove } from "@/lib/analysis";
import { isSoundMuted, setSoundMuted } from "@/lib/sounds";
import { TURN_TIMER_TICK_MS } from "@/lib/constants";

export interface CashGameTerms {
  quoteId: string;
  stakeMicroUsd: string;
  reservePerPlayerMicroUsd: string;
  rakeBps: number;
  cubeCap: number;
  state: string;
  testFunds: boolean;
  custodyRecipient: string | null;
  cashSessionStartedAt: string | null;
  realityCheckDueAt: string | null;
}

function formatMicroUsd(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `$${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function cashLiability(terms: CashGameTerms, cube: number, multiplier = 1): bigint {
  const calculated = BigInt(terms.stakeMicroUsd) * BigInt(cube) * BigInt(multiplier);
  const reserve = BigInt(terms.reservePerPlayerMicroUsd);
  return calculated > reserve ? reserve : calculated;
}

function cashDecisionSummary(terms: CashGameTerms, cube: number): string {
  return `${formatMicroUsd(cashLiability(terms, cube))} gross at a normal result; ${formatMicroUsd(BigInt(terms.reservePerPlayerMicroUsd))} maximum reserved loss.`;
}

interface GameScreenProps {
  gameState: GameState;
  myColor: Player;
  legalMoves: Move[];
  opponent: string | null;
  opponentDisconnected: boolean;
  winner: Player | null;
  resultType: string | null;
  onMove: (from: number, to: number) => void;
  onRollDice: () => void;
  onEndTurn: () => void;
  onResign: () => void;
  onNewGame: () => void;
  onBackToLobby?: () => void;
  onUndo: () => void;
  canUndo: boolean;
  turnStartedAt: number | null;
  lastOpponentMove: { from: number; to: number } | null;
  cubeValue?: number;
  cubeOwner?: Player | null;
  doubleOffered?: boolean;
  doubleOfferedBy?: Player | null;
  doubleOfferDeadlineAt?: string | null;
  canDouble?: boolean;
  onDouble?: () => void;
  onAcceptDouble?: () => void;
  onRejectDouble?: () => void;
  forcedMoveNotice?: boolean;
  turnHistory?: TurnRecord[];
  pendingConfirmation?: boolean;
  disconnectCountdown?: number | null;
  onSendReaction?: (emoji: string) => void;
  lastReaction?: { emoji: string; from: string } | null;
  onBlockPlayer?: (address: string) => void;
  onReportPlayer?: (address: string, reason: string) => void;
  blockAction?: { status: "idle" | "pending" | "success" | "error"; error?: string };
  reportAction?: { status: "idle" | "pending" | "success" | "error"; error?: string; receiptId?: string };
  opponentAddress?: string | null;
  matchState?: MatchState | null;
  matchOver?: boolean;
  matchTurnHistory?: TurnRecord[][];
  turnTimeLimit?: number;
  cashTerms?: CashGameTerms | null;
  cashTermsRequired?: boolean;
  cashTermsVerified?: boolean;
  onAcknowledgeRealityCheck?: () => Promise<void>;
  // Consultation mode (AI games)
  isAIGame?: boolean;
  consultationEnabled?: boolean;
  onToggleConsultation?: () => void;
  consultationAnalysis?: {
    errorClass: "blunder" | "mistake" | "inaccuracy" | null;
    equityLoss: number;
    bestMoves: Move[];
    candidates: CandidateMove[];
  } | null;
  consultationAnalysisLoading?: boolean;
  consultationHintLoading?: boolean;
  hintMoves?: Move[] | null;
  consultationGnubgReady?: boolean;
  canRequestHint?: boolean;
  onRequestHint?: () => void;
  onClearHint?: () => void;
}

const DEFAULT_TURN_TIME_LIMIT = 60;

// Visually-hidden style for aria-live region
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: 0,
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function useDeadlineSeconds(deadlineAt: string | null | undefined): number | null {
  const calculate = useCallback(() => {
    if (!deadlineAt) return null;
    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline)) return null;
    return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  }, [deadlineAt]);
  const [seconds, setSeconds] = useState<number | null>(calculate);
  useEffect(() => {
    setSeconds(calculate());
    if (!deadlineAt) return;
    const timer = window.setInterval(() => setSeconds(calculate()), 250);
    return () => window.clearInterval(timer);
  }, [calculate, deadlineAt]);
  return seconds;
}


// ─── PlayerBar (redesigned) ────────────────────────────────────

function PlayerBar({
  name,
  color,
  isActive,
  timer,
  isDisconnected,
  isMe,
  matchScore,
}: {
  name: string;
  color: Player;
  isActive: boolean;
  timer: number | null;
  isDisconnected?: boolean;
  isMe: boolean;
  matchScore?: { score: number; target: number } | null;
}) {
  return (
    <div
      className="flex items-center justify-between rounded-lg transition-colors px-2 py-1 sm:px-4 sm:py-2"
      style={{
        background: isActive ? "var(--color-bg-elevated)" : "transparent",
      }}
    >
      <div className="flex items-center gap-2.5">
        {/* Checker color indicator */}
        <div
          className="w-5 h-5 sm:w-7 sm:h-7"
          style={{
            borderRadius: "50%",
            background: color === "white" ? "var(--color-checker-white)" : "var(--color-checker-black)",
            border: `2px solid ${color === "white" ? "var(--color-checker-white-border)" : "var(--color-checker-black-border)"}`,
          }}
        />
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {isMe ? "You" : name}
          </span>
          {matchScore && (
            <span
              className="text-xs font-bold px-1.5 py-0.5 rounded"
              style={{
                background: "var(--color-gold-muted)",
                color: "var(--color-gold-primary)",
                fontSize: "0.6875rem",
              }}
            >
              {matchScore.score}/{matchScore.target}
            </span>
          )}
          {isDisconnected && (
            <>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-danger)"
                strokeWidth="2"
                className="opacity-80"
                aria-hidden="true"
              >
                <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01" />
              </svg>
              <span className="text-[10px] font-semibold" style={{ color: "var(--color-danger)" }}>(disconnected)</span>
            </>
          )}
        </div>
      </div>

      {/* Clock */}
      {timer !== null && (
        <div
          className="font-mono tabular-nums text-center text-sm sm:text-[17px] px-2 py-1 sm:px-3 sm:py-1.5"
          style={{
            borderRadius: 5,
            background: isActive ? "var(--color-bg-deepest)" : "var(--color-bg-surface)",
            border: "1px solid var(--color-border-subtle)",
            fontWeight: 700,
            color: isActive
              ? timer <= 10
                ? "var(--color-danger)"
                : timer <= 30
                  ? "var(--color-warning)"
                  : "var(--color-text-primary)"
              : "var(--color-text-muted)",
            letterSpacing: "0.04em",
            minWidth: 64,
          }}
        >
          {formatTime(timer)}
          {isActive && timer <= 10 && (
            <span className="text-[11px] font-bold block" style={{ color: "var(--color-danger)" }}>Low time!</span>
          )}
        </div>
      )}
    </div>
  );
}

function formatCashTime(value: string | null): string {
  if (!value) return "Not yet recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet recorded" : date.toLocaleString();
}
function cashStateLabel(state: string): string {
  return ({
    offered: "Awaiting acceptance",
    accepted: "Accepted",
    reserving: "Funding",
    active: "In play",
    settlement_pending: "Settlement pending",
    settled: "Settled",
    refunded: "Refunded",
    review: "Under review",
    expired: "Expired",
  } as Record<string, string>)[state] ?? "Status unavailable";
}

function CashGameContext({ terms, cubeValue, stale }: { terms: CashGameTerms; cubeValue: number; stale: boolean }) {
  const currentLiability = cashLiability(terms, cubeValue);
  return (
    <section
      className="w-full max-w-[960px] rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[10px] sm:px-3 sm:py-2 sm:text-xs"
      aria-label="Cash-game terms"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        <p><span className="text-[var(--color-text-muted)]">Accepted stake: </span><strong>{formatMicroUsd(BigInt(terms.stakeMicroUsd))} verUSD / point</strong></p>
        <p><span className="text-[var(--color-text-muted)]">Current liability: </span><strong>{formatMicroUsd(currentLiability)} verUSD</strong></p>
        <p><span className="text-[var(--color-text-muted)]">Maximum reserve: </span><strong>{formatMicroUsd(BigInt(terms.reservePerPlayerMicroUsd))} verUSD</strong></p>
        <p><span className="text-[var(--color-text-muted)]">Quote status: </span><strong>{cashStateLabel(terms.state)}{stale ? " — last verified (stale)" : ""}</strong></p>
        <p><span className="text-[var(--color-text-muted)]">Funds: </span><strong>{terms.testFunds ? "TEST FUNDS ONLY — no cash value" : "verUSD escrow"}</strong></p>
        <p className="min-w-0"><span className="text-[var(--color-text-muted)]">Custody recipient: </span><strong className="break-all">{terms.custodyRecipient ?? "Escrow contract unavailable"}</strong></p>
        <p className="col-span-2 sm:col-span-3"><span className="text-[var(--color-text-muted)]">Cash session started: </span><strong>{formatCashTime(terms.cashSessionStartedAt)}</strong></p>
      </div>
    </section>
  );
}

// ─── Top Nav Header ────────────────────────────────────────────

function TopNav({
  onBack,
  onMenuToggle,
  showPointNumbers,
  onTogglePointNumbers,
  matchState,
  isAIGame,
  consultationEnabled,
  onToggleConsultation,
}: {
  onBack?: () => void;
  onMenuToggle: () => void;
  showPointNumbers: boolean;
  onTogglePointNumbers: () => void;
  matchState?: MatchState | null;
  isAIGame?: boolean;
  consultationEnabled?: boolean;
  onToggleConsultation?: () => void;
}) {
  return (
    <header
      className="flex items-center justify-between shrink-0 px-2 py-1 sm:px-4 sm:py-1.5"
      style={{
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <button
          onClick={onBack}
          aria-label="Back to lobby"
          className="text-[var(--color-text-muted)] cursor-pointer text-base"
          style={{ background: "none", border: "none", padding: "10px 12px" }}
        >
          ←
        </button>
        <span className="text-xs font-semibold text-[var(--color-text-muted)]">
          {matchState ? `Match · ${matchState.matchLength}pt` : isAIGame ? "Practice" : "Online game"}
        </span>
      </div>

      {/* Match Score */}
      {matchState && (
        <div
          className="flex items-center gap-2"
          style={{
            padding: "3px 12px",
            background: "var(--color-bg-surface)",
            borderRadius: 5,
            border: "1px solid var(--color-border-subtle)",
          }}
        >
          <span className="text-[15px] font-bold text-[var(--color-text-primary)]">{matchState.whiteScore}</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">–</span>
          <span className="text-[15px] font-bold text-[var(--color-text-primary)]">{matchState.blackScore}</span>
          <span className="text-[9px] text-[var(--color-text-muted)] ml-0.5">/ {matchState.matchLength}</span>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          onClick={onTogglePointNumbers}
          aria-label={showPointNumbers ? "Hide point numbers" : "Show point numbers"}
          title={showPointNumbers ? "Hide point numbers" : "Show point numbers"}
          className="flex items-center justify-center cursor-pointer transition-colors"
          style={{
            width: 36,
            height: 36,
            borderRadius: 7,
            border: "1px solid var(--color-border-subtle)",
            background: showPointNumbers ? "var(--color-bg-elevated)" : "transparent",
            color: showPointNumbers ? "var(--color-text-primary)" : "var(--color-text-muted)",
            fontSize: "0.6875rem",
            fontWeight: 700,
            letterSpacing: "0.02em",
          }}
        >
          123
        </button>
        {isAIGame && onToggleConsultation && (
          <button
            onClick={onToggleConsultation}
            aria-label={consultationEnabled ? "Disable AI consultation" : "Enable AI consultation"}
            title={consultationEnabled ? "Disable AI hints" : "Enable AI hints"}
            className="flex items-center justify-center cursor-pointer transition-colors"
            style={{
              width: 36,
              height: 36,
              borderRadius: 7,
              border: "1px solid var(--color-border-subtle)",
              background: consultationEnabled ? "var(--color-bg-elevated)" : "transparent",
              color: consultationEnabled ? "var(--color-text-primary)" : "var(--color-text-muted)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="10" cy="8" r="5" />
              <path d="M8 13v2a2 2 0 004 0v-2" />
              <path d="M10 3V1M14.5 5l1.5-1.5M5.5 5L4 3.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button
          onClick={onMenuToggle}
          aria-label="Game menu"
          className="flex items-center justify-center cursor-pointer transition-colors"
          style={{
            width: 44,
            height: 44,
            borderRadius: 7,
            border: "1px solid var(--color-border-subtle)",
            background: "transparent",
            color: "var(--color-text-muted)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 4h10M3 8h10M3 12h10" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}

// ─── Consultation Panel ───────────────────────────────────────

function ConsultationPanel({
  analysis,
  analysisLoading,
  hintLoading,
  gnubgReady,
  isMyTurn,
  hasDice,
  onRequestHint,
  onSelectCandidate,
  myColor,
}: {
  analysis: { errorClass: "blunder" | "mistake" | "inaccuracy" | null; equityLoss: number; candidates: CandidateMove[] } | null;
  analysisLoading: boolean;
  hintLoading: boolean;
  gnubgReady: boolean;
  isMyTurn: boolean;
  hasDice: boolean;
  onRequestHint?: () => void;
  onSelectCandidate?: (moves: Move[] | null) => void;
  myColor?: Player;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // Collapse and deselect when analysis changes
  useEffect(() => {
    setExpanded(false);
    setSelectedIdx(null);
    onSelectCandidate?.(null);
  }, [analysis, onSelectCandidate]);

  const errorColors: Record<string, string> = {
    blunder: "var(--color-danger)",
    mistake: "#E08040",
    inaccuracy: "var(--color-warning)",
  };
  const errorLabels: Record<string, string> = {
    blunder: "Blunder",
    mistake: "Mistake",
    inaccuracy: "Inaccuracy",
  };

  const canHint = isMyTurn && hasDice && gnubgReady && !hintLoading;
  const hasCandidates = analysis && analysis.candidates.length > 0;

  return (
    <div
      className="shrink-0"
      style={{
        background: "var(--color-bg-surface)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-body)",
        fontSize: "0.75rem",
      }}
    >
      {/* Main bar */}
      <div
        className="flex items-center justify-between px-3"
        style={{ height: 40 }}
      >
        {/* Move quality badge — clickable when candidates exist */}
        <div className="flex items-center gap-2">
          {analysisLoading ? (
            <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
              <div
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  border: "2px solid var(--color-border-subtle)",
                  borderTopColor: "var(--color-analysis-gold)",
                  animation: "spin 1s linear infinite",
                }}
              />
              Analyzing...
            </div>
          ) : analysis ? (
            <button
              onClick={() => hasCandidates && setExpanded(!expanded)}
              className="flex items-center gap-2"
              style={{
                background: "none", border: "none", padding: 0,
                cursor: hasCandidates ? "pointer" : "default",
              }}
            >
              {analysis.errorClass ? (
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: errorColors[analysis.errorClass],
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: "0.6875rem",
                  }}
                >
                  {errorLabels[analysis.errorClass]}
                </span>
              ) : (
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: "var(--color-success)",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: "0.6875rem",
                  }}
                >
                  {analysis.equityLoss === 0 ? "Best" : "Good"}
                </span>
              )}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text-muted)",
                  fontSize: "0.6875rem",
                }}
              >
                {analysis.equityLoss > 0
                  ? `(-${analysis.equityLoss.toFixed(3)})`
                  : "(0.000)"}
              </span>
              {hasCandidates && (
                <span style={{ color: "var(--color-text-faint)", fontSize: "0.625rem", transition: "transform 0.15s", transform: expanded ? "rotate(180deg)" : "rotate(0)" }}>
                  ▾
                </span>
              )}
            </button>
          ) : (
            <span style={{ color: "var(--color-text-faint)", fontSize: "0.6875rem" }}>
              {gnubgReady ? "Make a move to analyze" : "Loading engine..."}
            </span>
          )}
        </div>

        {/* Hint button */}
        <button
          onClick={onRequestHint}
          disabled={!canHint}
          className="flex items-center gap-1 cursor-pointer transition-colors"
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--color-border-subtle)",
            background: canHint ? "var(--color-bg-elevated)" : "transparent",
            color: canHint ? "var(--color-analysis-gold)" : "var(--color-text-faint)",
            fontSize: "0.6875rem",
            fontWeight: 600,
            opacity: canHint ? 1 : 0.5,
            cursor: canHint ? "pointer" : "not-allowed",
          }}
        >
          {hintLoading ? (
            <div
              style={{
                width: 10, height: 10, borderRadius: "50%",
                border: "2px solid var(--color-border-subtle)",
                borderTopColor: "var(--color-analysis-gold)",
                animation: "spin 1s linear infinite",
              }}
            />
          ) : (
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="10" cy="8" r="5" />
              <path d="M8 13v2a2 2 0 004 0v-2" />
            </svg>
          )}
          Hint
        </button>
      </div>

      {/* Expanded candidates list */}
      {expanded && analysis && analysis.candidates.length > 0 && (() => {
        // Show equity relative to best move (diff from #1)
        const bestEq = analysis.candidates[0].equity;
        const isBlack = myColor === "black";

        return (
          <div
            style={{
              borderTop: "1px solid var(--color-border-subtle)",
              padding: "6px 12px 8px",
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {analysis.candidates.map((c, i) => {
              // Equity diff from best, from the player's perspective
              const diff = isBlack ? (bestEq - c.equity) : (c.equity - bestEq);
              const isSelected = selectedIdx === i;

              return (
                <div
                  key={i}
                  onClick={() => {
                    const next = isSelected ? null : i;
                    setSelectedIdx(next);
                    onSelectCandidate?.(next !== null ? c.moves : null);
                  }}
                  className="flex items-center gap-2"
                  style={{
                    padding: "5px 4px",
                    borderBottom: i < analysis.candidates.length - 1 ? "1px solid var(--color-border-subtle)" : "none",
                    cursor: "pointer",
                    background: isSelected ? "var(--color-analysis-gold-faint)" : "transparent",
                    borderRadius: 4,
                    transition: "background 0.1s",
                  }}
                >
                  <span
                    style={{
                      width: 18, textAlign: "center",
                      fontWeight: 700,
                      fontSize: "0.625rem",
                      color: i === 0 ? "var(--color-success)" : "var(--color-text-muted)",
                    }}
                  >
                    {i + 1}.
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6875rem",
                      color: c.isPlayed ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                      fontWeight: c.isPlayed ? 700 : 400,
                    }}
                  >
                    {c.notation || c.moves.map((m) => `${m.from}/${m.to}`).join(" ")}
                    {c.isPlayed && (
                      <span style={{ color: "var(--color-text-muted)", fontWeight: 400, marginLeft: 4 }}>
                        ←
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.625rem",
                      fontWeight: 600,
                      minWidth: 52,
                      textAlign: "right",
                      color: i === 0
                        ? "var(--color-success)"
                        : diff < -0.06
                          ? "var(--color-danger)"
                          : diff < -0.02
                            ? "var(--color-warning)"
                            : "var(--color-text-muted)",
                    }}
                  >
                    {i === 0 ? "Best" : diff >= 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3)}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

// ─── Slide-out Menu ────────────────────────────────────────────

function SlideOutMenu({
  onClose,
  onResign,
  onDouble,
  canDouble,
  onShowMoveList,
  cashTerms,
  cashTermsRequired,
  cubeValue,
}: {
  onClose: () => void;
  onResign: () => void;
  onDouble?: () => void;
  canDouble?: boolean;
  onShowMoveList?: () => void;
  cashTerms?: CashGameTerms | null;
  cashTermsRequired: boolean;
  cubeValue: number;
}) {
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [muted, setMuted] = useState(() => isSoundMuted());
  const { theme, setTheme } = useTheme();
  const themeLabels = { light: "Light", dark: "Dark", lux: "Lux" } as const;
  const themes = ["light", "dark", "lux"] as const;
  const nextTheme = themes[(themes.indexOf(theme) + 1) % themes.length];
  const financialTermsReady = !cashTermsRequired || cashTerms !== null;

  const menuItems = [
    { label: "Offer Double", action: () => { if (canDouble && onDouble) { onDouble(); onClose(); } }, disabled: !canDouble || !financialTermsReady },
    { label: "Resign", action: () => setShowResignConfirm(true), danger: true, disabled: !financialTermsReady },
    { type: "separator" as const },
    { label: "Move List", action: () => { onShowMoveList?.(); onClose(); } },
    { label: "Verify Dice", action: () => { window.open("/verify-rolls", "_blank"); onClose(); } },
    { type: "separator" as const },
    { label: `Sound: ${muted ? "Off" : "On"}`, action: () => { const next = !muted; setMuted(next); setSoundMuted(next); } },
    { label: `Theme: ${themeLabels[theme]}`, action: () => setTheme(nextTheme) },
  ];

  return (
    <>
      {/* Backdrop */}
      <div className="absolute inset-0 z-40" onClick={onClose} />

      {/* Panel */}
      <FocusTrap onEscape={onClose}>
        <div
          className="absolute top-0 right-0 z-50 flex flex-col animate-slide-in-right"
          role="dialog"
          aria-modal="true"
          aria-label="Game menu"
          style={{
            width: 200,
            height: "100%",
            background: "var(--color-bg-surface)",
            borderLeft: "1px solid var(--color-border-subtle)",
            padding: "16px 14px",
            gap: 3,
            boxShadow: "var(--shadow-elevated)",
          }}
        >
        <div className="flex justify-between items-center mb-2.5">
          <span className="text-[13px] font-bold text-[var(--color-text-primary)]">Menu</span>
          <button
            onClick={onClose}
            aria-label="Close menu"
            style={{ background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer", fontSize: "0.9375rem", minWidth: 44, minHeight: 44 }}
          >
            ✕
          </button>
        </div>

        {menuItems.map((item, i) =>
          "type" in item && item.type === "separator" ? (
            <div key={i} style={{ height: 1, background: "var(--color-border-subtle)", margin: "5px 0" }} />
          ) : (
            <button
              key={i}
              onClick={"action" in item ? item.action : undefined}
              disabled={"disabled" in item && !!item.disabled}
              className="text-left transition-colors hover:bg-[var(--color-bg-elevated)]"
              style={{
                padding: "11px 10px",
                borderRadius: 5,
                border: "none",
                background: "transparent",
                color: "danger" in item && item.danger ? "var(--color-danger)" : "disabled" in item && item.disabled ? "var(--color-text-muted)" : "var(--color-text-secondary)",
                fontSize: "0.75rem",
                fontWeight: 500,
                cursor: "disabled" in item && item.disabled ? "not-allowed" : "pointer",
                opacity: "disabled" in item && item.disabled ? 0.5 : 1,
              }}
            >
              {"label" in item ? item.label : ""}
            </button>
          )
        )}
        </div>
      </FocusTrap>

      {/* Resign confirmation modal */}
      {showResignConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center backdrop-blur-sm"
          style={{ background: "var(--color-overlay)" }}
          onClick={() => setShowResignConfirm(false)}
        >
          <FocusTrap onEscape={() => setShowResignConfirm(false)}>
            <div
              className="panel max-w-sm mx-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="resign-dialog-title"
              style={{ padding: "20px 24px" }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="resign-dialog-title" style={{ fontSize: "1.0625rem", fontWeight: 700, marginBottom: 6, color: "var(--color-text-primary)" }}>Resign game?</h3>
              <p style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)", marginBottom: cashTerms ? 8 : 20 }}>
                Resigning ends this game immediately as a normal loss.
              </p>
              {cashTerms && (
                <p style={{ fontSize: "0.8125rem", color: "var(--color-text-primary)", marginBottom: 20, fontWeight: 600 }}>
                  Gross loss: {formatMicroUsd(cashLiability(cashTerms, cubeValue))} verUSD at cube {cubeValue}. Rake is charged to the winner from that gross liability.
                </p>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => setShowResignConfirm(false)}
                  style={{
                    flex: 1,
                    padding: "10px 16px",
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    borderRadius: "var(--radius-button)",
                    background: "var(--color-bg-surface)",
                    color: "var(--color-text-primary)",
                    border: "1px solid var(--color-border-subtle)",
                    cursor: "pointer",
                    minHeight: 44,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowResignConfirm(false);
                    onResign();
                    onClose();
                  }}
                  aria-label="Resign game"
                  style={{
                    flex: 1,
                    padding: "10px 16px",
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    borderRadius: "var(--radius-button)",
                    background: "transparent",
                    color: "var(--color-danger)",
                    border: "1px solid var(--color-danger-muted)",
                    cursor: "pointer",
                    minHeight: 44,
                  }}
                >
                  Resign
                </button>
              </div>
            </div>
          </FocusTrap>
        </div>
      )}
    </>
  );
}

// ─── Center Controls (rendered inside Board center strip) ──────

function CenterControls({
  dice,
  movesRemaining,
  needsToRoll,
  canEndTurn,
  canUndo,
  isMyTurn,
  gameOver,
  onRollDice,
  onEndTurn,
  onUndo,
  openingRoll,
  cubeValue = 64,
  canDouble,
  onDouble,
  doubleOffered,
  doubleOfferedBy,
  doubleOfferDeadlineAt,
  myColor,
  currentPlayer,
  onAcceptDouble,
  onRejectDouble,
  forcedMoveNotice,
  activeDieIndex,
  onDieClick,
  cashTerms,
  outcomeCommandsBlocked,
  cashTermsRequired,
}: {
  dice: [number, number] | null;
  movesRemaining: number[];
  needsToRoll: boolean;
  canEndTurn: boolean;
  canUndo: boolean;
  isMyTurn: boolean;
  gameOver: boolean;
  onRollDice: () => void;
  onEndTurn: () => void;
  openingRoll: boolean;
  onUndo: () => void;
  cubeValue?: number;
  canDouble?: boolean;
  onDouble?: () => void;
  doubleOffered?: boolean;
  doubleOfferedBy?: Player | null;
  doubleOfferDeadlineAt?: string | null;
  myColor?: Player;
  currentPlayer?: Player;
  onAcceptDouble?: () => void;
  onRejectDouble?: () => void;
  forcedMoveNotice?: boolean;
  activeDieIndex?: 0 | 1;
  onDieClick?: () => void;
  cashTerms?: CashGameTerms | null;
  outcomeCommandsBlocked: boolean;
  cashTermsRequired: boolean;
}) {
  const decisionSeconds = useDeadlineSeconds(doubleOfferDeadlineAt);
  const financialTermsReady = !cashTermsRequired || !outcomeCommandsBlocked;
  const decisionOpen = decisionSeconds === null || decisionSeconds > 0;
  if (outcomeCommandsBlocked) {
    return <p role="alert" className="center-controls-notice max-w-lg text-center text-xs text-[var(--color-danger)]">Cash terms could not be reverified. Outcome-changing play is paused while the last verified terms remain visible.</p>;
  }


  // Show accept/reject prompt when opponent has offered a double
  if (doubleOffered && doubleOfferedBy && myColor && doubleOfferedBy !== myColor) {
    return (
      <div className="center-controls-double-offer flex max-w-lg flex-col items-center justify-center text-center" style={{ gap: 8 }}>
        <span className="text-sm font-bold text-[var(--color-gold-primary)]">
          Opponent offers cube {cubeValue * 2}
        </span>
        {cashTerms ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            Accept: {cashDecisionSummary(cashTerms, cubeValue * 2)} Decline: the game ends with a gross loss of {formatMicroUsd(cashLiability(cashTerms, cubeValue))} verUSD at cube {cubeValue}. Rake is charged to the winner.
          </p>
        ) : cashTermsRequired ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">Financial terms are unavailable. Accept and decline are disabled until the signed cash-game quote loads.</p>
        ) : null}
        {decisionSeconds !== null && (
          <p role="status" className="text-xs font-semibold text-[var(--color-text-primary)]">
            Respond within {decisionSeconds} second{decisionSeconds === 1 ? "" : "s"}.
          </p>
        )}
        <div className="center-controls-double-decision flex" style={{ gap: 8 }}>
          <button
            onClick={onAcceptDouble}
            disabled={!financialTermsReady || !decisionOpen || !onAcceptDouble}
            aria-label="Accept double"
            className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              padding: "8px 20px",
              minHeight: 44,
              borderRadius: 5,
              border: "none",
              background: "linear-gradient(135deg, var(--color-gold-dark), var(--color-gold-primary))",
              color: "var(--color-accent-fg)",
              fontSize: "0.75rem",
              fontWeight: 700,
            }}
          >
            Accept
          </button>
          <button
            onClick={onRejectDouble}
            disabled={!financialTermsReady || !decisionOpen || !onRejectDouble}
            aria-label="Decline double and lose at the current cube"
            className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              padding: "8px 20px",
              minHeight: 44,
              borderRadius: 5,
              border: "1px solid var(--color-border-subtle)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-danger)",
              fontSize: "0.75rem",
              fontWeight: 700,
            }}
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  // Show "Waiting for response..." when human offered a double
  if (doubleOffered && doubleOfferedBy && myColor && doubleOfferedBy === myColor) {
    return (
      <div className="flex items-center justify-center" style={{ gap: 16 }}>
        <DoublingCube value={cubeValue} />
        <span className="text-xs text-[var(--color-text-muted)]">
          Waiting for response{decisionSeconds === null ? "..." : ` · ${decisionSeconds}s remaining`}
        </span>
      </div>
    );
  }

  function getDiceList(): { value: number; used: boolean }[] {
    if (!dice) return [];
    if (dice[0] === dice[1]) {
      const rem = movesRemaining.length;
      return Array.from({ length: 4 }, (_, i) => ({ value: dice[0], used: i >= rem }));
    }
    return dice.map((v) => ({
      value: v,
      used: !movesRemaining.includes(v),
    }));
  }

  const diceList = getDiceList();

  return (
    <div className="center-controls flex flex-col items-center justify-center" style={{ gap: 4 }}>
      {forcedMoveNotice && (
        <span
          className="text-[10px] font-semibold animate-fade-in"
          style={{ color: "var(--color-text-muted)", letterSpacing: "0.05em" }}
        >
          Forced move
        </span>
      )}
      <div className="center-controls-primary flex items-center justify-center" style={{ gap: 16 }}>
      <DoublingCube value={cubeValue} />

      {needsToRoll ? (
        <div className="center-controls-roll-actions flex" style={{ gap: 8 }}>
          {canDouble && onDouble && (
            <button
              onClick={onDouble}
              aria-label="Offer double"
              className="cursor-pointer"
              style={{
                minHeight: 44,
                padding: "8px 18px",
                borderRadius: 5,
                border: "1.5px solid var(--color-gold-primary)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-text-primary)",
                fontSize: "0.8125rem",
                fontWeight: 700,
              }}
            >
              Double
            </button>
          )}
          <button
            onClick={onRollDice}
            aria-label={openingRoll ? "Reveal the committed opening roll" : "Roll dice"}
            title={openingRoll ? "Reveal Opening Roll (R)" : "Roll Dice (R)"}
            className="btn-primary"
            style={{ padding: "8px 24px", minHeight: 44, fontSize: "0.8125rem", fontWeight: 700 }}
          >
            {openingRoll ? "Reveal Opening Roll" : "Roll Dice"}
          </button>
        </div>
      ) : diceList.length > 0 ? (
        <div
          className="center-controls-dice flex"
          style={{ gap: 8, cursor: isMyTurn && dice && dice[0] !== dice[1] ? "pointer" : "default" }}
          onClick={isMyTurn && dice && dice[0] !== dice[1] && onDieClick ? onDieClick : undefined}
          role={isMyTurn && dice && dice[0] !== dice[1] && onDieClick ? "button" : undefined}
          tabIndex={isMyTurn && dice && dice[0] !== dice[1] && onDieClick ? 0 : undefined}
          aria-label={isMyTurn && dice && dice[0] !== dice[1] && onDieClick ? "Change active die" : undefined}
          onKeyDown={isMyTurn && dice && dice[0] !== dice[1] && onDieClick ? (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onDieClick();
            }
          } : undefined}
        >
          {diceList.map((d, i) => {
            const isDoubles = dice && dice[0] === dice[1];
            const isFront = !isDoubles && activeDieIndex === i && !d.used;
            return (
              <div
                key={i}
                style={{
                  borderRadius: 10,
                  border: isFront ? "2px solid var(--color-gold-primary)" : "2px solid transparent",
                  transition: "border-color 150ms",
                }}
              >
                <Die value={d.value} used={d.used} player={currentPlayer} />
              </div>
            );
          })}
        </div>
      ) : !isMyTurn ? (
        <span className="text-xs text-[var(--color-text-muted)]">Waiting...</span>
      ) : null}

      {(isMyTurn && dice || canEndTurn) && (
        <div className="center-controls-turn-actions flex" style={{ gap: 5 }}>
          {canUndo && (
            <button
              onClick={onUndo}
              aria-label="Undo last move"
              title="Undo Move (Z)"
              className="cursor-pointer transition-colors"
              style={{
                padding: "10px 14px",
                minHeight: 44,
                borderRadius: 5,
                border: "1px solid var(--color-border-subtle)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-text-secondary)",
                fontSize: "0.6875rem",
                fontWeight: 600,
              }}
            >
              Undo
            </button>
          )}
          {canEndTurn && (
            <button
              onClick={onEndTurn}
              aria-label="Confirm turn"
              title="End Turn (Enter)"
              className="cursor-pointer"
              style={{
                padding: "10px 14px",
                minHeight: 44,
                borderRadius: 5,
                border: "none",
                background: "linear-gradient(135deg, var(--color-gold-dark), var(--color-gold-primary))",
                color: "var(--color-accent-fg)",
                fontSize: "0.6875rem",
                fontWeight: 700,
              }}
            >
              Confirm
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Opponent Kebab Menu (Block / Report) ──────────────────────

const REPORT_REASONS = ["Cheating", "Harassment", "Inappropriate name", "Other"];

function ReportStatusNotice({
  action,
  onRetry,
}: {
  action: { status: "idle" | "pending" | "success" | "error"; error?: string; receiptId?: string };
  onRetry: (() => void) | undefined;
}) {
  if (action.status === "idle") return null;

  if (action.status === "pending") {
    return (
      <aside className="w-full max-w-[960px] rounded border border-[var(--color-gold-primary)] bg-[var(--color-bg-surface)] px-3 py-2 text-center text-sm text-[var(--color-text-secondary)]" role="status" aria-live="polite">
        Submitting your report. Waiting for the server acknowledgement…
      </aside>
    );
  }

  if (action.status === "success" && action.receiptId) {
    const supportHref = `/support?reference=${encodeURIComponent(action.receiptId)}`;
    return (
      <aside className="w-full max-w-[960px] rounded border border-[var(--color-success)] bg-[var(--color-bg-surface)] px-3 py-2 text-center text-sm" role="status" aria-live="polite">
        <p className="font-semibold text-[var(--color-success)]">Report received</p>
        <p className="mt-1 text-[var(--color-text-secondary)]">
          Receipt ID: <code className="select-text text-[var(--color-text-primary)]">{action.receiptId}</code>
        </p>
        <a className="mt-2 inline-flex min-h-11 items-center justify-center underline text-[var(--color-text-primary)]" href={supportHref}>
          Get support for this report
        </a>
      </aside>
    );
  }

  return (
    <aside className="w-full max-w-[960px] rounded border border-[var(--color-danger)] bg-[var(--color-bg-surface)] px-3 py-2 text-center text-sm" role="alert" aria-live="assertive">
      <p className="font-semibold text-[var(--color-danger)]">
        {action.status === "success"
          ? "The report acknowledgement did not include a receipt ID."
          : action.error ?? "Your report could not be submitted."}
      </p>
      {action.status === "error" && onRetry && (
        <button type="button" className="btn-secondary mt-2 min-h-11 px-4" onClick={onRetry}>
          Retry report
        </button>
      )}
    </aside>
  );
}

function OpponentKebabMenu({
  opponentAddress,
  onBlock,
  onReport,
  blockAction,
  reportAction,
}: {
  opponentAddress: string;
  onBlock: (address: string) => void;
  onReport: (address: string, reason: string) => void;
  blockAction: { status: "idle" | "pending" | "success" | "error"; error?: string };
  reportAction: { status: "idle" | "pending" | "success" | "error"; error?: string; receiptId?: string };
}) {
  const [open, setOpen] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0]);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowReport(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => { setOpen((p) => !p); setShowReport(false); }}
        aria-label="Player options"
        className="cursor-pointer transition-colors"
        style={{
          width: 44,
          height: 44,
          background: open ? "var(--color-bg-elevated)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-muted)",
          fontSize: "0.875rem",
          letterSpacing: "0.1em",
          padding: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: showReport ? 220 : 140,
            padding: showReport ? "10px 12px" : "4px",
            borderRadius: 8,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-border-subtle)",
            boxShadow: "var(--shadow-card)",
            zIndex: 50,
          }}
        >
          {showReport ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  color: "var(--color-text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Report Reason
              </span>
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-surface)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.75rem",
                  fontFamily: "var(--font-body)",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => setShowReport(false)}
                  style={{
                    flex: 1,
                    padding: "5px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--color-border-subtle)",
                    background: "transparent",
                    color: "var(--color-text-muted)",
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    minHeight: 44,
                    fontFamily: "var(--font-body)",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onReport(opponentAddress, reportReason);
                    setOpen(false);
                    setShowReport(false);
                  }}
                  disabled={reportAction.status === "pending"}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    padding: "5px 10px",
                    borderRadius: 6,
                    border: "none",
                    background: "var(--color-danger)",
                    color: "#fff",
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    cursor: reportAction.status === "pending" ? "wait" : "pointer",
                    fontFamily: "var(--font-body)",
                  }}
                >
                  {reportAction.status === "pending" ? "Submitting…" : "Submit"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => {
                  onBlock(opponentAddress);
                  setOpen(false);
                }}
                disabled={blockAction.status === "pending" || blockAction.status === "success"}
                style={{
                  display: "block",
                  width: "100%",
                  minHeight: 44,
                  textAlign: "left",
                  padding: "7px 10px",
                  borderRadius: 5,
                  border: "none",
                  background: "transparent",
                  color: blockAction.status === "success" ? "var(--color-text-muted)" : "var(--color-text-secondary)",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  cursor: blockAction.status === "pending" ? "wait" : "pointer",
                  fontFamily: "var(--font-body)",
                  opacity: blockAction.status === "success" ? 0.5 : 1,
                }}
              >
                {blockAction.status === "pending" ? "Blocking…" : blockAction.status === "success" ? "Blocked" : "Block Player"}
              </button>
              <button
                onClick={() => setShowReport(true)}
                disabled={reportAction.status === "pending" || reportAction.status === "success"}
                style={{
                  display: "block",
                  width: "100%",
                  minHeight: 44,
                  textAlign: "left",
                  padding: "7px 10px",
                  borderRadius: 5,
                  border: "none",
                  background: "transparent",
                  color: reportAction.status === "success" ? "var(--color-text-muted)" : "var(--color-danger)",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  cursor: reportAction.status === "pending" ? "wait" : "pointer",
                  fontFamily: "var(--font-body)",
                  opacity: reportAction.status === "success" ? 0.5 : 1,
                }}
              >
                {reportAction.status === "pending" ? "Submitting…" : reportAction.status === "success" ? "Reported" : "Report Player"}
              </button>
              {(blockAction.status === "error" || reportAction.status === "error") && (
                <p role="alert" className="px-2 text-xs text-[var(--color-danger)]">{blockAction.error ?? reportAction.error}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── GameScreen ────────────────────────────────────────────────

export function GameScreen({
  gameState,
  myColor,
  legalMoves,
  opponent,
  opponentDisconnected,
  winner,
  resultType,
  onMove,
  onRollDice,
  onEndTurn,
  onResign,
  onNewGame,
  onBackToLobby,
  onUndo,
  canUndo,
  turnStartedAt,
  lastOpponentMove,
  cubeValue = 1,
  cubeOwner,
  doubleOffered = false,
  doubleOfferedBy,
  doubleOfferDeadlineAt,
  canDouble = false,
  onDouble,
  onAcceptDouble,
  onRejectDouble,
  forcedMoveNotice = false,
  turnHistory,
  pendingConfirmation = false,
  disconnectCountdown,
  onSendReaction,
  lastReaction,
  onBlockPlayer,
  onReportPlayer,
  blockAction,
  reportAction,
  opponentAddress,
  matchState,
  matchOver = false,
  matchTurnHistory,
  turnTimeLimit = DEFAULT_TURN_TIME_LIMIT,
  cashTerms = null,
  cashTermsRequired = false,
  cashTermsVerified = false,
  onAcknowledgeRealityCheck,
  isAIGame,
  consultationEnabled,
  onToggleConsultation,
  consultationAnalysis,
  consultationAnalysisLoading,
  consultationHintLoading,
  hintMoves,
  consultationGnubgReady,
  canRequestHint,
  onRequestHint,
  onClearHint,
}: GameScreenProps) {
  const isMyTurn = gameState.currentPlayer === myColor;
  const outcomeCommandsBlocked = cashTermsRequired && !cashTermsVerified;
  const opponentColor: Player = myColor === "white" ? "black" : "white";
  const myPips = getPipCount(gameState.board, myColor);
  const opponentPips = getPipCount(gameState.board, opponentColor);
  const openingRoll = gameState.turnNumber === 0 && gameState.moveHistory.length === 0;
  const needsToRoll = !outcomeCommandsBlocked && (isMyTurn || openingRoll) && gameState.dice === null && !gameState.gameOver && !doubleOffered;
  const canEndTurn =
    !outcomeCommandsBlocked && (
      pendingConfirmation ||
      (isMyTurn &&
      gameState.dice !== null &&
      legalMoves.length === 0 &&
      !gameState.gameOver)
    );

  // Dice order state: front die (index 0) is always the one used for moves.
  // Clicking dice swaps the order. Resets to 0 on new roll.
  const [activeDieIndex, setActiveDieIndex] = useState<0 | 1>(0);

  useEffect(() => {
    setActiveDieIndex(0);
  }, [gameState.dice?.[0], gameState.dice?.[1]]);

  // Turn timer
  const [timeLeft, setTimeLeft] = useState(turnTimeLimit);
  useEffect(() => {
    if (!turnStartedAt || gameState.gameOver || outcomeCommandsBlocked) {
      setTimeLeft(turnTimeLimit);
      return;
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000);
      setTimeLeft(Math.max(0, turnTimeLimit - elapsed));
    };
    tick();
    const interval = setInterval(tick, TURN_TIMER_TICK_MS);
    return () => clearInterval(interval);
  }, [turnStartedAt, gameState.gameOver, outcomeCommandsBlocked, turnTimeLimit]);

  const [showMenu, setShowMenu] = useState(false);
  const [showMoveList, setShowMoveList] = useState(false);
  const [showPostGame, setShowPostGame] = useState(false);
  const [showDoubleConfirm, setShowDoubleConfirm] = useState(false);
  const [realityCheckNow, setRealityCheckNow] = useState(() => Date.now());
  const [acknowledgingRealityCheck, setAcknowledgingRealityCheck] = useState(false);
  const [realityCheckError, setRealityCheckError] = useState<string | null>(null);
  const [lastReportReason, setLastReportReason] = useState<string | null>(null);
  const cashSessionStartedAt = cashTerms?.cashSessionStartedAt ? Date.parse(cashTerms.cashSessionStartedAt) : Number.NaN;
  const realityCheckDueAt = cashTerms?.realityCheckDueAt ? Date.parse(cashTerms.realityCheckDueAt) : Number.NaN;
  const showRealityCheck = !gameState.gameOver && Number.isFinite(realityCheckDueAt) && realityCheckNow >= realityCheckDueAt;
  const realityCheckMinutes = Number.isFinite(cashSessionStartedAt)
    ? Math.max(1, Math.floor((realityCheckNow - cashSessionStartedAt) / 60_000))
    : null;

  useEffect(() => {
    if (!cashTerms || gameState.gameOver) return;
    const tick = () => setRealityCheckNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 15_000);
    return () => window.clearInterval(interval);
  }, [cashTerms?.cashSessionStartedAt, cashTerms?.realityCheckDueAt, gameState.gameOver]);

  useEffect(() => {
    setLastReportReason(null);
  }, [opponentAddress]);

  // Selected candidate moves from consultation panel (shown as arrows on board)
  const [selectedCandidateMoves, setSelectedCandidateMoves] = useState<Move[] | null>(null);

  // Point numbers toggle — persisted in localStorage
  const [showPointNumbers, setShowPointNumbers] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("gammon-show-point-numbers");
    return stored === null ? true : stored === "true";
  });
  const togglePointNumbers = useCallback(() => {
    setShowPointNumbers((prev) => {
      const next = !prev;
      localStorage.setItem("gammon-show-point-numbers", String(next));
      return next;
    });
  }, []);

  // ─── Aria-live announcements ─────────────────────────────────
  const [announcement, setAnnouncement] = useState("");
  const prevIsMyTurnRef = useRef(isMyTurn);
  const prevDiceRef = useRef(gameState.dice);
  const prevGameOverRef = useRef(gameState.gameOver);
  const prevOpponentDisconnectedRef = useRef(opponentDisconnected);
  const prevLastOpponentMoveRef = useRef(lastOpponentMove);

  // Announce turn changes
  useEffect(() => {
    if (prevIsMyTurnRef.current !== isMyTurn && !gameState.gameOver) {
      if (isMyTurn) {
        setAnnouncement("Your turn. Roll the dice.");
      } else {
        setAnnouncement("Opponent's turn.");
      }
    }
    prevIsMyTurnRef.current = isMyTurn;
  }, [isMyTurn, gameState.gameOver]);

  // Announce dice rolls
  useEffect(() => {
    const prevDice = prevDiceRef.current;
    const currentDice = gameState.dice;
    if (currentDice && (!prevDice || prevDice[0] !== currentDice[0] || prevDice[1] !== currentDice[1])) {
      setAnnouncement(`Dice rolled: ${currentDice[0]} and ${currentDice[1]}`);
    }
    prevDiceRef.current = currentDice;
  }, [gameState.dice]);

  // Announce game over
  useEffect(() => {
    if (gameState.gameOver && !prevGameOverRef.current) {
      if (winner === myColor) {
        setAnnouncement("Game over. You win!");
      } else {
        setAnnouncement("Game over. You lose.");
      }
    }
    prevGameOverRef.current = gameState.gameOver;
  }, [gameState.gameOver, winner, myColor]);

  // Announce opponent disconnect/reconnect
  useEffect(() => {
    if (opponentDisconnected && !prevOpponentDisconnectedRef.current) {
      setAnnouncement("Opponent disconnected");
    } else if (!opponentDisconnected && prevOpponentDisconnectedRef.current) {
      setAnnouncement("Opponent reconnected");
    }
    prevOpponentDisconnectedRef.current = opponentDisconnected;
  }, [opponentDisconnected]);

  // Announce opponent moves
  useEffect(() => {
    const prevMove = prevLastOpponentMoveRef.current;
    if (lastOpponentMove && (!prevMove || prevMove.from !== lastOpponentMove.from || prevMove.to !== lastOpponentMove.to)) {
      setAnnouncement(`Move: checker from point ${lastOpponentMove.from} to point ${lastOpponentMove.to}`);
    }
    prevLastOpponentMoveRef.current = lastOpponentMove;
  }, [lastOpponentMove]);

  // ─── Keyboard shortcuts ──────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Don't intercept when a modal is open
      if (showMenu || showDoubleConfirm || showRealityCheck || outcomeCommandsBlocked || gameState.gameOver) return;

      if (e.key === "r" || e.key === "R") {
        if (needsToRoll) {
          e.preventDefault();
          onRollDice();
        }

      } else if (e.key === "Enter") {
        if (canEndTurn) {
          e.preventDefault();
          onEndTurn();
        }
      } else if (e.key === "z" || e.key === "Z") {
        if (canUndo && (isMyTurn || pendingConfirmation)) {
          e.preventDefault();
          onUndo();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [needsToRoll, canEndTurn, canUndo, isMyTurn, pendingConfirmation, gameState.dice, gameState.gameOver, outcomeCommandsBlocked, showMenu, showDoubleConfirm, showRealityCheck, onRollDice, onEndTurn, onUndo]);

  const submitReport = useCallback((address: string, reason: string) => {
    if (!onReportPlayer) return;
    setLastReportReason(reason);
    onReportPlayer(address, reason);
  }, [onReportPlayer]);

  const retryReport = useCallback(() => {
    if (!opponentAddress || !lastReportReason || reportAction?.status !== "error") return;
    submitReport(opponentAddress, lastReportReason);
  }, [lastReportReason, opponentAddress, reportAction?.status, submitReport]);

  // Reset post-game view when a new game starts
  useEffect(() => {
    if (!gameState.gameOver) {
      setShowPostGame(false);
    }
  }, [gameState.gameOver]);

  const handleResign = useCallback(() => {
    if (cashTermsRequired && !cashTermsVerified) return;
    onResign();
  }, [cashTermsRequired, cashTermsVerified, onResign]);

  const requestDouble = useCallback(() => {
    if (!onDouble || (cashTermsRequired && !cashTermsVerified)) return;
    if (cashTerms) setShowDoubleConfirm(true);
    else onDouble();
  }, [cashTerms, cashTermsRequired, cashTermsVerified, onDouble]);

  const acknowledgeDueRealityCheck = useCallback(async () => {
    if (!onAcknowledgeRealityCheck || acknowledgingRealityCheck) return;
    setAcknowledgingRealityCheck(true);
    setRealityCheckError(null);
    try {
      await onAcknowledgeRealityCheck();
    } catch {
      setRealityCheckError("We could not record your acknowledgement. The game remains paused until the server confirms it.");
    } finally {
      setAcknowledgingRealityCheck(false);
    }
  }, [acknowledgingRealityCheck, onAcknowledgeRealityCheck]);

  const resultLabel =
    resultType === "backgammon"
      ? "Backgammon!"
      : resultType === "gammon"
        ? "Gammon!"
        : "Normal";

  const renderCenterControls = (className: string) => (
    <div className={className}>
      <CenterControls
        dice={gameState.dice}
        movesRemaining={gameState.movesRemaining}
        needsToRoll={needsToRoll}
        openingRoll={openingRoll}
        canEndTurn={canEndTurn}
        canUndo={canUndo}
        isMyTurn={!outcomeCommandsBlocked && (isMyTurn || pendingConfirmation)}
        gameOver={gameState.gameOver}
        onRollDice={onRollDice}
        onEndTurn={onEndTurn}
        onUndo={onUndo}
        cubeValue={cubeValue}
        canDouble={canDouble && !outcomeCommandsBlocked}
        onDouble={requestDouble}
        doubleOffered={doubleOffered}
        doubleOfferedBy={doubleOfferedBy}
        doubleOfferDeadlineAt={doubleOfferDeadlineAt}
        myColor={myColor}
        currentPlayer={gameState.currentPlayer}
        onAcceptDouble={onAcceptDouble}
        onRejectDouble={onRejectDouble}
        forcedMoveNotice={forcedMoveNotice}
        activeDieIndex={activeDieIndex}
        onDieClick={() => setActiveDieIndex(activeDieIndex === 0 ? 1 : 0)}
        cashTerms={cashTerms}
        cashTermsRequired={cashTermsRequired}
        outcomeCommandsBlocked={outcomeCommandsBlocked}
      />
    </div>
  );
  const centerControls = renderCenterControls("game-controls-in-board");

  // When showPostGame is active, render PostGameAnalysis full-screen
  // For match-end, flatten all per-game histories for full-match analysis
  if (gameState.gameOver && showPostGame) {
    const analysisHistory = matchTurnHistory && matchTurnHistory.length > 0
      ? matchTurnHistory.flat()
      : turnHistory;
    return (
      <PostGameAnalysis
        winner={winner}
        myColor={myColor}
        resultType={resultType}
        opponentName={opponent || "AI"}
        cubeValue={cubeValue}
        turnHistory={analysisHistory}
        onRematch={onNewGame}
        onBackToLobby={onBackToLobby ?? onNewGame}
        onBack={() => setShowPostGame(false)}
      />
    );
  }

  return (
    <div
      className="h-dvh flex flex-col w-full overflow-hidden"
      style={{ fontFamily: "var(--font-body)", color: "var(--color-text-primary)", userSelect: "none" }}
    >
      {/* Aria-live region for screen reader announcements */}
      <div aria-live="polite" aria-atomic="true" style={srOnlyStyle}>
        {announcement}
      </div>

      {showRealityCheck && cashTerms && !gameState.gameOver && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4" role="presentation" style={{ userSelect: "text" }}>
          <FocusTrap>
            <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="reality-check-title">
              <h2 id="reality-check-title" className="text-xl font-bold">Time and money check</h2>
              <p className="mt-3 text-[var(--color-text-secondary)]">
                Your server-recorded cash session began {formatCashTime(cashTerms.cashSessionStartedAt)} and has been active for about {realityCheckMinutes} minutes. Your current normal-result liability is {formatMicroUsd(cashLiability(cashTerms, cubeValue))} verUSD; your maximum reserved loss is {formatMicroUsd(BigInt(cashTerms.reservePerPlayerMicroUsd))} verUSD.
              </p>
              {cashTerms.testFunds && (
                <p className="mt-2 text-sm font-semibold text-[var(--color-warning)]">TEST FUNDS ONLY — no cash value.</p>
              )}
              <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                This check does not resign or settle the game. Leaving this screen does not confirm a payout or release the reserve. To forfeit, choose Resign from the game menu; it records a normal loss at the current cube, subject to final settlement. For support with limits or a break, review the responsible-play controls.
              </p>
              {realityCheckError && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{realityCheckError}</p>}
              <div className="mt-5 flex flex-wrap gap-3">
                <button type="button" autoFocus onClick={() => void acknowledgeDueRealityCheck()} disabled={!onAcknowledgeRealityCheck || acknowledgingRealityCheck} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                  {acknowledgingRealityCheck ? "Recording…" : "Continue game"}
                </button>
                <a href="/responsible-play" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border px-4 py-2 font-semibold">
                  Review play controls
                </a>
              </div>
            </div>
          </FocusTrap>
        </div>
      )}

      {/* Top Nav Header */}
      <TopNav
        onBack={onBackToLobby}
        onMenuToggle={() => setShowMenu(!showMenu)}
        showPointNumbers={showPointNumbers}
        onTogglePointNumbers={togglePointNumbers}
        matchState={matchState}
        isAIGame={isAIGame}
        consultationEnabled={consultationEnabled}
        onToggleConsultation={onToggleConsultation}
      />

      {/* Consultation Panel */}
      {consultationEnabled && (
        <ConsultationPanel
          analysis={consultationAnalysis ?? null}
          analysisLoading={consultationAnalysisLoading ?? false}
          hintLoading={consultationHintLoading ?? false}
          gnubgReady={consultationGnubgReady ?? false}
          isMyTurn={isMyTurn}
          hasDice={canRequestHint ?? (gameState.dice !== null && gameState.movesRemaining.length > 0)}
          onRequestHint={onRequestHint}
          onSelectCandidate={setSelectedCandidateMoves}
          myColor={myColor}
        />
      )}

      {/* Game Area */}
      <main className="game-screen-main flex-1 min-h-0 flex flex-col items-center relative px-0 sm:px-2 md:px-4" style={{ paddingTop: 2, paddingBottom: 2, gap: 2 }}>
        {/* Opponent bar */}
        <div className="w-full max-w-[960px] flex items-center gap-1">
          <div className="flex-1 min-w-0">
            <PlayerBar
              name={opponent || "Opponent"}
              color={opponentColor}
              isActive={!outcomeCommandsBlocked && !isMyTurn && !gameState.gameOver}
              timer={!outcomeCommandsBlocked && !isMyTurn && !gameState.gameOver && turnStartedAt ? timeLeft : null}
              isDisconnected={opponentDisconnected}
              isMe={false}
              matchScore={matchState ? { score: opponentColor === "white" ? matchState.whiteScore : matchState.blackScore, target: matchState.matchLength } : null}
            />
          </div>
          {opponentAddress && onBlockPlayer && onReportPlayer && (
            <OpponentKebabMenu
              opponentAddress={opponentAddress}
              onBlock={onBlockPlayer}
              onReport={submitReport}
              blockAction={blockAction ?? { status: "idle" }}
              reportAction={reportAction ?? { status: "idle" }}
            />
          )}
        </div>
        <ReportStatusNotice
          action={reportAction ?? { status: "idle" }}
          onRetry={lastReportReason ? retryReport : undefined}
        />
        {cashTermsRequired && !cashTermsVerified && (
          <p role="alert" className="w-full max-w-[960px] rounded border border-[var(--color-danger)] px-3 py-2 text-center text-xs text-[var(--color-danger)]">
            Cash terms could not be verified. Outcome-changing play and clock pressure are paused; the last verified terms remain visible while you retry.
          </p>
        )}
        {cashTerms && <CashGameContext terms={cashTerms} cubeValue={cubeValue} stale={cashTermsRequired && !cashTermsVerified} />}


        {/* Board */}
        <div className="game-board-shell flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden">
          <Board
            board={gameState.board}
            myColor={myColor}
            legalMoves={!outcomeCommandsBlocked && (isMyTurn || pendingConfirmation) ? legalMoves : []}
            isMyTurn={!outcomeCommandsBlocked && (isMyTurn || pendingConfirmation)}
            dice={gameState.dice}
            onMove={outcomeCommandsBlocked ? () => undefined : onMove}
            movesRemaining={gameState.movesRemaining}
            lastOpponentMove={lastOpponentMove}
            gameOver={gameState.gameOver}
            centerControls={centerControls}
            pipCounts={[opponentPips, myPips]}
            activeDieIndex={activeDieIndex}
            showPointNumbers={showPointNumbers}
            hintMoves={consultationEnabled ? (selectedCandidateMoves || hintMoves) : null}
          />
        </div>
        {renderCenterControls("game-controls-mobile")}


        {/* Player bar */}
        <div className="w-full max-w-[960px] flex items-center gap-1">
          <div className="flex-1 min-w-0">
            <PlayerBar
              name="You"
              color={myColor}
              isActive={!outcomeCommandsBlocked && isMyTurn && !gameState.gameOver}
              timer={!outcomeCommandsBlocked && isMyTurn && !gameState.gameOver && turnStartedAt ? timeLeft : null}
              isMe={true}
              matchScore={matchState ? { score: myColor === "white" ? matchState.whiteScore : matchState.blackScore, target: matchState.matchLength } : null}
            />
          </div>
          {onSendReaction && (
            <EmojiReactions
              onSend={onSendReaction}
              incomingReaction={lastReaction}
            />
          )}
        </div>
        {showDoubleConfirm && cashTerms && (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4 backdrop-blur-sm"
            style={{ background: "var(--color-overlay)" }}
            onClick={() => setShowDoubleConfirm(false)}
          >
            <FocusTrap onEscape={() => setShowDoubleConfirm(false)}>
              <section
                className="panel max-w-md"
                role="dialog"
                aria-modal="true"
                aria-labelledby="double-confirm-title"
                onClick={(event) => event.stopPropagation()}
              >
                <h2 id="double-confirm-title" className="text-lg font-bold">Offer cube {cubeValue * 2}?</h2>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  Your current normal-result gross exposure is {formatMicroUsd(cashLiability(cashTerms, cubeValue))} verUSD. If accepted, it becomes {formatMicroUsd(cashLiability(cashTerms, cubeValue * 2))} verUSD. Your maximum reserved loss remains {formatMicroUsd(BigInt(cashTerms.reservePerPlayerMicroUsd))} verUSD.
                </p>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  If the opponent declines, they lose at cube {cubeValue}. Rake is {cashTerms.rakeBps / 100}% of gross liability and is charged to the winner.
                </p>
                <div className="mt-5 flex gap-3">
                  <button className="btn-secondary min-h-11 flex-1" onClick={() => setShowDoubleConfirm(false)}>Cancel</button>
                  <button
                    className="btn-primary min-h-11 flex-1"
                    onClick={() => {
                      setShowDoubleConfirm(false);
                      onDouble?.();
                    }}
                  >
                    Offer cube {cubeValue * 2}
                  </button>
                </div>
              </section>
            </FocusTrap>
          </div>
        )}


        {/* Disconnect countdown banner */}
        {disconnectCountdown != null && disconnectCountdown > 0 && (
          <div
            className="absolute top-14 left-1/2 -translate-x-1/2 z-30 animate-fade-in"
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              background: "var(--color-danger)",
              color: "#fff",
              fontSize: "0.8125rem",
              fontWeight: 700,
              backdropFilter: "blur(8px)",
              whiteSpace: "nowrap",
            }}
          >
            Opponent disconnected — reconnection window: {disconnectCountdown}s
          </div>
        )}

        {/* Game over overlay — mid-match transition vs match-end result */}
        {gameState.gameOver && !matchOver && matchState && (
          // Mid-match: show score transition, auto-dismissed when next game starts
          <div className="absolute inset-0 flex items-center justify-center animate-fade-in z-30"
            style={{ background: "var(--color-overlay)", backdropFilter: "blur(6px)" }}
          >
            <div
              className="panel text-center max-w-xs mx-4 shadow-2xl"
              role="status"
              aria-live="polite"
              style={{
                padding: "36px 32px 28px",
                borderColor: winner === myColor
                  ? "var(--color-gold-primary)"
                  : "var(--color-danger)",
              }}
            >
              <p className="text-[var(--color-text-muted)] mb-2" style={{ fontSize: "0.75rem", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Game {matchState.gameNumber} of {matchState.matchLength * 2 - 1} Complete
              </p>
              <h2
                className={`font-display font-bold mb-4 ${
                  winner === myColor
                    ? "text-[var(--color-gold-primary)]"
                    : "text-[var(--color-danger)]"
                }`}
                style={{ fontSize: "1.5rem", lineHeight: 1.2 }}
              >
                {winner === myColor ? "You won this game!" : "You lost this game"}
              </h2>
              <div className="flex items-center justify-center gap-6 mb-5" style={{ fontSize: "1.125rem" }}>
                <span className="flex items-center gap-2">
                  <span style={{
                    display: "inline-block", width: 12, height: 12, borderRadius: "50%",
                    background: myColor === "white" ? "#e8e0d4" : "#2c2420",
                    border: "1px solid var(--color-border-subtle)",
                  }} />
                  <span style={{ fontWeight: 700 }}>You: {myColor === "white" ? matchState.whiteScore : matchState.blackScore}</span>
                </span>
                <span style={{ color: "var(--color-text-faint)" }}>—</span>
                <span className="flex items-center gap-2">
                  <span style={{
                    display: "inline-block", width: 12, height: 12, borderRadius: "50%",
                    background: opponentColor === "white" ? "#e8e0d4" : "#2c2420",
                    border: "1px solid var(--color-border-subtle)",
                  }} />
                  <span style={{ fontWeight: 700 }}>Opp: {opponentColor === "white" ? matchState.whiteScore : matchState.blackScore}</span>
                </span>
              </div>
              <p className="text-[var(--color-text-muted)] mb-4" style={{ fontSize: "0.8125rem" }}>
                Next game starting...
              </p>
              <button onClick={onNewGame} className="btn-secondary w-full" style={{ fontSize: "0.8125rem", padding: "10px 20px", opacity: 0.7 }}>
                Continue
              </button>
            </div>
          </div>
        )}

        {gameState.gameOver && (matchOver || !matchState) && (
          // Match-end (or single game): show full result overlay
          <div className="absolute inset-0 flex items-center justify-center animate-fade-in z-30"
            style={{ background: "var(--color-overlay)", backdropFilter: "blur(6px)" }}
          >
            <FocusTrap>
              <div
                className="panel text-center max-w-xs mx-4 shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-labelledby="gameover-dialog-title"
                style={{
                  padding: "40px 32px 32px",
                  borderColor: winner === myColor
                    ? "var(--color-gold-primary)"
                    : "var(--color-danger)",
                  boxShadow: winner === myColor
                    ? "var(--shadow-gold), var(--shadow-card)"
                    : "0 8px 40px var(--color-danger-muted), var(--shadow-card)",
                }}
              >
                <h2
                  id="gameover-dialog-title"
                  className={`font-display font-bold mb-3 ${
                    winner === myColor
                      ? "text-[var(--color-gold-primary)]"
                      : "text-[var(--color-danger)]"
                  }`}
                  style={{ fontSize: "2.125rem", lineHeight: 1.1 }}
                >
                  {matchState
                    ? (winner === myColor ? "Match Won!" : "Match Lost!")
                    : (winner === myColor ? "Victory!" : "Defeat")}
                </h2>
              {matchState && (
                <p className="text-[var(--color-text-secondary)] mb-2" style={{ fontSize: "1rem", fontWeight: 600 }}>
                  Final Score: {myColor === "white" ? matchState.whiteScore : matchState.blackScore} – {opponentColor === "white" ? matchState.whiteScore : matchState.blackScore}
                </p>
              )}
              <p className="text-[var(--color-text-muted)] mb-10" style={{ fontSize: "0.875rem", letterSpacing: "0.02em" }}>
                {resultLabel}
                {resultType === "gammon" && " — Double points"}
                {resultType === "backgammon" && " — Triple points"}
              </p>
              <div className="flex flex-col gap-3">
                <button onClick={() => setShowPostGame(true)} className="btn-primary w-full" style={{ fontSize: "0.9375rem", padding: "14px 20px" }}>
                  View Analysis
                </button>
                <button onClick={onNewGame} className="btn-secondary w-full" style={{ fontSize: "0.875rem", padding: "12px 20px" }}>
                  Play Again
                </button>
                <button onClick={onBackToLobby ?? onNewGame} className="btn-secondary w-full" style={{ fontSize: "0.8125rem", padding: "10px 20px", opacity: 0.7 }}>
                  Back to Lobby
                </button>
              </div>
              </div>
            </FocusTrap>
          </div>
        )}

        {/* Slide-out Menu */}
        {showMenu && (
          <SlideOutMenu
            onClose={() => setShowMenu(false)}
            onResign={handleResign}
            onDouble={requestDouble}
            canDouble={canDouble && !outcomeCommandsBlocked}
            onShowMoveList={() => setShowMoveList(true)}
            cashTerms={cashTerms}
            cashTermsRequired={cashTermsRequired}
            cubeValue={cubeValue}
          />
        )}

        {/* Move List Panel */}
        {showMoveList && turnHistory && (
          <>
            <div className="absolute inset-0 z-40" onClick={() => setShowMoveList(false)} />
            <FocusTrap onEscape={() => setShowMoveList(false)}>
              <div
                className="absolute top-0 right-0 z-50 flex flex-col animate-slide-in-right"
                role="dialog"
                aria-modal="true"
                aria-label="Move list"
                style={{
                  width: 240,
                  height: "100%",
                  background: "var(--color-bg-surface)",
                  borderLeft: "1px solid var(--color-border-subtle)",
                  padding: "16px 14px",
                  boxShadow: "var(--shadow-elevated)",
                  overflowY: "auto",
                }}
              >
                <div className="flex justify-between items-center mb-3">
                  <span className="text-[13px] font-bold text-[var(--color-text-primary)]">Move List</span>
                  <button
                    onClick={() => setShowMoveList(false)}
                    aria-label="Close move list"
                    style={{ background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer", fontSize: "0.9375rem", minWidth: 44, minHeight: 44 }}
                  >
                    ✕
                  </button>
                </div>
                {turnHistory.length === 0 ? (
                  <div style={{ fontSize: "0.75rem", color: "var(--color-text-faint)", textAlign: "center", padding: "20px 0" }}>
                    No moves yet
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {turnHistory.map((turn, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: "0.6875rem",
                          fontFamily: "var(--font-mono)",
                          padding: "4px 8px",
                          borderRadius: 4,
                          background: i % 2 === 0 ? "var(--color-bg-elevated)" : "transparent",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        <span style={{ color: turn.player === "white" ? "var(--color-text-primary)" : "var(--color-text-muted)", fontWeight: 600 }}>
                          {i + 1}. {turn.player === "white" ? "W" : "B"}
                        </span>{" "}
                        <span style={{ color: "var(--color-gold-primary)" }}>{turn.dice[0]}-{turn.dice[1]}</span>{" "}
                        {turn.moves.map((m, j) => (
                          <span key={j}>
                            {m.from === 25 || m.from === 0 ? "bar" : m.from}/{m.to === 0 || m.to === 25 ? "off" : m.to}
                            {j < turn.moves.length - 1 ? " " : ""}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </FocusTrap>
          </>
        )}
      </main>
    </div>
  );
}
