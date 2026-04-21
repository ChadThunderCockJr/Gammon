"use client";

import { useMemo, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import type { BoardState, Player, Move } from "@xion-beginner/backgammon-core";
import { WHITE_BAR, BLACK_BAR } from "@xion-beginner/backgammon-core";

// ─── Types ───────────────────────────────────────────────────────

export interface BoardProps {
  board: BoardState;
  myColor: Player;
  legalMoves: Move[];
  isMyTurn: boolean;
  dice: [number, number] | null;
  onMove: (from: number, to: number) => void;
  movesRemaining: number[];
  lastOpponentMove: { from: number; to: number } | null;
  gameOver: boolean;
  /** Render prop for center strip controls (dice, undo, confirm) */
  centerControls?: ReactNode;
  /** Pip counts: [opponent, player] from the viewing player's perspective */
  pipCounts?: [number, number];
  /** Active die index — front die is always used for moves */
  activeDieIndex?: 0 | 1;
  /** Whether to display point numbers (1-24) on the board */
  showPointNumbers?: boolean;
  /** Hint moves to display as gold arrows on the board */
  hintMoves?: Move[] | null;
}

// ─── Design constants ────────────────────────────────────────────

const POINT_W = 68;
const POINT_H = 260;
const POINT_GAP = 2;
const CHECKER_SIZE = 52;
const CHECKER_VISIBLE = 42;
const MAX_SHOW = 5;
const BAR_W = 56;
const BEAROFF_W = 54;
const DIE_SIZE = 56;

const DARK_FELT = "var(--color-board-felt-dark)";
const LIGHT_FELT = "var(--color-board-felt-light)";

// Intrinsic board size (used for scale-to-fit)
const QUAD_W = 6 * POINT_W + 5 * POINT_GAP; // 418
const BOARD_INNER_W = QUAD_W * 2 + BAR_W + 8 + 12; // two quads + bar + margins + padding
const BOARD_TOTAL_W = BOARD_INNER_W + 4 + BEAROFF_W; // + border + bear-off
const BOARD_TOTAL_H = 20 * 2 + POINT_H * 2 + 60 + 8 + 4; // nums + points + center + padding + border

const DICE_DOTS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.5], [0.72, 0.5], [0.28, 0.72], [0.72, 0.72]],
};

// ─── Sub-components ──────────────────────────────────────────────

function Checker({
  color,
  highlighted = false,
  isGhost = false,
  onClick,
}: {
  color: "white" | "black";
  highlighted?: boolean;
  isGhost?: boolean;
  onClick?: () => void;
}) {
  const isW = color === "white";
  return (
    <div
      onClick={onClick}
      className="relative flex items-center justify-center shrink-0"
      style={{
        width: CHECKER_SIZE,
        height: CHECKER_SIZE,
        borderRadius: "50%",
        background: isW ? "var(--color-checker-white)" : "var(--color-checker-black)",
        border: `${isW ? "2px" : "2.5px"} solid ${
          highlighted
            ? "var(--color-gold-primary)"
            : isW
              ? "var(--color-checker-white-border)"
              : "var(--color-checker-black-border)"
        }`,
        boxShadow: highlighted
          ? "var(--shadow-gold), var(--shadow-card)"
          : "var(--shadow-card)",
        opacity: isGhost ? 0.35 : 1,
        cursor: onClick ? "pointer" : "default",
        zIndex: highlighted ? 10 : undefined,
      }}
    />
  );
}

function CheckerStack({
  color,
  count,
  fromTop,
  selectedIdx,
  onClick,
}: {
  color: "white" | "black";
  count: number;
  fromTop: boolean;
  selectedIdx?: number;
  onClick?: () => void;
}) {
  const show = Math.min(count, MAX_SHOW);
  return (
    <div
      className="relative flex items-center"
      style={{
        flexDirection: fromTop ? "column" : "column-reverse",
        zIndex: 2,
        marginTop: fromTop ? 6 : 0,
        marginBottom: fromTop ? 0 : 6,
      }}
    >
      {Array.from({ length: show }).map((_, i) => (
        <div
          key={i}
          className="relative flex items-center justify-center"
          style={{
            marginTop: fromTop && i > 0 ? -(CHECKER_SIZE - CHECKER_VISIBLE) : 0,
            marginBottom: !fromTop && i > 0 ? -(CHECKER_SIZE - CHECKER_VISIBLE) : 0,
            zIndex: fromTop ? show - i : i,
          }}
        >
          <Checker
            color={color}
            highlighted={selectedIdx === i}
            onClick={onClick}
          />
          {count > MAX_SHOW && i === (fromTop ? show - 1 : 0) && (
            <span
              className="absolute text-[13px] font-bold"
              style={{
                color: color === "white" ? "var(--color-bg-deepest)" : "var(--color-text-primary)",
              }}
            >
              {count}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Die({ value, used = false, player }: { value: number; used?: boolean; player?: "white" | "black" }) {
  const dots = DICE_DOTS[value] || [];
  const r = DIE_SIZE * 0.08;
  const isBlack = player === "black";
  const faceFill = isBlack ? "var(--color-die-black-face)" : "var(--color-die-white-face)";
  const faceStroke = isBlack ? "var(--color-die-black-stroke)" : "var(--color-die-white-stroke)";
  const dotFill = isBlack ? "var(--color-die-black-dot)" : "var(--color-die-white-dot)";
  return (
    <svg
      width={DIE_SIZE}
      height={DIE_SIZE}
      viewBox={`0 0 ${DIE_SIZE} ${DIE_SIZE}`}
      className={used ? "" : "animate-dice"}
      style={{ opacity: used ? 0.2 : 1 }}
    >
      <rect
        x="1" y="1"
        width={DIE_SIZE - 2} height={DIE_SIZE - 2}
        rx={DIE_SIZE * 0.16}
        fill={faceFill}
        stroke={faceStroke}
        strokeWidth="1"
      />
      {dots.map(([px, py], i) => (
        <circle
          key={i}
          cx={px * DIE_SIZE}
          cy={py * DIE_SIZE}
          r={r}
          fill={used ? "var(--color-text-muted)" : dotFill}
        />
      ))}
    </svg>
  );
}

export function DoublingCube({ value = 64 }: { value?: number }) {
  return (
    <div
      className="flex items-center justify-center text-[13px] font-bold"
      style={{
        width: 36,
        height: 36,
        borderRadius: 5,
        background: "var(--color-bg-elevated)",
        border: "1.5px solid var(--color-gold-primary)",
        color: "var(--color-gold-primary)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {value}
    </div>
  );
}

// Exported for use in GameScreen center controls
export { Die };

// ─── Main Board Component ────────────────────────────────────────

export function Board({
  board,
  myColor,
  legalMoves,
  isMyTurn,
  dice,
  onMove,
  movesRemaining,
  lastOpponentMove,
  gameOver,
  centerControls,
  pipCounts,
  activeDieIndex,
  showPointNumbers: showPointNumbersProp = true,
  hintMoves,
}: BoardProps) {
  const flipped = myColor === "black";

  // ─── Animation state ──────────────────────────────────────────
  const boardInnerRef = useRef<HTMLDivElement>(null);
  const [animatingMove, setAnimatingMove] = useState<{
    fromX: number; fromY: number;
    toX: number; toY: number;
    color: "white" | "black";
    sourcePoint: number;
    destPoint: number;
    isPlayerMove: boolean;
  } | null>(null);

  // ─── Hold + drag state ─────────────────────────────────────────
  // holdPoint: when set, shows destination previews for that source
  const [holdPoint, setHoldPoint] = useState<number | null>(null);
  const [dragState, setDragState] = useState<{
    sourcePoint: number;
    color: "white" | "black";
    cursorX: number;
    cursorY: number;
  } | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number; time: number; point: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  const tapHandledRef = useRef(false);

  // Destinations visible during hold
  const holdDests = useMemo(() => {
    if (holdPoint === null) return new Map<number, number[]>();
    const map = new Map<number, number[]>();
    for (const m of legalMoves) {
      if (m.from !== holdPoint) continue;
      const existing = map.get(m.to) || [];
      existing.push(m.die);
      map.set(m.to, existing);
    }
    return map;
  }, [holdPoint, legalMoves]);

  // Legacy compat: selectedPoint for rendering (= holdPoint)
  const selectedPoint = holdPoint;
  const legalDests = useMemo(() => {
    if (holdPoint === null) return new Set<number>();
    return new Set(legalMoves.filter((m) => m.from === holdPoint).map((m) => m.to));
  }, [holdPoint, legalMoves]);

  const legalSources = useMemo(
    () => new Set(legalMoves.map((m) => m.from)),
    [legalMoves]
  );

  const lastMoveFrom = lastOpponentMove?.from ?? null;
  const lastMoveTo = lastOpponentMove?.to ?? null;

  // ─── Point position measurement ───────────────────────────────
  const getPointCenter = useCallback((point: number): { x: number; y: number } | null => {
    const boardEl = boardInnerRef.current;
    if (!boardEl) return null;
    const boardRect = boardEl.getBoundingClientRect();

    if (point === 0 || point === 25) {
      return { x: boardRect.width + 20, y: boardRect.height / 2 };
    }

    const pointEl = boardEl.querySelector(`[data-point="${point}"]`) as HTMLElement | null;
    if (!pointEl) return null;
    const pointRect = pointEl.getBoundingClientRect();
    const isTopHalf = pointRect.top - boardRect.top < boardRect.height / 2;

    return {
      x: pointRect.left + pointRect.width / 2 - boardRect.left,
      y: isTopHalf
        ? pointRect.top + 40 - boardRect.top
        : pointRect.bottom - 40 - boardRect.top,
    };
  }, []);

  // ─── Opponent move animation ──────────────────────────────────
  useEffect(() => {
    if (!lastOpponentMove) {
      // Clear any stuck animation when lastOpponentMove is cleared
      // (new game, CLEAR_LAST_MOVE, etc.)
      setAnimatingMove(null);
      return;
    }

    const fromPos = getPointCenter(lastOpponentMove.from);
    const toPos = getPointCenter(lastOpponentMove.to);
    if (!fromPos || !toPos) return;

    const opponentColor: "white" | "black" = myColor === "white" ? "black" : "white";
    setAnimatingMove({
      fromX: fromPos.x, fromY: fromPos.y,
      toX: toPos.x, toY: toPos.y,
      color: opponentColor,
      sourcePoint: lastOpponentMove.from,
      destPoint: lastOpponentMove.to,
      isPlayerMove: false,
    });
    const timer = setTimeout(() => setAnimatingMove(null), 200);
    return () => clearTimeout(timer);
  }, [lastOpponentMove, myColor, getPointCenter]);

  // ─── Helpers ─────────────────────────────────────────────────

  function pickMove(moves: Move[]): Move {
    if (moves.length === 1) return moves[0];
    if (activeDieIndex != null && dice) {
      const preferred = moves.find((m) => m.die === dice[activeDieIndex]);
      if (preferred) return preferred;
    }
    return moves[0];
  }

  function tapMove(point: number) {
    const movesFrom = legalMoves.filter((m) => m.from === point);
    if (movesFrom.length === 0) return;
    // During bear-off, prefer bear-off destination over internal moves
    const bearOffMoves = movesFrom.filter((m) => m.to === 0 || m.to === 25);
    const move = bearOffMoves.length > 0 ? pickMove(bearOffMoves) : pickMove(movesFrom);
    onMove(move.from, move.to);
    setHoldPoint(null);
  }

  // Clicking a point directly (for backwards compat with rendering)
  function handleClick(point: number) {
    // No-op — all interaction handled by pointer events
  }

  function handleBearOff() {
    if (!isMyTurn) return;

    // If holding and bear-off is a legal dest, use that
    if (holdPoint !== null) {
      const target = legalDests.has(0) ? 0 : legalDests.has(25) ? 25 : null;
      if (target !== null) {
        onMove(holdPoint, target);
        setHoldPoint(null);
        return;
      }
    }

    // No hold — find bear-off moves, prefer farthest checker (most strategic)
    const bearOffMoves = legalMoves.filter((m) => m.to === 0 || m.to === 25);
    if (bearOffMoves.length > 0) {
      // Sort: farthest source point first (highest for white, lowest for black)
      const sorted = [...bearOffMoves].sort((a, b) =>
        myColor === "white" ? b.from - a.from : a.from - b.from
      );
      // Among sorted, prefer the one matching the active die
      let best = sorted[0];
      if (activeDieIndex != null && dice) {
        const preferred = sorted.find((m) => m.die === dice[activeDieIndex]);
        if (preferred) best = preferred;
      }
      onMove(best.from, best.to);
      setHoldPoint(null);
    }
  }

  // ─── Pointer handlers: tap vs hold vs drag ────────────────────

  const HOLD_DELAY = 250; // ms before hold mode activates

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isMyTurn || gameOver) return;

    const pointEl = (e.target as HTMLElement).closest("[data-point]");
    if (!pointEl) return;
    const point = parseInt(pointEl.getAttribute("data-point")!);
    if (!legalSources.has(point)) return;

    const val = board.points[point];
    const color: "white" | "black" = val > 0 ? "white" : val < 0 ? "black" : myColor;

    pointerDownRef.current = { x: e.clientX, y: e.clientY, time: Date.now(), point };
    isDraggingRef.current = false;
    tapHandledRef.current = false;

    setDragState({ sourcePoint: point, color, cursorX: e.clientX, cursorY: e.clientY });

    // Start hold timer
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      if (!pointerDownRef.current) return;
      // Enter hold mode — show destinations
      setHoldPoint(point);
      // Capture pointer so we get events even if cursor leaves element
      try {
        (e.target as HTMLElement).closest("[data-board-root]")?.setPointerCapture(e.pointerId);
      } catch {}
    }, HOLD_DELAY);
  }, [isMyTurn, gameOver, legalSources, board.points, myColor]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointerDownRef.current || !dragState) return;

    const dx = e.clientX - pointerDownRef.current.x;
    const dy = e.clientY - pointerDownRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // If moved significantly before hold timer, cancel hold and start drag
    if (dist > 8 && !isDraggingRef.current) {
      isDraggingRef.current = true;
      if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
      setHoldPoint(dragState.sourcePoint);
      try {
        (e.target as HTMLElement).closest("[data-board-root]")?.setPointerCapture(e.pointerId);
      } catch {}
    }

    if (isDraggingRef.current || holdPoint !== null) {
      setDragState((prev) => (prev ? { ...prev, cursorX: e.clientX, cursorY: e.clientY } : null));
    }
  }, [dragState, holdPoint]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!pointerDownRef.current) return;

    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }

    const elapsed = Date.now() - pointerDownRef.current.time;
    const point = pointerDownRef.current.point;
    const dx = e.clientX - pointerDownRef.current.x;
    const dy = e.clientY - pointerDownRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Quick tap (< hold delay, minimal movement) → auto-move by front die
    if (elapsed < HOLD_DELAY && dist < 12 && !tapHandledRef.current) {
      tapHandledRef.current = true;
      tapMove(point);
    }
    // Hold or drag release → check if near a destination
    else if (holdPoint !== null || isDraggingRef.current) {
      const boardEl = boardInnerRef.current;
      if (boardEl && dragState) {
        const boardRect = boardEl.getBoundingClientRect();
        const cursorX = e.clientX - boardRect.left;
        const cursorY = e.clientY - boardRect.top;

        let closestPoint = -1;
        let closestDist = Infinity;

        const destsForSource = legalMoves
          .filter((m) => m.from === dragState.sourcePoint)
          .map((m) => m.to);

        for (const dest of destsForSource) {
          const center = getPointCenter(dest);
          if (!center) continue;
          const d = Math.sqrt((center.x - cursorX) ** 2 + (center.y - cursorY) ** 2);
          if (d < closestDist) { closestDist = d; closestPoint = dest; }
        }

        if (closestPoint >= 0 && closestDist < 80) {
          onMove(dragState.sourcePoint, closestPoint);
        }
      }
      setHoldPoint(null);
    }

    try {
      (e.target as HTMLElement).closest("[data-board-root]")?.releasePointerCapture(e.pointerId);
    } catch {}

    setDragState(null);
    isDraggingRef.current = false;
    pointerDownRef.current = null;
  }, [holdPoint, dragState, legalMoves, getPointCenter, onMove, activeDieIndex, dice]);

  // ─── Point ordering (respects flip) ──────────────────────────

  const topLeftPts = flipped ? [12, 11, 10, 9, 8, 7] : [13, 14, 15, 16, 17, 18];
  const topRightPts = flipped ? [6, 5, 4, 3, 2, 1] : [19, 20, 21, 22, 23, 24];
  const botLeftPts = flipped ? [13, 14, 15, 16, 17, 18] : [12, 11, 10, 9, 8, 7];
  const botRightPts = flipped ? [19, 20, 21, 22, 23, 24] : [6, 5, 4, 3, 2, 1];

  const topNums = [...topLeftPts, ...topRightPts];
  const botNums = [...botLeftPts, ...botRightPts];

  // ─── Dice ────────────────────────────────────────────────────

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

  // ─── Render a point ──────────────────────────────────────────

  function renderPoint(point: number, fromTop: boolean, idx: number) {
    const val = board.points[point];
    let count = Math.abs(val);
    const col: "white" | "black" | null = val > 0 ? "white" : val < 0 ? "black" : null;
    const isSel = selectedPoint === point;
    const isDest = legalDests.has(point);
    const isSrc = legalSources.has(point) && isMyTurn;
    const isLastFrom = lastMoveFrom === point;
    const isLastTo = lastMoveTo === point;
    const vp = flipped ? 25 - point : point;
    const isDark = vp % 2 === 0;

    // Adjust display count during animation or drag
    let displayCount = count;
    if (animatingMove && !animatingMove.isPlayerMove && animatingMove.destPoint === point) {
      displayCount = Math.max(0, count - 1);
    }
    if (dragState && isDraggingRef.current && dragState.sourcePoint === point) displayCount = Math.max(0, count - 1);

    const topCheckerIdx = displayCount > 0 ? Math.min(displayCount, MAX_SHOW) - 1 : -1;
    const triangleFill = isDark ? DARK_FELT : LIGHT_FELT;

    let triHighlight: string | undefined;
    if (isLastTo) triHighlight = "var(--color-board-highlight)";
    if (isLastFrom) triHighlight = "var(--color-board-highlight)";

    return (
      <div
        key={`pt-${point}`}
        data-point={point}
        className="relative flex flex-col items-center"
        style={{
          width: POINT_W,
          height: POINT_H,
          justifyContent: fromTop ? "flex-start" : "flex-end",
          cursor: isSrc || isDest ? "pointer" : "default",
        }}
        onClick={() => handleClick(point)}
      >
        {/* Triangle */}
        <div
          className="absolute"
          style={{
            top: fromTop ? 0 : "auto",
            bottom: fromTop ? "auto" : 0,
            left: "50%",
            transform: "translateX(-50%)",
            width: 0,
            height: 0,
            borderLeft: `${POINT_W / 2}px solid transparent`,
            borderRight: `${POINT_W / 2}px solid transparent`,
            ...(fromTop
              ? { borderTop: `${POINT_H - 16}px solid ${triHighlight || triangleFill}` }
              : { borderBottom: `${POINT_H - 16}px solid ${triHighlight || triangleFill}` }),
          }}
        />

        {/* Selected point border glow */}
        {isSel && (
          <div
            className="absolute rounded-sm"
            style={{
              inset: 0,
              border: "2px solid var(--color-gold-primary)",
              borderRadius: 4,
              pointerEvents: "none",
              zIndex: 20,
              boxShadow: "var(--shadow-glow)",
            }}
          />
        )}

        {/* Legal source subtle pulsing glow (only when no hold active) */}
        {isSrc && !isSel && holdPoint === null && (
          <div
            className="absolute animate-legal-pulse rounded-full"
            style={{
              width: CHECKER_SIZE + 4,
              height: CHECKER_SIZE + 4,
              top: fromTop ? 4 : "auto",
              bottom: fromTop ? "auto" : 4,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 1,
            }}
          />
        )}

        {/* Hold destination: ghost checker with die label */}
        {isDest && (
          <div
            className="absolute flex flex-col items-center justify-center"
            style={{
              top: fromTop
                ? 6 + (col && displayCount > 0 ? Math.min(displayCount, MAX_SHOW) * CHECKER_VISIBLE : 0)
                : "auto",
              bottom: !fromTop
                ? 6 + (col && displayCount > 0 ? Math.min(displayCount, MAX_SHOW) * CHECKER_VISIBLE : 0)
                : "auto",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 15,
              pointerEvents: "none",
            }}
          >
            <Checker color={myColor} isGhost />
            {/* Die value badge */}
            {holdDests.has(point) && (
              <div style={{
                position: "absolute",
                bottom: -6,
                background: "var(--color-success)",
                color: "var(--color-bg-deepest)",
                fontSize: "0.6875rem",
                fontWeight: 800,
                borderRadius: 8,
                padding: "1px 6px",
                boxShadow: "var(--shadow-card)",
                lineHeight: "16px",
              }}>
                {holdDests.get(point)!.join("+")}
              </div>
            )}
          </div>
        )}

        {/* Checkers */}
        {col && displayCount > 0 && (
          <CheckerStack
            color={col}
            count={displayCount}
            fromTop={fromTop}
            selectedIdx={isSel ? topCheckerIdx : undefined}
            onClick={() => handleClick(point)}
          />
        )}
      </div>
    );
  }

  // ─── Bar ─────────────────────────────────────────────────────

  function renderBar(position: "top" | "bottom") {
    const wCount = board.points[WHITE_BAR];
    const bCount = Math.abs(board.points[BLACK_BAR]);
    const wSrc = legalSources.has(WHITE_BAR) && isMyTurn;
    const bSrc = legalSources.has(BLACK_BAR) && isMyTurn;

    const isTop = position === "top";
    const topColor: "white" | "black" = flipped ? "white" : "black";
    const botColor: "white" | "black" = flipped ? "black" : "white";
    const topCount = topColor === "white" ? wCount : bCount;
    const botCount = botColor === "white" ? wCount : bCount;
    const topBarIdx = topColor === "white" ? WHITE_BAR : BLACK_BAR;
    const botBarIdx = botColor === "white" ? WHITE_BAR : BLACK_BAR;
    const topSrc = topColor === "white" ? wSrc : bSrc;
    const botSrc = botColor === "white" ? wSrc : bSrc;

    const pipLabel = pipCounts ? (isTop ? pipCounts[0] : pipCounts[1]) : null;

    return (
      <div
        className="flex flex-col items-center shrink-0"
        style={{
          width: BAR_W,
          background: "var(--color-bg-deepest)",
          margin: "0 4px",
          borderRadius: 4,
          borderLeft: "1px solid var(--color-border-subtle)",
          borderRight: "1px solid var(--color-border-subtle)",
          justifyContent: isTop ? "flex-start" : "flex-end",
          padding: isTop ? "12px 0 0" : "0 0 12px",
          gap: 8,
          height: POINT_H,
        }}
      >
        {isTop && (
          <>
            {pipLabel !== null && (
              <div className="text-center leading-none">
                <div className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider mb-0.5">PIP</div>
                <div className="text-[13px] font-bold text-[var(--color-text-secondary)]">{pipLabel}</div>
              </div>
            )}
            {topCount > 0 && (
              <div
                data-point={topBarIdx}
                className="flex flex-col items-center"
                style={{ gap: -(CHECKER_SIZE - CHECKER_VISIBLE) }}
                onClick={() => topSrc && handleClick(topBarIdx)}
              >
                {Array.from({ length: Math.min(topCount, 3) }).map((_, i) => (
                  <div key={i} style={{ marginTop: i > 0 ? -(CHECKER_SIZE - CHECKER_VISIBLE) : 0 }}>
                    <Checker
                      color={topColor}
                      highlighted={selectedPoint === topBarIdx && i === Math.min(topCount, 3) - 1}
                      onClick={topSrc ? () => handleClick(topBarIdx) : undefined}
                    />
                  </div>
                ))}
                {topCount > 3 && (
                  <span className="text-[10px] font-bold text-[var(--color-text-secondary)]">{topCount}</span>
                )}
              </div>
            )}
          </>
        )}
        {!isTop && (
          <>
            {botCount > 0 && (
              <div
                data-point={botBarIdx}
                className="flex flex-col-reverse items-center"
                onClick={() => botSrc && handleClick(botBarIdx)}
              >
                {Array.from({ length: Math.min(botCount, 3) }).map((_, i) => (
                  <div key={i} style={{ marginBottom: i > 0 ? -(CHECKER_SIZE - CHECKER_VISIBLE) : 0 }}>
                    <Checker
                      color={botColor}
                      highlighted={selectedPoint === botBarIdx && i === Math.min(botCount, 3) - 1}
                      onClick={botSrc ? () => handleClick(botBarIdx) : undefined}
                    />
                  </div>
                ))}
                {botCount > 3 && (
                  <span className="text-[10px] font-bold text-[var(--color-text-secondary)]">{botCount}</span>
                )}
              </div>
            )}
            {pipLabel !== null && (
              <div className="text-center leading-none">
                <div className="text-[13px] font-bold text-[var(--color-text-secondary)]">{pipLabel}</div>
                <div className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider mt-0.5">PIP</div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ─── Point numbers ───────────────────────────────────────────

  function renderPointNumbers(numbers: number[]) {
    return (
      <div
        className="flex items-center"
        style={{
          padding: "0 6px",
          height: 20,
          opacity: showPointNumbersProp ? 0.7 : 0,
          transition: "opacity 200ms ease",
        }}
      >
        <div className="flex flex-1" style={{ gap: POINT_GAP }}>
          {numbers.slice(0, 6).map((n) => (
            <div key={n} className="text-center font-semibold text-[var(--color-text-muted)]" style={{ width: POINT_W, fontSize: "0.6875rem" }}>
              {n}
            </div>
          ))}
        </div>
        <div style={{ width: BAR_W + 8 }} />
        <div className="flex flex-1" style={{ gap: POINT_GAP }}>
          {numbers.slice(6).map((n) => (
            <div key={n} className="text-center font-semibold text-[var(--color-text-muted)]" style={{ width: POINT_W, fontSize: "0.6875rem" }}>
              {n}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── Bear-off ────────────────────────────────────────────────

  const hasAnyBearOff = isMyTurn && legalMoves.some((m) => m.to === 0 || m.to === 25);
  const canBear = hasAnyBearOff || (selectedPoint !== null && (legalDests.has(0) || legalDests.has(25)));
  const bearTopColor: "white" | "black" = flipped ? "white" : "black";
  const bearBotColor: "white" | "black" = flipped ? "black" : "white";
  const bearTopCount = bearTopColor === "white" ? board.whiteOff : board.blackOff;
  const bearBotCount = bearBotColor === "white" ? board.whiteOff : board.blackOff;

  // ─── Scale-to-fit: measure container, compute scale ──────────

  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const updateScale = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const sx = width / BOARD_TOTAL_W;
    const sy = height / BOARD_TOTAL_H;
    setScale(Math.min(sx, sy));
  }, []);

  useEffect(() => {
    updateScale();
    const ro = new ResizeObserver(updateScale);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [updateScale]);

  return (
    <div
      ref={containerRef}
      data-board-root
      role="application"
      aria-label="Backgammon board"
      className="w-full h-full flex items-center justify-center overflow-hidden"
      style={{ touchAction: dragState || holdPoint !== null ? "none" : "auto" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
    <div
      className="flex items-stretch select-none"
      style={{
        opacity: gameOver ? 0.4 : 1,
        pointerEvents: gameOver ? "none" : "auto",
        transition: "opacity 300ms ease",
        zoom: scale,
      }}
    >
      {/* Main Board */}
      <div
        ref={boardInnerRef}
        className="flex flex-col"
        aria-label="Playing field"
        style={{
          background: "var(--color-bg-base)",
          borderRadius: "12px 0 0 12px",
          border: "2px solid var(--color-border-subtle)",
          borderRight: "none",
          padding: "4px 0",
          boxShadow: "var(--shadow-elevated)",
          position: "relative",
        }}
      >
        {renderPointNumbers(topNums)}

        {/* Top half */}
        <div className="flex" style={{ padding: "0 6px" }}>
          <div className="flex" style={{ gap: POINT_GAP }}>
            {topLeftPts.map((pt, i) => renderPoint(pt, true, i))}
          </div>
          {renderBar("top")}
          <div className="flex" style={{ gap: POINT_GAP }}>
            {topRightPts.map((pt, i) => renderPoint(pt, true, i + 6))}
          </div>
        </div>

        {/* Center strip */}
        <div
          className="flex items-center justify-center relative"
          style={{ padding: "6px 0", gap: 16, minHeight: 60 }}
        >
          {centerControls ?? (
            diceList.length > 0 && (
              <div className="flex" style={{ gap: 8 }}>
                {diceList.map((d, i) => (
                  <Die key={i} value={d.value} used={d.used} player={isMyTurn ? myColor : (myColor === "white" ? "black" : "white")} />
                ))}
              </div>
            )
          )}
        </div>

        {/* Bottom half */}
        <div className="flex" style={{ padding: "0 6px" }}>
          <div className="flex" style={{ gap: POINT_GAP }}>
            {botLeftPts.map((pt, i) => renderPoint(pt, false, i))}
          </div>
          {renderBar("bottom")}
          <div className="flex" style={{ gap: POINT_GAP }}>
            {botRightPts.map((pt, i) => renderPoint(pt, false, i + 6))}
          </div>
        </div>

        {renderPointNumbers(botNums)}

        {/* Animated checker overlay */}
        {animatingMove && (
          <div
            style={{
              position: "absolute",
              left: animatingMove.fromX / scale - CHECKER_SIZE / 2,
              top: animatingMove.fromY / scale - CHECKER_SIZE / 2,
              width: CHECKER_SIZE,
              height: CHECKER_SIZE,
              zIndex: 100,
              pointerEvents: "none",
              "--fly-dx": `${(animatingMove.toX - animatingMove.fromX) / scale}px`,
              "--fly-dy": `${(animatingMove.toY - animatingMove.fromY) / scale}px`,
              animation: "checker-fly 200ms ease-out forwards",
            } as React.CSSProperties}
          >
            <Checker color={animatingMove.color} />
          </div>
        )}

        {/* Hint arrows overlay */}
        {hintMoves && hintMoves.length > 0 && (
          <svg
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              zIndex: 90,
              pointerEvents: "none",
              overflow: "visible",
            }}
          >
            <defs>
              <marker
                id="hint-arrow"
                markerWidth="10"
                markerHeight="8"
                refX="9"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L10,4 L0,8 Z" fill="var(--color-analysis-gold)" />
              </marker>
              <filter id="hint-glow">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {hintMoves.map((move, i) => {
              const from = getPointCenter(move.from);
              const to = getPointCenter(move.to);
              if (!from || !to) return null;
              return (
                <g key={i} style={{ animation: "hint-pulse 1.5s ease-in-out infinite" }}>
                  {/* Glow layer */}
                  <line
                    x1={from.x / scale}
                    y1={from.y / scale}
                    x2={to.x / scale}
                    y2={to.y / scale}
                    stroke="var(--color-analysis-gold)"
                    strokeWidth={10}
                    strokeLinecap="round"
                    opacity={0.25}
                    filter="url(#hint-glow)"
                  />
                  {/* Main arrow */}
                  <line
                    x1={from.x / scale}
                    y1={from.y / scale}
                    x2={to.x / scale}
                    y2={to.y / scale}
                    stroke="var(--color-analysis-gold)"
                    strokeWidth={5}
                    strokeLinecap="round"
                    markerEnd="url(#hint-arrow)"
                    opacity={0.9}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Bear-off Tray */}
      <div
        className="flex flex-col"
        aria-label="Bear-off tray"
        style={{
          width: BEAROFF_W,
          background: "var(--color-bg-base)",
          borderRadius: "0 12px 12px 0",
          borderTop: `2px solid ${canBear ? "var(--color-success)" : "var(--color-border-subtle)"}`,
          borderRight: `2px solid ${canBear ? "var(--color-success)" : "var(--color-border-subtle)"}`,
          borderBottom: `2px solid ${canBear ? "var(--color-success)" : "var(--color-border-subtle)"}`,
          borderLeft: "1px solid var(--color-border-subtle)",
          boxShadow: canBear
            ? "var(--shadow-elevated), 0 0 20px var(--color-success-muted)"
            : "var(--shadow-elevated)",
          cursor: canBear ? "pointer" : "default",
          transition: "border-color 150ms ease, box-shadow 150ms ease",
          position: "relative",
        }}
        onClick={handleBearOff}
      >
        {/* Opponent borne-off (top) */}
        <div className="flex-1 flex flex-col items-center justify-start" style={{ padding: "24px 0 8px", gap: 1 }}>
          {Array.from({ length: Math.min(bearTopCount, 15) }).map((_, i) => (
            <div
              key={i}
              style={{
                width: 36, height: 8, borderRadius: 4,
                background: bearTopColor === "white" ? "var(--color-checker-white)" : "var(--color-checker-black)",
                border: `1px solid ${bearTopColor === "white" ? "var(--color-checker-white-border)" : "var(--color-checker-black-border)"}`,
              }}
            />
          ))}
          {bearTopCount > 0 && (
            <span className="text-[10px] font-bold text-[var(--color-text-secondary)] mt-1">{bearTopCount}</span>
          )}
        </div>

        {/* Green dot when bear-off is legal */}
        {canBear && (
          <div
            className="animate-dest-pulse"
            style={{
              position: "absolute",
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "var(--color-success)",
              boxShadow: "0 0 8px var(--color-success-muted)",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 15,
              pointerEvents: "none",
            }}
          />
        )}

        <div className="mx-2" style={{ height: 1, background: "var(--color-border-subtle)" }} />

        {/* Player borne-off (bottom) */}
        <div className="flex-1 flex flex-col items-center justify-end" style={{ padding: "8px 0 24px", gap: 1 }}>
          {bearBotCount > 0 && (
            <span className="text-[10px] font-bold text-[var(--color-text-secondary)] mb-1">{bearBotCount}</span>
          )}
          {Array.from({ length: Math.min(bearBotCount, 15) }).map((_, i) => (
            <div
              key={i}
              style={{
                width: 36, height: 8, borderRadius: 4,
                background: bearBotColor === "white" ? "var(--color-checker-white)" : "var(--color-checker-black)",
                border: `1px solid ${bearBotColor === "white" ? "var(--color-checker-white-border)" : "var(--color-checker-black-border)"}`,
              }}
            />
          ))}
        </div>
      </div>
    </div>

    {/* Floating drag checker */}
    {dragState && isDraggingRef.current && (
      <div
        style={{
          position: "fixed",
          left: dragState.cursorX - (CHECKER_SIZE * scale) / 2,
          top: dragState.cursorY - (CHECKER_SIZE * scale) / 2,
          width: CHECKER_SIZE * scale,
          height: CHECKER_SIZE * scale,
          zIndex: 200,
          pointerEvents: "none",
          filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.4))",
          transform: "scale(1.1)",
          transformOrigin: "center",
        }}
      >
        <div style={{ width: CHECKER_SIZE, height: CHECKER_SIZE, zoom: scale }}>
          <Checker color={dragState.color} highlighted />
        </div>
      </div>
    )}
    </div>
  );
}
