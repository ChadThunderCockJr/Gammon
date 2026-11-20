"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import type { BoardState, Move, Player } from "@xion-beginner/backgammon-core";
import { getPipCount } from "@xion-beginner/backgammon-core";
import { Card } from "@/components/ui";
import { analyzeGame, analyzeGameWithGnubg, estimateWinProbability } from "@/lib/analysis";
import { isGnubgReady, waitForGnubg } from "@/lib/gnubg";
import type { GameAnalysis, TurnAnalysis, CandidateMove as CandidateMoveData, ErrorClass, WinProbability } from "@/lib/analysis";

/* ── Theme Constants (CSS-variable-aware) ── */
const C = {
  bg: {
    deepest: "var(--color-bg-deepest)",
    deep: "var(--color-bg-base)",
    surface: "var(--color-bg-surface)",
    elevated: "var(--color-bg-elevated)",
    subtle: "var(--color-bg-subtle)",
  },
  border: {
    subtle: "var(--color-border-subtle)",
  },
  text: {
    primary: "var(--color-text-primary)",
    secondary: "var(--color-text-secondary)",
    muted: "var(--color-text-muted)",
    faint: "var(--color-text-faint)",
  },
  // Analysis-page gold accent (uses CSS vars for theme-aware contrast)
  gold: { primary: "var(--color-analysis-gold)", light: "var(--color-analysis-gold-light)", subtle: "var(--color-analysis-gold-subtle)", faint: "var(--color-analysis-gold-faint)", text: "var(--color-analysis-gold-text)" },
  // Checker/piece colors (fixed, theme-independent)
  piece: { white: "var(--color-checker-white)", black: "var(--color-checker-black)" },
  success: "var(--color-success)",
  error: "var(--color-danger)",
};
const F = {
  display: "var(--font-display)",
  body: "var(--font-body)",
  mono: "var(--font-mono)",
};
const W = { regular: 400, medium: 500, semibold: 600, bold: 700 };
const R = { card: 8, button: 6 };

/* ── Avatar ── */
function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: C.bg.elevated, border: `2px solid ${C.border.subtle}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.38, fontWeight: 700, color: C.text.secondary, flexShrink: 0,
    }}>{name[0]}</div>
  );
}

/* ── Section Header ── */
function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      <h3 style={{
        fontSize: "0.8125rem", fontWeight: W.bold, margin: 0,
        textTransform: "uppercase", letterSpacing: "0.04em", color: C.text.muted, fontFamily: F.body,
      }}>{title}</h3>
      {right}
    </div>
  );
}

/* ── Stat Box ── */
function StatBox({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div style={{
      textAlign: "center", flex: 1, padding: "12px 8px", borderRadius: 8,
      background: highlight ? C.bg.deep : "transparent",
      border: highlight ? `1px solid ${C.border.subtle}` : "none",
    }}>
      <div style={{ fontSize: "1.5rem", fontWeight: W.bold, color: C.text.primary, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: "0.625rem", color: C.text.muted, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: W.semibold }}>{label}</div>
      {sub && <div style={{ fontSize: "0.6875rem", color: C.text.secondary, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

/* ── Equity Graph ── */
function EquityGraph({ equityHistory, turns, selectedMove, totalMoves, onSelectMove }: {
  equityHistory: number[];
  turns: TurnAnalysis[];
  selectedMove: number;
  totalMoves: number;
  onSelectMove: (n: number) => void;
}) {
  const w = 560;
  const graphH = 120;
  const labelH = 18;
  const h = graphH + labelH;
  const n = equityHistory.length;
  if (n < 2) return null;

  // Smooth equity with a 3-point weighted moving average to reduce turn-to-turn noise
  const smoothed = equityHistory.map((eq, i, arr) => {
    if (i === 0 || i === arr.length - 1) return eq;
    return arr[i - 1] * 0.25 + eq * 0.5 + arr[i + 1] * 0.25;
  });

  const stepX = w / (n - 1);
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const toY = (eq: number) => graphH / 2 - (clamp(eq) * graphH) / 2;
  const midY = graphH / 2;

  // Build smooth bezier path through the points
  const pts = smoothed.map((eq, i) => ({ x: i * stepX, y: toY(eq) }));
  let pathD = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const tension = 0.3;
    const p0 = pts[Math.max(0, i - 2)];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[Math.min(pts.length - 1, i + 1)];
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;
    pathD += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }

  // Fill path closes to center line, not bottom
  const fillD = `${pathD} L ${pts[pts.length - 1].x} ${midY} L ${pts[0].x} ${midY} Z`;

  const errorDots = turns
    .filter(t => t.errorClass === "blunder" || t.errorClass === "mistake")
    .map(t => ({
      x: t.turnNumber * stepX,
      y: toY(smoothed[t.turnNumber] ?? t.equityAfter),
      color: t.errorClass === "blunder" ? C.error : C.gold.primary,
      turn: t.turnNumber,
    }));

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: "auto", aspectRatio: `${w} / ${h}` }}>
      <line x1="0" y1={midY} x2={w} y2={midY} stroke={C.bg.subtle} strokeWidth="1" strokeDasharray="4 4" />
      <path d={fillD} fill={C.gold.faint} />
      <path d={pathD} fill="none" stroke={C.gold.primary} strokeWidth="2" />
      {errorDots.map((b) => (
        <g key={b.turn} style={{ cursor: "pointer" }} onClick={() => onSelectMove(b.turn)}>
          <circle cx={b.x} cy={b.y} r="5" fill={C.bg.surface} stroke={b.color} strokeWidth="2" />
          <text x={b.x} y={b.y - 10} textAnchor="middle" fontSize="9" fill={b.color} fontWeight="600">!</text>
        </g>
      ))}
      {selectedMove >= 1 && selectedMove <= totalMoves && (
        <line
          x1={selectedMove * stepX} y1="0"
          x2={selectedMove * stepX} y2={graphH}
          stroke={C.gold.primary} strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6"
        />
      )}
      {/* Move number labels */}
      {turns.map(t => (
        <text key={`l${t.turnNumber}`}
          x={t.turnNumber * stepX} y={graphH + 13}
          textAnchor="middle" fontSize="9"
          fontFamily={F.mono}
          fontWeight={selectedMove === t.turnNumber ? 700 : 400}
          fill={selectedMove === t.turnNumber ? C.text.primary : C.text.muted}
          style={{ cursor: "pointer" }}
          onClick={() => onSelectMove(t.turnNumber)}
        >{t.turnNumber}</text>
      ))}
      {/* Clickable zones */}
      {turns.map(t => (
        <rect key={t.turnNumber}
          x={t.turnNumber * stepX - stepX / 2} y={0} width={stepX} height={graphH}
          fill="transparent" style={{ cursor: "pointer" }}
          onClick={() => onSelectMove(t.turnNumber)}
        />
      ))}
    </svg>
  );
}

/* ── Board Wireframe with Checkers & Move Arrows ── */
function BoardWireframe({ board, pip1, pip2, dice, arrows, arrowColor }: {
  board: BoardState | null;
  pip1: number; pip2: number;
  dice: number[];
  arrows: { from: number; to: number }[];
  arrowColor: string;
}) {
  const bW = 400;
  const bH = 220;
  const bar = 14;
  const half = (bW - bar) / 2;
  const pW = half / 6;
  const pH = 72;

  const pointToX = (pt: number) => {
    if (pt >= 13 && pt <= 18) return (pt - 13) * pW + pW / 2;
    if (pt >= 19 && pt <= 24) return half + bar + (pt - 19) * pW + pW / 2;
    if (pt >= 7 && pt <= 12) return (12 - pt) * pW + pW / 2;
    if (pt >= 1 && pt <= 6) return half + bar + (6 - pt) * pW + pW / 2;
    return bW / 2;
  };
  const pointIsTop = (pt: number) => pt >= 13 && pt <= 24;
  const arrowY = (pt: number) => pointIsTop(pt) ? 18 : bH - 18;

  const darkGreenTri = "var(--color-board-felt-dark)";
  const lightGreenTri = "var(--color-board-felt-light)";

  // Build checker data from board state
  const checkers: { point: number; count: number; isWhite: boolean; isTop: boolean }[] = [];
  if (board) {
    for (let i = 1; i <= 24; i++) {
      const val = board.points[i];
      if (val !== 0) {
        checkers.push({
          point: i,
          count: Math.abs(val),
          isWhite: val > 0,
          isTop: pointIsTop(i),
        });
      }
    }
  }

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: bW }}>
      <svg viewBox={`0 0 ${bW} ${bH}`} style={{ display: "block", width: "100%", height: "auto" }}>
        <rect x="0" y="0" width={bW} height={bH} rx={R.card} fill={C.bg.deep} stroke={C.bg.subtle} strokeWidth="1.5" />
        <rect x={half} y="0" width={bar} height={bH} fill={C.bg.elevated} />

        {/* Top points */}
        {Array.from({ length: 12 }, (_, i) => {
          const right = i >= 6;
          const x = right ? half + bar + (i - 6) * pW : i * pW;
          return (
            <polygon key={`t${i}`}
              points={`${x},0 ${x + pW},0 ${x + pW / 2},${pH}`}
              fill={i % 2 === 0 ? darkGreenTri : lightGreenTri}
              stroke={C.bg.subtle} strokeWidth="0.5"
            />
          );
        })}
        {/* Bottom points */}
        {Array.from({ length: 12 }, (_, i) => {
          const right = i >= 6;
          const x = right ? half + bar + (i - 6) * pW : i * pW;
          return (
            <polygon key={`b${i}`}
              points={`${x},${bH} ${x + pW},${bH} ${x + pW / 2},${bH - pH}`}
              fill={i % 2 === 0 ? lightGreenTri : darkGreenTri}
              stroke={C.bg.subtle} strokeWidth="0.5"
            />
          );
        })}

        {/* Checkers */}
        {checkers.map(({ point, count, isWhite, isTop }) => {
          const cx = pointToX(point);
          const maxShow = Math.min(count, 5);
          return Array.from({ length: maxShow }, (_, ci) => {
            const cy = isTop ? 12 + ci * 14 : bH - 12 - ci * 14;
            return (
              <circle key={`c${point}-${ci}`} cx={cx} cy={cy} r={6}
                fill={isWhite ? C.piece.white : C.piece.black}
                stroke={isWhite ? C.bg.subtle : C.piece.black} strokeWidth="1.5"
              />
            );
          });
        })}

        {/* Arrow marker */}
        <defs>
          <marker id="ah-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill={arrowColor} />
          </marker>
        </defs>

        {/* Move arrows */}
        {arrows.map((seg, i) => (
          <line key={`a${i}`}
            x1={pointToX(seg.from)} y1={arrowY(seg.from)}
            x2={pointToX(seg.to)} y2={arrowY(seg.to)}
            stroke={arrowColor} strokeWidth="2.5" markerEnd="url(#ah-arrow)"
          />
        ))}
      </svg>

      {/* Point numbers */}
      <div style={{
        display: "flex", fontSize: "0.5rem", color: C.text.muted, fontFamily: F.mono,
        fontWeight: W.semibold, padding: "2px 0 0",
      }}>
        <div style={{ display: "flex", width: half, justifyContent: "space-around" }}>
          {[13, 14, 15, 16, 17, 18].map(n => <span key={n}>{n}</span>)}
        </div>
        <div style={{ width: bar }} />
        <div style={{ display: "flex", width: half, justifyContent: "space-around" }}>
          {[19, 20, 21, 22, 23, 24].map(n => <span key={n}>{n}</span>)}
        </div>
      </div>

      {/* Pip counts */}
      <div style={{
        position: "absolute", top: "50%", right: -48, transform: "translateY(-50%)",
        display: "flex", flexDirection: "column", gap: 12, alignItems: "center",
      }}>
        <span style={{ fontSize: "0.9375rem", fontWeight: W.bold, color: C.text.primary }}>{pip1}</span>
        <span style={{ fontSize: "0.9375rem", fontWeight: W.bold, color: C.text.muted }}>{pip2}</span>
      </div>

      {/* Dice */}
      {dice && (
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)", display: "flex", gap: 5,
        }}>
          {dice.map((d, i) => (
            <div key={i} style={{
              width: 26, height: 26, borderRadius: R.button,
              background: C.gold.primary, border: `1.5px solid ${C.gold.text}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.8125rem", fontWeight: W.bold, color: C.gold.text,
            }}>{d}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Candidate Move Row (Galaxy-style) ── */
function CandidateMoveRow({ notation, equityDiff, isPlayed, isBest, isSelected, onClick }: {
  notation: string; equityDiff: string; isPlayed: boolean; isBest: boolean; isSelected: boolean; onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={isSelected} aria-label={`${notation}${isPlayed ? ", played move" : ""}${isBest ? ", best move" : ""}, equity ${equityDiff}`} onClick={onClick} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 12px", borderRadius: R.button,
      background: isPlayed ? C.gold.primary : isSelected ? C.bg.deep : "transparent",
      color: isPlayed ? C.gold.text : C.text.primary,
      cursor: "pointer", transition: "all 0.12s ease",
      borderTop: isSelected && !isPlayed ? `1px solid ${C.border.subtle}` : "none",
      borderRight: isSelected && !isPlayed ? `1px solid ${C.border.subtle}` : "none",
      borderBottom: isSelected && !isPlayed ? `1px solid ${C.border.subtle}` : !isPlayed ? `1px solid ${C.border.subtle}` : "none",
      borderLeft: isSelected && !isPlayed ? `1px solid ${C.border.subtle}` : "none",
      boxShadow: isSelected && !isPlayed ? "var(--shadow-card)" : "none",
      width: "100%", textAlign: "left", font: "inherit",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
        <div style={{
          width: 9, height: 9, borderRadius: "50%",
          background: isPlayed ? C.gold.text : isBest ? C.gold.primary : isSelected ? C.text.secondary : C.bg.subtle,
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: "0.8125rem", fontWeight: isPlayed || isBest || isSelected ? W.bold : W.medium,
          fontFamily: F.mono, letterSpacing: "-0.01em",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{notation}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {isPlayed && (
          <span style={{
            fontSize: "0.5625rem", fontWeight: W.bold, padding: "2px 6px", borderRadius: 3,
            background: isPlayed && isBest ? C.gold.text : "var(--color-bg-subtle)",
            color: isPlayed && isBest ? C.gold.primary : C.gold.text,
            textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap",
          }}>Played</span>
        )}
        <span style={{
          fontSize: "0.75rem", fontWeight: W.semibold, fontFamily: F.mono,
          color: isPlayed ? "var(--color-text-muted)" : isBest ? C.text.primary : C.text.secondary,
        }}>
          {isBest && !isPlayed ? equityDiff : `(${equityDiff})`}
        </span>
      </div>
    </button>
  );
}

/* ── Winning Chances Bar ── */
function WinningChances({ whiteWin, blackWin }: { whiteWin: number; blackWin: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.piece.white, border: "1px solid var(--color-border-subtle)", flexShrink: 0 }} />
        <span style={{ fontSize: "0.875rem", fontWeight: W.bold, minWidth: 48 }}>{whiteWin}%</span>
        <span style={{ fontSize: "0.6875rem", color: C.text.muted }}>White</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.piece.black, flexShrink: 0 }} />
        <span style={{ fontSize: "0.875rem", fontWeight: W.bold, minWidth: 48 }}>{blackWin}%</span>
        <span style={{ fontSize: "0.6875rem", color: C.text.muted }}>Black</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: C.bg.elevated, overflow: "hidden", marginTop: 2 }}>
        <div style={{ height: "100%", width: `${whiteWin}%`, background: C.gold.primary, borderRadius: 3 }} />
      </div>
    </div>
  );
}

/* ── Move Row ── */
function MoveRow({ moveNum, dice, move, equity, error, isBlunder, isSelected, onClick, player }: {
  moveNum: number; dice: number[]; move: string; equity: number;
  error: string | null; isBlunder: boolean; isSelected: boolean;
  onClick: () => void; player?: Player;
}) {
  return (
    <button type="button" aria-pressed={isSelected} aria-label={`Move ${moveNum}, dice ${dice.join(" and ")}, ${move}${error ? `, ${error}` : ""}`} onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 12px", borderRadius: R.button,
      background: isSelected ? C.bg.deep : "transparent",
      border: isSelected ? `1px solid ${C.border.subtle}` : "1px solid transparent",
      cursor: "pointer", transition: "background 0.1s",
      width: "100%", textAlign: "left", font: "inherit",
    }}>
      <span style={{ width: 28, fontSize: "0.75rem", fontWeight: W.semibold, color: C.text.muted, textAlign: "center" }}>{moveNum}</span>
      {player && (
        <div style={{
          width: 12, height: 12, borderRadius: "50%",
          background: player === "white" ? C.piece.white : C.piece.black,
          border: `1.5px solid ${player === "white" ? C.border.subtle : C.piece.black}`,
          flexShrink: 0,
        }} />
      )}
      <div style={{ display: "flex", gap: 2, width: 44 }}>
        {dice.map((d, i) => (
          <div key={i} style={{
            width: 18, height: 18, borderRadius: 3,
            background: C.bg.elevated, border: `1px solid ${C.border.subtle}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "0.625rem", fontWeight: W.bold, color: C.text.primary,
          }}>{d}</div>
        ))}
      </div>
      <span style={{ flex: 1, fontSize: "0.8125rem", fontWeight: W.medium, color: C.text.primary, fontFamily: F.mono }}>{move}</span>
      <span style={{
        fontSize: "0.75rem", fontWeight: W.semibold, width: 50, textAlign: "right",
        color: equity >= 0 ? C.text.primary : C.text.muted,
      }}>
        {equity >= 0 ? "+" : ""}{equity.toFixed(3)}
      </span>
      {error && (
        <span style={{
          fontSize: "0.625rem", fontWeight: W.bold, padding: "2px 6px", borderRadius: 3,
          background: isBlunder ? C.error : C.bg.elevated,
          color: isBlunder ? C.text.primary : C.text.secondary,
          minWidth: 50, textAlign: "center",
        }}>{error}</span>
      )}
    </button>
  );
}

/* =======================================================================
   MAIN COMPONENT
   ======================================================================= */

interface TurnRecordProp {
  player: Player;
  dice: [number, number];
  moves: { from: number; to: number; die: number }[];
  boardBefore?: { points: number[]; whiteOff: number; blackOff: number };
}

export interface PostGameAnalysisProps {
  winner: Player | null;
  myColor: Player;
  resultType: string | null;
  opponentName: string;
  cubeValue?: number;
  turnHistory?: TurnRecordProp[];
  onRematch?: () => void;
  onBackToLobby: () => void;
  onBack: () => void;
}


function formatMoveNotation(moves: { from: number; to: number }[]): string {
  if (moves.length === 0) return "(no moves)";
  return moves.map(m => `${m.from}/${m.to}`).join(" ");
}

export function PostGameAnalysis({
  winner, myColor, resultType, opponentName, turnHistory,
  onRematch, onBackToLobby, onBack,
}: PostGameAnalysisProps) {
  const hasRealData = turnHistory && turnHistory.length > 0;

  // ── Analysis engine (WASM-based when available, heuristic fallback) ──
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<{ current: number; total: number } | null>(null);
  const [engineLoading, setEngineLoading] = useState(!isGnubgReady());

  useEffect(() => {
    if (!turnHistory || turnHistory.length === 0) {
      setAnalysis(null);
      return;
    }

    let cancelled = false;

    async function runAnalysis() {
      // Wait for the GNUBG engine to load
      if (!isGnubgReady()) {
        setEngineLoading(true);
        try {
          await waitForGnubg();
        } catch {
          // Engine failed to load — fall back to heuristic
          if (!cancelled) {
            setEngineLoading(false);
            setAnalysis(analyzeGame(turnHistory!));
          }
          return;
        }
        if (cancelled) return;
        setEngineLoading(false);
      }

      // Run WASM analysis
      setAnalysisProgress({ current: 0, total: turnHistory!.length });
      try {
        const wasmAnalysis = await analyzeGameWithGnubg(turnHistory!, (current, total) => {
          if (!cancelled) setAnalysisProgress({ current, total });
        });
        if (!cancelled) {
          setAnalysis(wasmAnalysis);
          setAnalysisProgress(null);
        }
      } catch {
        // Fall back to heuristic on failure
        if (!cancelled) {
          setAnalysis(analyzeGame(turnHistory!));
          setAnalysisProgress(null);
        }
      }
    }

    runAnalysis();
    return () => { cancelled = true; };
  }, [turnHistory]);

  // Build display moves
  type DisplayMove = {
    moveNum: number; dice: number[]; move: string; player: Player;
    equity: number; error: string | null; isBlunder: boolean;
    turnAnalysis?: TurnAnalysis;
  };

  const displayMoves: DisplayMove[] = useMemo(() => {
    if (analysis && hasRealData) {
      return analysis.turns.map(turn => ({
        moveNum: turn.turnNumber,
        dice: turn.dice as number[],
        move: turn.playedNotation,
        player: turn.player,
        equity: turn.equityAfter,
        error: turn.errorClass ? turn.errorClass.charAt(0).toUpperCase() + turn.errorClass.slice(1) : null,
        isBlunder: turn.errorClass === "blunder",
        turnAnalysis: turn,
      }));
    }
    if (hasRealData) {
      return turnHistory.map((turn, i) => ({
        moveNum: i + 1, dice: turn.dice as number[],
        move: formatMoveNotation(turn.moves), player: turn.player,
        equity: 0, error: null, isBlunder: false,
      }));
    }
    return [];
  }, [analysis, hasRealData, turnHistory]);

  const [activeTab, setActiveTab] = useState("analysis");
  const [selectedMove, setSelectedMove] = useState(1);
  const [analysisMode, setAnalysisMode] = useState("checker");
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);

  const [winProb, setWinProb] = useState<{ white: number; black: number } | null>(null);

  const selectMove = (num: number) => {
    setSelectedMove(num);
    setSelectedCandidate(null);
  };

  const iWon = winner === myColor;
  const resultLabel = resultType === "backgammon" ? "Backgammon" : resultType === "gammon" ? "Gammon" : "Normal";

  // Stats
  const totalTurns = displayMoves.length;
  const doublesCount = displayMoves.filter(m => m.dice[0] === m.dice[1]).length;

  const computeAvgRoll = (moves: DisplayMove[]) => {
    if (moves.length === 0) return 0;
    return moves.reduce((sum, m) => sum + m.dice[0] + m.dice[1], 0) / moves.length;
  };
  const myMoves = hasRealData ? displayMoves.filter(m => m.player === myColor) : displayMoves;
  const oppMoves = hasRealData ? displayMoves.filter(m => m.player !== myColor) : [];

  // Current selected turn analysis
  const selectedTurnAnalysis = analysis?.turns.find(t => t.turnNumber === selectedMove) ?? null;
  const currentDisplayMove = displayMoves[selectedMove - 1];

  // Win probability: use gnubg neural net data when available, else Monte Carlo
  useEffect(() => {
    if (!selectedTurnAnalysis?.boardBefore) {
      setWinProb(null);
      return;
    }

    // Use gnubg probability if available (from WASM analysis)
    if (selectedTurnAnalysis.probability) {
      const p = selectedTurnAnalysis.probability;
      const whiteWin = selectedTurnAnalysis.player === "white"
        ? Math.round((p.win + p.winG + p.winBG) * 100)
        : Math.round((p.lose + p.loseG + p.loseBG) * 100);
      setWinProb({ white: whiteWin, black: 100 - whiteWin });
      return;
    }

    // Fallback: Monte Carlo simulation
    setWinProb(null);
    const board = selectedTurnAnalysis.boardBefore;
    const nextPlayer = selectedTurnAnalysis.player;
    const handle = requestAnimationFrame(() => {
      setWinProb(estimateWinProbability(board, nextPlayer, 150));
    });
    return () => cancelAnimationFrame(handle);
  }, [selectedTurnAnalysis]);

  // Summaries
  const mySummary = analysis ? (myColor === "white" ? analysis.whiteSummary : analysis.blackSummary) : null;
  const oppSummary = analysis ? (myColor === "white" ? analysis.blackSummary : analysis.whiteSummary) : null;

  // Derive the graph from recorded move equities when no aggregate series was stored.
  // Append final game result: +1 if white won, -1 if black won
  const baseEquityHistory = analysis?.equityHistory ?? [0, ...displayMoves.map(m => m.equity)];
  const equityHistory = winner
    ? [...baseEquityHistory, winner === "white" ? 1 : -1]
    : baseEquityHistory;
  const graphTurns: TurnAnalysis[] = analysis?.turns ?? displayMoves.map(m => ({
    turnNumber: m.moveNum, player: m.player, dice: m.dice as [number, number],
    playedMoves: [], playedNotation: m.move, equityAfter: m.equity, bestEquity: m.equity,
    equityLoss: 0, errorClass: (m.error?.toLowerCase() ?? null) as ErrorClass,
    candidates: [], boardBefore: { points: new Array(26).fill(0), whiteOff: 0, blackOff: 0 },
  }));

  // Board & arrows for analysis tab — single set of arrows for whichever move is active
  const boardBefore = selectedTurnAnalysis?.boardBefore ?? null;
  const pip1 = boardBefore ? getPipCount(boardBefore, "white") : 0;
  const pip2 = boardBefore ? getPipCount(boardBefore, "black") : 0;

  // Determine which arrows to show and their color
  const activeArrows = (() => {
    if (selectedCandidate !== null && selectedTurnAnalysis?.candidates[selectedCandidate]) {
      const cand = selectedTurnAnalysis.candidates[selectedCandidate];
      const isBest = selectedCandidate === 0;
      const isPlayed = cand.isPlayed;
      let color = C.gold.primary;
      if (!isPlayed && !isBest) {
        // Compare to best to decide color
        const bestEquity = selectedTurnAnalysis.candidates[0]?.equity ?? cand.equity;
        const diff = selectedTurnAnalysis.player === "white"
          ? cand.equity - bestEquity
          : bestEquity - cand.equity;
        color = diff < -0.01 ? C.error : diff > 0.01 ? C.success : C.gold.primary;
      } else if (isBest) {
        color = C.success;
      } else if (isPlayed && selectedTurnAnalysis.errorClass) {
        color = C.error;
      }
      return { arrows: cand.moves.map(m => ({ from: m.from, to: m.to })), color };
    }
    // Default: show the played move
    const arrows = selectedTurnAnalysis?.playedMoves.map(m => ({ from: m.from, to: m.to })) ?? [];
    const color = currentDisplayMove?.error ? C.error : C.gold.primary;
    return { arrows, color };
  })();

  // Bottom bar data
  const bottomBarPlayed = selectedCandidate !== null && selectedTurnAnalysis?.candidates[selectedCandidate]
    ? selectedTurnAnalysis.candidates[selectedCandidate].notation
    : selectedTurnAnalysis?.playedNotation ?? currentDisplayMove?.move ?? "";
  const bottomBarBest = selectedTurnAnalysis?.candidates[0]?.notation ?? bottomBarPlayed;

  return (
    <div style={{
      minHeight: "100vh", background: C.bg.deepest,
      display: "flex", flexDirection: "column", fontFamily: F.body, color: C.text.primary,
    }}>
      {/* ─── Header ─── */}
      <header style={{
        background: C.bg.surface, borderBottom: `1px solid ${C.border.subtle}`,
        padding: "12px 16px",
      }}>
        {/* Top row: nav + actions */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <button onClick={onBack} style={{
            background: "none", border: "none", color: C.text.secondary,
            cursor: "pointer", fontSize: "0.8125rem", fontWeight: W.medium,
            display: "flex", alignItems: "center", gap: 4, fontFamily: F.body, padding: 0,
          }}>&larr; Back</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onBackToLobby} style={{
              padding: "6px 14px", borderRadius: R.button,
              border: `1px solid ${C.border.subtle}`, background: "transparent",
              fontSize: "0.75rem", fontWeight: W.semibold, color: C.text.secondary, cursor: "pointer", fontFamily: F.body,
            }}>Home</button>
            {onRematch && (
              <button onClick={onRematch} style={{
                padding: "12px 32px",
                borderRadius: 8,
                border: "none",
                background: "var(--color-gold-primary)",
                color: "var(--color-text-on-gold)",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}>Rematch</button>
            )}
          </div>
        </div>

        {/* Result row: players + outcome */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Avatar name="Y" size={32} />
            <span style={{ fontSize: "0.8125rem", fontWeight: W.bold }}>You</span>
          </div>
          <div style={{
            fontSize: "0.875rem", fontWeight: W.bold, fontFamily: F.display,
            color: iWon ? C.gold.primary : C.error,
            padding: "2px 10px", borderRadius: 4,
            background: iWon ? C.gold.faint : "var(--color-danger-muted)",
          }}>
            {iWon ? "Victory" : "Defeat"} &middot; {resultLabel}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: "0.8125rem", fontWeight: W.bold }}>{opponentName}</span>
            <Avatar name={opponentName[0] || "O"} size={32} />
          </div>
        </div>
      </header>

      {/* ─── Tab Bar ─── */}
      <div style={{
        display: "flex", gap: 4, borderBottom: `1px solid ${C.border.subtle}`,
        background: C.bg.surface, padding: "0 24px",
      }}>
        {[
          { key: "summary", label: "Summary" },
          { key: "analysis", label: "Analysis" },
          { key: "moves", label: "Move List" },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setActiveTab(key)} className="px-3 py-2 sm:px-5 sm:py-3 text-xs sm:text-[13px]" style={{
            background: "none", border: "none",
            borderBottom: activeTab === key ? `2px solid ${C.gold.primary}` : "2px solid transparent",
            fontWeight: activeTab === key ? W.bold : W.medium,
            color: activeTab === key ? C.text.primary : C.text.muted,
            cursor: "pointer", fontFamily: F.body,
          }}>{label}</button>
        ))}
      </div>

      {/* ─── Content ─── */}
      <main className="p-3 sm:p-4 md:p-6" style={{ flex: 1, overflow: "auto" }}>

        {/* ═══ SUMMARY TAB ═══ */}
        {activeTab === "summary" && (engineLoading || !analysis) && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 16, padding: "80px 24px", textAlign: "center",
          }}>
            <div style={{
              width: 32, height: 32, border: `3px solid ${C.gold.primary}`,
              borderTopColor: "transparent", borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
            <span style={{ fontSize: "0.875rem", fontWeight: W.semibold, color: C.gold.primary }}>
              Loading GNU Backgammon engine...
            </span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {activeTab === "summary" && !engineLoading && analysis && (
          <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Performance Rating */}
            {mySummary && oppSummary && (
              <Card>
                <SectionHeader title="Performance Rating" />
                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
                  <div style={{ flex: 1, padding: 16, borderRadius: 8, background: C.bg.deep, border: `1px solid ${C.border.subtle}`, textAlign: "center" }}>
                    <div style={{ fontSize: "0.6875rem", color: C.text.muted, textTransform: "uppercase", fontWeight: W.semibold, marginBottom: 8 }}>You</div>
                    <div style={{ fontSize: "2rem", fontWeight: W.bold, color: C.text.primary }}>{mySummary.performanceRating}</div>
                    <div style={{ fontSize: "0.75rem", color: C.text.secondary, marginTop: 4 }}>
                      {mySummary.performanceRating >= 80 ? "Expert" : mySummary.performanceRating >= 50 ? "Advanced" : mySummary.performanceRating >= 30 ? "Intermediate" : "Beginner"}
                    </div>
                    <div style={{ fontSize: "0.6875rem", color: C.text.muted, marginTop: 8 }}>
                      {mySummary.blunders} blunder{mySummary.blunders !== 1 ? "s" : ""} · {mySummary.mistakes} mistake{mySummary.mistakes !== 1 ? "s" : ""} · {mySummary.inaccuracies} inaccurac{mySummary.inaccuracies !== 1 ? "ies" : "y"}
                    </div>
                  </div>
                  <div style={{ flex: 1, padding: 16, borderRadius: 8, background: C.bg.deep, border: `1px solid ${C.border.subtle}`, textAlign: "center" }}>
                    <div style={{ fontSize: "0.6875rem", color: C.text.muted, textTransform: "uppercase", fontWeight: W.semibold, marginBottom: 8 }}>{opponentName}</div>
                    <div style={{ fontSize: "2rem", fontWeight: W.bold, color: C.text.muted }}>{oppSummary.performanceRating}</div>
                    <div style={{ fontSize: "0.75rem", color: C.text.secondary, marginTop: 4 }}>
                      {oppSummary.performanceRating >= 80 ? "Expert" : oppSummary.performanceRating >= 50 ? "Advanced" : oppSummary.performanceRating >= 30 ? "Intermediate" : "Beginner"}
                    </div>
                    <div style={{ fontSize: "0.6875rem", color: C.text.muted, marginTop: 8 }}>
                      {oppSummary.blunders} blunder{oppSummary.blunders !== 1 ? "s" : ""} · {oppSummary.mistakes} mistake{oppSummary.mistakes !== 1 ? "s" : ""} · {oppSummary.inaccuracies} inaccurac{oppSummary.inaccuracies !== 1 ? "ies" : "y"}
                    </div>
                  </div>
                </div>
              </Card>
            )}

            <Card>
              <SectionHeader title="Match Statistics" />
              <div className="flex flex-wrap gap-2" style={{ display: "flex" }}>
                <StatBox label="Total Moves" value={String(totalTurns)} />
                <StatBox label="Doubles" value={String(doublesCount)} />
                <StatBox label="Result" value={resultLabel} />
              </div>
            </Card>

            <Card>
              <SectionHeader title="Dice Statistics" />
              <div style={{ display: "flex", gap: 16 }}>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: "0.6875rem", color: C.text.muted, textTransform: "uppercase", fontWeight: W.semibold, marginBottom: 8 }}>Your avg roll</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: W.bold }}>{computeAvgRoll(myMoves) > 0 ? computeAvgRoll(myMoves).toFixed(1) : "\u2014"}</div>
                </div>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: "0.6875rem", color: C.text.muted, textTransform: "uppercase", fontWeight: W.semibold, marginBottom: 8 }}>Their avg roll</div>
                  <div style={{ fontSize: "1.5rem", fontWeight: W.bold }}>{computeAvgRoll(oppMoves) > 0 ? computeAvgRoll(oppMoves).toFixed(1) : "\u2014"}</div>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* ═══ ANALYSIS TAB (Galaxy-style) ═══ */}
        {activeTab === "analysis" && (engineLoading || (analysisProgress && !analysis)) && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 16, padding: "80px 24px", textAlign: "center",
          }}>
            <div style={{
              width: 32, height: 32, border: `3px solid ${C.gold.primary}`,
              borderTopColor: "transparent", borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
            <span style={{ fontSize: "0.875rem", fontWeight: W.semibold, color: C.gold.primary }}>
              {engineLoading
                ? "Loading GNU Backgammon engine..."
                : `Analyzing with GNU Backgammon engine... (${analysisProgress!.current}/${analysisProgress!.total})`}
            </span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {activeTab === "analysis" && !engineLoading && !(analysisProgress && !analysis) && (
          <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* WASM analysis progress (upgrading existing results) */}
            {analysisProgress && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 14px", borderRadius: R.card,
                background: C.gold.faint, border: `1px solid ${C.gold.subtle}`,
              }}>
                <div style={{
                  width: 14, height: 14, border: `2px solid ${C.gold.primary}`,
                  borderTopColor: "transparent", borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }} />
                <span style={{ fontSize: "0.75rem", fontWeight: W.semibold, color: C.gold.primary }}>
                  Analyzing with GNU Backgammon engine... ({analysisProgress.current}/{analysisProgress.total})
                </span>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}

            {/* Equity Graph */}
            <Card>
              <SectionHeader title="Equity Graph" right={
                <span style={{ fontSize: "0.6875rem", color: C.text.muted }}>! = blunder or mistake</span>
              } />
              <EquityGraph
                equityHistory={equityHistory}
                turns={graphTurns}
                selectedMove={selectedMove}
                totalMoves={totalTurns}
                onSelectMove={selectMove}
              />
            </Card>

            {/* Three-column layout */}
            <div className="flex flex-col lg:flex-row gap-3 lg:gap-4" style={{ alignItems: "flex-start" }}>
              {/* LEFT: Checkerplay Panel */}
              <div className="w-full lg:w-[280px] lg:shrink-0">
                <Card>
                  {/* Log / Checker toggle */}
                  <div style={{
                    display: "flex", gap: 0, marginBottom: 14,
                    borderRadius: R.card, overflow: "hidden", border: `1px solid ${C.border.subtle}`,
                  }}>
                    {(["log", "checker"] as const).map(mode => (
                      <button key={mode} onClick={() => setAnalysisMode(mode)} style={{
                        flex: 1, padding: "8px 0",
                        background: analysisMode === mode ? C.gold.primary : C.bg.surface,
                        color: analysisMode === mode ? C.gold.text : C.text.muted,
                        border: "none", fontSize: "0.75rem", fontWeight: W.bold,
                        cursor: "pointer", textTransform: "capitalize", fontFamily: F.body,
                      }}>{mode === "checker" ? "Checker" : "Log"}</button>
                    ))}
                  </div>

                  {/* Checker mode: Candidate moves */}
                  {analysisMode === "checker" && selectedTurnAnalysis && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {selectedTurnAnalysis.candidates.map((c, i) => (
                          <CandidateMoveRow key={i}
                            notation={c.notation}
                            equityDiff={c.equity.toFixed(3)}
                            isPlayed={c.isPlayed}
                            isBest={i === 0}
                            isSelected={selectedCandidate === i}
                            onClick={() => setSelectedCandidate(selectedCandidate === i ? null : i)}
                          />
                      ))}
                    </div>
                  )}
                  {analysisMode === "checker" && !selectedTurnAnalysis && (
                    <div style={{ fontSize: "0.75rem", color: C.text.muted, padding: "16px 0", textAlign: "center" }}>
                      Select a move to see candidates
                    </div>
                  )}

                  {/* Log mode */}
                  {analysisMode === "log" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 260, overflow: "auto" }}>
                      {displayMoves.map(m => (
                        <button key={m.moveNum} type="button" aria-pressed={selectedMove === m.moveNum} aria-label={`Move ${m.moveNum}, dice ${m.dice.join(" and ")}, ${m.move}${m.error ? `, ${m.error}` : ""}`} onClick={() => selectMove(m.moveNum)} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 10px", borderRadius: R.button, cursor: "pointer",
                          background: selectedMove === m.moveNum ? C.bg.deep : "transparent",
                          border: selectedMove === m.moveNum ? `1px solid ${C.border.subtle}` : "1px solid transparent",
                          width: "100%", textAlign: "left", font: "inherit",
                        }}>
                          <span style={{ fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted, width: 18 }}>{m.moveNum}</span>
                          <div style={{ display: "flex", gap: 2 }}>
                            {m.dice.map((d, i) => (
                              <span key={i} style={{
                                width: 15, height: 15, borderRadius: 3, background: C.bg.elevated,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                fontSize: "0.5625rem", fontWeight: W.bold,
                              }}>{d}</span>
                            ))}
                          </div>
                          <span style={{ flex: 1, fontSize: "0.6875rem", fontFamily: F.mono, fontWeight: W.medium }}>{m.move}</span>
                          {m.error && (
                            <span style={{
                              fontSize: "0.5rem", fontWeight: W.bold, padding: "1px 4px", borderRadius: 2,
                              background: m.isBlunder ? C.error : C.bg.elevated,
                              color: m.isBlunder ? C.text.primary : C.text.secondary,
                            }}>{m.error[0]}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Winning Chances */}
                  {selectedTurnAnalysis && (
                    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border.subtle}` }}>
                      <div style={{
                        fontSize: "0.6875rem", fontWeight: W.bold, color: C.text.secondary,
                        textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10,
                      }}>Winning Chances</div>
                      <WinningChances
                        whiteWin={winProb?.white ?? 50}
                        blackWin={winProb?.black ?? 50}
                      />
                      {/* GnuBG detailed probability breakdown */}
                      {selectedTurnAnalysis.probability && (
                        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {[
                            { label: "Win", val: selectedTurnAnalysis.probability.win },
                            { label: "Gammon", val: selectedTurnAnalysis.probability.winG },
                            { label: "BG", val: selectedTurnAnalysis.probability.winBG },
                          ].map(({ label, val }) => (
                            <div key={label} style={{
                              fontSize: "0.625rem", color: C.text.muted, fontFamily: F.mono,
                              padding: "2px 6px", borderRadius: 3, background: C.bg.elevated,
                            }}>
                              {label}: {(val * 100).toFixed(1)}%
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </div>

              {/* CENTER: Board */}
              <div className="order-first lg:order-none" style={{ flex: 1, minWidth: 0 }}>
                <Card>
                  <SectionHeader
                    title={`Move ${selectedMove}${currentDisplayMove?.error ? ` · ${currentDisplayMove.error}` : ""}`}
                    right={
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <button onClick={() => selectMove(Math.max(1, selectedMove - 1))} style={{
                          width: 28, height: 28, borderRadius: R.button,
                          border: `1px solid ${C.border.subtle}`, background: C.bg.surface,
                          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: "0.875rem", color: C.text.muted,
                        }}>&larr;</button>
                        <button onClick={() => selectMove(Math.min(totalTurns, selectedMove + 1))} style={{
                          width: 28, height: 28, borderRadius: R.button,
                          border: `1px solid ${C.border.subtle}`, background: C.bg.surface,
                          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: "0.875rem", color: C.text.muted,
                        }}>&rarr;</button>
                        <span style={{ fontSize: "0.6875rem", color: C.text.muted, marginLeft: 8 }}>{selectedMove} / {totalTurns}</span>
                      </div>
                    }
                  />
                  <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
                    <BoardWireframe
                      board={boardBefore}
                      pip1={pip1} pip2={pip2}
                      dice={selectedTurnAnalysis?.dice ?? currentDisplayMove?.dice ?? [1, 1]}
                      arrows={activeArrows.arrows}
                      arrowColor={activeArrows.color}
                    />
                  </div>
                </Card>
              </div>

              {/* RIGHT: Move Navigator */}
              <div className="w-full lg:w-[240px] lg:shrink-0">
                <Card>
                  <SectionHeader title="Moves" />
                  <div className="max-h-[200px] lg:max-h-[400px]" style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "auto" }}>
                    {displayMoves.map(m => (
                      <button key={m.moveNum} type="button" aria-pressed={selectedMove === m.moveNum} aria-label={`Move ${m.moveNum}, dice ${m.dice.join(" and ")}, ${m.move}${m.error ? `, ${m.error}` : ""}`} onClick={() => selectMove(m.moveNum)} style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "6px 8px", borderRadius: R.button, cursor: "pointer",
                        background: selectedMove === m.moveNum ? C.bg.deep : "transparent",
                        border: selectedMove === m.moveNum ? `1px solid ${C.border.subtle}` : "1px solid transparent",
                        transition: "background 0.1s",
                        width: "100%", textAlign: "left", font: "inherit",
                      }}>
                        <span style={{ fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted, width: 18, textAlign: "center" }}>{m.moveNum}</span>
                        <div style={{ display: "flex", gap: 2 }}>
                          {m.dice.map((d, i) => (
                            <div key={i} style={{
                              width: 15, height: 15, borderRadius: 3,
                              background: C.bg.elevated, border: `1px solid ${C.border.subtle}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: "0.5625rem", fontWeight: W.bold, color: C.text.primary,
                            }}>{d}</div>
                          ))}
                        </div>
                        <span style={{
                          flex: 1, fontSize: "0.6875rem", fontWeight: W.medium, fontFamily: F.mono, color: C.text.primary,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>{m.move}</span>
                        {m.error && (
                          <span style={{
                            fontSize: "0.5rem", fontWeight: W.bold, padding: "2px 4px", borderRadius: R.button,
                            background: m.isBlunder ? C.error : C.bg.elevated,
                            color: m.isBlunder ? C.text.primary : C.text.secondary,
                          }}>{m.error[0]}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </Card>
              </div>
            </div>

            {/* Bottom: Played vs Best comparison bar */}
            {selectedTurnAnalysis && currentDisplayMove?.error && (
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{
                    flex: 1, display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 14px", borderRadius: 8, background: C.bg.deep, border: `1px solid ${C.border.subtle}`,
                  }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.text.muted, flexShrink: 0 }} />
                    <span style={{ fontSize: "0.8125rem", fontWeight: W.semibold, fontFamily: F.mono }}>{bottomBarPlayed}</span>
                    <span style={{ fontSize: "0.6875rem", color: C.text.muted, marginLeft: "auto", fontFamily: F.mono }}>
                      ({selectedTurnAnalysis.equityAfter.toFixed(3)})
                    </span>
                  </div>
                  <span style={{ fontSize: "0.6875rem", fontWeight: W.bold, color: C.text.muted }}>vs</span>
                  <div style={{
                    flex: 1, display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 14px", borderRadius: 8, background: C.bg.deep, border: `1.5px solid ${C.gold.primary}`,
                  }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: C.gold.primary, flexShrink: 0 }} />
                    <span style={{ fontSize: "0.8125rem", fontWeight: W.bold, fontFamily: F.mono }}>{bottomBarBest}</span>
                    <span style={{ fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted, marginLeft: "auto", textTransform: "uppercase" }}>Best move</span>
                  </div>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ═══ MOVE LIST TAB ═══ */}
        {activeTab === "moves" && (
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <Card>
              <SectionHeader title="Full Move List" right={
                <span style={{ fontSize: "0.6875rem", color: C.text.muted }}>{totalTurns} moves</span>
              } />
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 12px", borderBottom: `1px solid ${C.border.subtle}`, marginBottom: 4,
              }}>
                <span style={{ width: 28, fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted, textAlign: "center" }}>#</span>
                {hasRealData && <span style={{ width: 12 }} />}
                <span style={{ width: 44, fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted }}>Dice</span>
                <span style={{ flex: 1, fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted }}>Move</span>
                <span style={{ width: 50, fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted, textAlign: "right" }}>Equity</span>
                <span style={{ width: 50, fontSize: "0.625rem", fontWeight: W.semibold, color: C.text.muted, textAlign: "center" }}>Error</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {displayMoves.map(m => (
                  <MoveRow key={m.moveNum}
                    moveNum={m.moveNum} dice={m.dice} move={m.move}
                    equity={m.equity} error={m.error} isBlunder={m.isBlunder}
                    isSelected={selectedMove === m.moveNum}
                    player={hasRealData ? m.player : undefined}
                    onClick={() => { selectMove(m.moveNum); setActiveTab("analysis"); }}
                  />
                ))}
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
