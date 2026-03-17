import React, { useMemo, useState, useCallback } from "react";
import { View, StyleSheet, useWindowDimensions } from "react-native";
import Svg, {
  Rect,
  Circle,
  Polygon,
  G,
  Text as SvgText,
  Line,
} from "react-native-svg";
import type { BoardState, Player, Move } from "@xion-beginner/backgammon-core";
import { WHITE_BAR, BLACK_BAR } from "@xion-beginner/backgammon-core";
import { Colors } from "@/constants/colors";

// ─── Layout constants (in viewBox units) ────────────────────────

const BORDER = 8;
const POINT_W = 46;
const POINT_H = 180;
const POINT_GAP = 1;
const BAR_W = 32;
const BEAROFF_W = 40;
const CHECKER_R = 18;
const CHECKER_STACK_OFFSET = 36;
const MAX_SHOW = 5;
const CENTER_H = 40;

const QUAD_W = 6 * POINT_W + 5 * POINT_GAP;
const BOARD_W = BORDER * 2 + QUAD_W * 2 + BAR_W + BEAROFF_W;
const BOARD_H = BORDER * 2 + POINT_H * 2 + CENTER_H;

// Colors – mapped from web CSS variables via Colors constants
const WOOD_BORDER = Colors.boardBar;           // #2A2118
const FELT_DARK = Colors.feltDark;             // #2D5A28
const FELT_LIGHT = Colors.feltLight;           // #3A6B35
const POINT_DARK = Colors.pointDark;           // #A0522D (sienna)
const POINT_LIGHT = Colors.pointLight;         // #E8C78A (tan/wheat)
const CHECKER_WHITE = Colors.white;            // #DCD8D0
const CHECKER_WHITE_STROKE = Colors.whiteBorder; // #A8A098
const CHECKER_BLACK = Colors.black;            // #8A2040 (burgundy)
const CHECKER_BLACK_STROKE = Colors.blackBorder; // #A04060
const HIGHLIGHT_COLOR = Colors.boardHighlight; // rgba(88, 20, 40, 0.25) burgundy tint
const SELECTED_COLOR = "rgba(88, 20, 40, 0.4)"; // burgundy selected source

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
}

// ─── Helpers ────────────────────────────────────────────────────

/** Get the visual point index (0-23) for a board point (1-24) from a player's perspective */
function visualIndex(point: number, myColor: Player): number {
  // White views from bottom-right (point 1) to top-right (point 24)
  // Black views mirrored
  if (myColor === "white") {
    return 24 - point;
  }
  return point - 1;
}

/** Get x,y center of a point for checker placement */
function pointCenter(
  vi: number,
): { x: number; topY: number; bottomY: number; isTop: boolean } {
  const isTop = vi < 12;
  const col = isTop ? 11 - vi : vi - 12;
  const quad = col < 6 ? 0 : 1;
  const colInQuad = col < 6 ? col : col - 6;

  const x =
    BORDER +
    quad * (QUAD_W + BAR_W) +
    colInQuad * (POINT_W + POINT_GAP) +
    POINT_W / 2;

  const topY = BORDER;
  const bottomY = BOARD_H - BORDER;

  return { x, topY, bottomY, isTop };
}

function checkerY(isTop: boolean, stackIndex: number): number {
  if (isTop) {
    return BORDER + CHECKER_R + 2 + stackIndex * CHECKER_STACK_OFFSET;
  }
  return (
    BOARD_H - BORDER - CHECKER_R - 2 - stackIndex * CHECKER_STACK_OFFSET
  );
}

// ─── Component ──────────────────────────────────────────────────

export default function Board({
  board,
  myColor,
  legalMoves,
  isMyTurn,
  onMove,
  movesRemaining,
  lastOpponentMove,
  gameOver,
}: BoardProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);

  // Destinations from selected point
  const destinations = useMemo(() => {
    if (selectedPoint === null) return new Set<number>();
    return new Set(
      legalMoves
        .filter((m) => m.from === selectedPoint)
        .map((m) => m.to),
    );
  }, [selectedPoint, legalMoves]);

  // Points that have legal moves originating from them
  const sourcesWithMoves = useMemo(() => {
    return new Set(legalMoves.map((m) => m.from));
  }, [legalMoves]);

  const handlePointPress = useCallback(
    (boardPoint: number) => {
      if (!isMyTurn || gameOver) return;

      // If clicking a destination, make the move
      if (selectedPoint !== null && destinations.has(boardPoint)) {
        onMove(selectedPoint, boardPoint);
        setSelectedPoint(null);
        return;
      }

      // If clicking a source point, select it
      if (sourcesWithMoves.has(boardPoint)) {
        setSelectedPoint(boardPoint);
        return;
      }

      // Deselect
      setSelectedPoint(null);
    },
    [
      isMyTurn,
      gameOver,
      selectedPoint,
      destinations,
      sourcesWithMoves,
      onMove,
    ],
  );

  // Handle bear-off tap (to = 0 for white, to = 25 for black)
  const handleBearoffPress = useCallback(() => {
    if (!isMyTurn || gameOver || selectedPoint === null) return;
    const bearoffTarget = myColor === "white" ? 0 : 25;
    if (destinations.has(bearoffTarget)) {
      onMove(selectedPoint, bearoffTarget);
      setSelectedPoint(null);
    }
  }, [isMyTurn, gameOver, selectedPoint, destinations, myColor, onMove]);

  // Handle bar tap
  const handleBarPress = useCallback(() => {
    if (!isMyTurn || gameOver) return;
    const barPoint = myColor === "white" ? WHITE_BAR : BLACK_BAR;
    if (sourcesWithMoves.has(barPoint)) {
      setSelectedPoint(barPoint);
    }
  }, [isMyTurn, gameOver, myColor, sourcesWithMoves]);

  // ─── SVG Rendering ──────────────────────────────────────────

  const svgWidth = Math.min(screenWidth - 16, 640);
  const svgHeight = (svgWidth / BOARD_W) * BOARD_H;

  return (
    <View style={[styles.container, { width: svgWidth, height: svgHeight }]}>
      <Svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
      >
        {/* Board background */}
        <Rect
          x={0}
          y={0}
          width={BOARD_W}
          height={BOARD_H}
          fill={WOOD_BORDER}
          rx={6}
        />
        {/* Playing surface */}
        <Rect
          x={BORDER}
          y={BORDER}
          width={BOARD_W - BORDER * 2 - BEAROFF_W}
          height={BOARD_H - BORDER * 2}
          fill={FELT_DARK}
        />

        {/* Points (triangles) */}
        {Array.from({ length: 24 }, (_, vi) => {
          const isTop = vi < 12;
          const col = isTop ? 11 - vi : vi - 12;
          const quad = col < 6 ? 0 : 1;
          const colInQuad = col < 6 ? col : col - 6;
          const x =
            BORDER +
            quad * (QUAD_W + BAR_W) +
            colInQuad * (POINT_W + POINT_GAP);
          const isDark = vi % 2 === 0;
          const fill = isDark ? POINT_DARK : POINT_LIGHT;

          // Board point number (1-24) from this visual index
          const boardPt = myColor === "white" ? 24 - vi : vi + 1;
          const isSelected = selectedPoint === boardPt;
          const isDest =
            selectedPoint !== null && destinations.has(boardPt);
          const hasLegalMoves = sourcesWithMoves.has(boardPt);

          let trianglePoints: string;
          if (isTop) {
            trianglePoints = `${x},${BORDER} ${x + POINT_W},${BORDER} ${x + POINT_W / 2},${BORDER + POINT_H}`;
          } else {
            trianglePoints = `${x},${BOARD_H - BORDER} ${x + POINT_W},${BOARD_H - BORDER} ${x + POINT_W / 2},${BOARD_H - BORDER - POINT_H}`;
          }

          return (
            <G
              key={vi}
              onPress={() => handlePointPress(boardPt)}
            >
              <Polygon points={trianglePoints} fill={fill} />
              {/* Highlight for selected source */}
              {isSelected && (
                <Polygon
                  points={trianglePoints}
                  fill={SELECTED_COLOR}
                />
              )}
              {/* Highlight for legal destination */}
              {isDest && (
                <Polygon
                  points={trianglePoints}
                  fill={HIGHLIGHT_COLOR}
                />
              )}
              {/* Subtle glow for points with legal moves */}
              {isMyTurn &&
                !isSelected &&
                !isDest &&
                hasLegalMoves && (
                  <Circle
                    cx={x + POINT_W / 2}
                    cy={isTop ? BORDER + 12 : BOARD_H - BORDER - 12}
                    r={4}
                    fill={Colors.accent}
                    opacity={0.7}
                  />
                )}
              {/* Point number */}
              <SvgText
                x={x + POINT_W / 2}
                y={isTop ? BORDER - 1 : BOARD_H - BORDER + 10}
                fontSize={8}
                fill={Colors.textMuted}
                textAnchor="middle"
              >
                {boardPt}
              </SvgText>
            </G>
          );
        })}

        {/* Center bar */}
        <Rect
          x={BORDER + QUAD_W}
          y={BORDER}
          width={BAR_W}
          height={BOARD_H - BORDER * 2}
          fill={Colors.boardBar}
          onPress={handleBarPress}
        />

        {/* Bear-off tray */}
        <Rect
          x={BOARD_W - BEAROFF_W}
          y={0}
          width={BEAROFF_W}
          height={BOARD_H}
          fill={Colors.boardBar}
          rx={4}
          onPress={handleBearoffPress}
        />
        {/* Bear-off label */}
        <SvgText
          x={BOARD_W - BEAROFF_W / 2}
          y={BOARD_H / 2}
          fontSize={9}
          fill={Colors.textMuted}
          textAnchor="middle"
          rotation={-90}
          originX={BOARD_W - BEAROFF_W / 2}
          originY={BOARD_H / 2}
        >
          BEAR OFF
        </SvgText>

        {/* Checkers on points (1-24 only, skip bar indices 0 and 25) */}
        {board.points.slice(1, 25).map((count, i) => {
          const boardPt = i + 1;
          const vi = visualIndex(boardPt, myColor);
          const { x } = pointCenter(vi);
          const isTop = vi < 12;
          const absCount = Math.abs(count);
          const color = count > 0 ? "white" : "black";
          if (absCount === 0) return null;

          const shown = Math.min(absCount, MAX_SHOW);
          return Array.from({ length: shown }, (_, si) => {
            const cy = checkerY(isTop, si);
            return (
              <G
                key={`${boardPt}-${si}`}
                onPress={() => handlePointPress(boardPt)}
              >
                <Circle
                  cx={x}
                  cy={cy}
                  r={CHECKER_R}
                  fill={
                    color === "white" ? CHECKER_WHITE : CHECKER_BLACK
                  }
                  stroke={
                    color === "white"
                      ? CHECKER_WHITE_STROKE
                      : CHECKER_BLACK_STROKE
                  }
                  strokeWidth={1.5}
                />
                {/* Count badge for stacks > MAX_SHOW */}
                {si === shown - 1 && absCount > MAX_SHOW && (
                  <SvgText
                    x={x}
                    y={cy + 4}
                    fontSize={12}
                    fontWeight="bold"
                    fill={color === "white" ? Colors.boardBar : Colors.text}
                    textAnchor="middle"
                  >
                    {absCount}
                  </SvgText>
                )}
              </G>
            );
          });
        })}

        {/* Bar checkers (white) — stored in points[0] as positive count */}
        {board.points[WHITE_BAR] > 0 &&
          Array.from(
            { length: Math.min(board.points[WHITE_BAR], 3) },
            (_, si) => (
              <G key={`wbar-${si}`} onPress={handleBarPress}>
                <Circle
                  cx={BORDER + QUAD_W + BAR_W / 2}
                  cy={
                    BOARD_H / 2 +
                    CENTER_H / 2 +
                    CHECKER_R +
                    si * CHECKER_STACK_OFFSET
                  }
                  r={CHECKER_R}
                  fill={CHECKER_WHITE}
                  stroke={CHECKER_WHITE_STROKE}
                  strokeWidth={1.5}
                />
              </G>
            ),
          )}
        {board.points[WHITE_BAR] > 3 && (
          <SvgText
            x={BORDER + QUAD_W + BAR_W / 2}
            y={
              BOARD_H / 2 +
              CENTER_H / 2 +
              CHECKER_R +
              2 * CHECKER_STACK_OFFSET +
              4
            }
            fontSize={11}
            fontWeight="bold"
            fill={Colors.boardBar}
            textAnchor="middle"
          >
            {board.points[WHITE_BAR]}
          </SvgText>
        )}

        {/* Bar checkers (black) — stored in points[25] as negative count */}
        {board.points[BLACK_BAR] < 0 &&
          Array.from(
            { length: Math.min(-board.points[BLACK_BAR], 3) },
            (_, si) => (
              <G key={`bbar-${si}`} onPress={handleBarPress}>
                <Circle
                  cx={BORDER + QUAD_W + BAR_W / 2}
                  cy={
                    BOARD_H / 2 -
                    CENTER_H / 2 -
                    CHECKER_R -
                    si * CHECKER_STACK_OFFSET
                  }
                  r={CHECKER_R}
                  fill={CHECKER_BLACK}
                  stroke={CHECKER_BLACK_STROKE}
                  strokeWidth={1.5}
                />
              </G>
            ),
          )}

        {/* Borne-off checkers */}
        {board.whiteOff > 0 && (
          <G>
            {Array.from(
              { length: Math.min(board.whiteOff, 15) },
              (_, si) => (
                <Rect
                  key={`woff-${si}`}
                  x={BOARD_W - BEAROFF_W + 6}
                  y={
                    BOARD_H -
                    BORDER -
                    8 -
                    si * 8
                  }
                  width={BEAROFF_W - 12}
                  height={6}
                  fill={CHECKER_WHITE}
                  stroke={CHECKER_WHITE_STROKE}
                  strokeWidth={0.5}
                  rx={2}
                />
              ),
            )}
          </G>
        )}
        {board.blackOff > 0 && (
          <G>
            {Array.from(
              { length: Math.min(board.blackOff, 15) },
              (_, si) => (
                <Rect
                  key={`boff-${si}`}
                  x={BOARD_W - BEAROFF_W + 6}
                  y={BORDER + 2 + si * 8}
                  width={BEAROFF_W - 12}
                  height={6}
                  fill={CHECKER_BLACK}
                  stroke={CHECKER_BLACK_STROKE}
                  strokeWidth={0.5}
                  rx={2}
                />
              ),
            )}
          </G>
        )}

        {/* Last opponent move highlight */}
        {lastOpponentMove && (() => {
          const toPoint = lastOpponentMove.to;
          if (toPoint < 1 || toPoint > 24) return null;
          const vi = visualIndex(toPoint, myColor);
          const { x } = pointCenter(vi);
          const isTop = vi < 12;
          return (
            <Circle
              cx={x}
              cy={isTop ? BORDER + 10 : BOARD_H - BORDER - 10}
              r={6}
              fill="rgba(136, 32, 64, 0.5)"
            />
          );
        })()}

        {/* Center divider line */}
        <Line
          x1={BORDER}
          y1={BOARD_H / 2}
          x2={BORDER + QUAD_W}
          y2={BOARD_H / 2}
          stroke={Colors.feltLight}
          strokeWidth={1}
        />
        <Line
          x1={BORDER + QUAD_W + BAR_W}
          y1={BOARD_H / 2}
          x2={BOARD_W - BEAROFF_W}
          y2={BOARD_H / 2}
          stroke={Colors.feltLight}
          strokeWidth={1}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: "center",
  },
});
