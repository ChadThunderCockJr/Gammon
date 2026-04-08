"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useLocalGame } from "@/hooks/useLocalGame";
import { useConsultation } from "@/hooks/useConsultation";
import { GameScreen } from "@/components/GameScreen";
import type { AIDifficulty } from "@/lib/ai";

const VALID_DIFFICULTIES = new Set<AIDifficulty>([
  "beginner",
  "club",
  "expert",
  "gm",
]);

function AIMatchInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const rawDifficulty = searchParams.get("difficulty") ?? "expert";
  const difficulty: AIDifficulty = VALID_DIFFICULTIES.has(
    rawDifficulty as AIDifficulty
  )
    ? (rawDifficulty as AIDifficulty)
    : "expert";

  const {
    gameState,
    myColor,
    legalMoves,
    opponent,
    opponentDisconnected,
    winner,
    resultType,
    canUndo,
    turnStartedAt,
    lastOpponentMove,
    cubeValue,
    cubeOwner,
    doubleOffered,
    doubleOfferedBy,
    canDouble,
    forcedMoveNotice,
    turnHistory,
    rollDice,
    makeMove,
    endTurn,
    undoMove,
    resign,
    reset,
    offerDouble,
    acceptDouble,
    rejectDouble,
  } = useLocalGame(difficulty);

  const consultation = useConsultation();

  // Analyze the human player's move after each turn
  const prevTurnCountRef = useRef(turnHistory.length);
  useEffect(() => {
    if (!consultation.enabled) return;
    if (turnHistory.length <= prevTurnCountRef.current) {
      prevTurnCountRef.current = turnHistory.length;
      return;
    }
    prevTurnCountRef.current = turnHistory.length;

    const lastTurn = turnHistory[turnHistory.length - 1];
    if (!lastTurn || lastTurn.player !== myColor) return;
    if (!lastTurn.boardBefore || lastTurn.moves.length === 0) return;

    const boardBefore = {
      points: lastTurn.boardBefore.points,
      whiteOff: lastTurn.boardBefore.whiteOff,
      blackOff: lastTurn.boardBefore.blackOff,
    };

    consultation.analyzeMove(
      boardBefore,
      lastTurn.player,
      lastTurn.dice,
      lastTurn.moves.map((m) => ({ from: m.from, to: m.to, die: m.die })),
    );
  }, [turnHistory.length, consultation.enabled, myColor]);

  // Clear hint when dice change, turn changes, or a move is made
  useEffect(() => {
    consultation.clearHint();
  }, [gameState.dice, gameState.currentPlayer, gameState.movesRemaining.length]);

  // Clear analysis when it's the human's turn again (new turn cycle)
  const isMyTurn = gameState.currentPlayer === myColor;
  useEffect(() => {
    if (isMyTurn && gameState.dice === null) {
      consultation.clearAnalysis();
    }
  }, [isMyTurn, gameState.dice]);

  // Hint is only valid at the start of a turn (all dice available).
  // GNUBG evaluates full turns, not partial turns, so mid-turn hints
  // would be wrong — it would treat remaining dice as the full roll.
  const allDiceAvailable = gameState.dice !== null &&
    gameState.movesRemaining.length === (gameState.dice[0] === gameState.dice[1] ? 4 : 2);

  const handleRequestHint = () => {
    if (!gameState.dice || !allDiceAvailable) return;
    consultation.requestHint(gameState.board, myColor, gameState.movesRemaining);
  };

  return (
    <GameScreen
      gameState={gameState}
      myColor={myColor}
      legalMoves={legalMoves}
      opponent={opponent}
      opponentDisconnected={opponentDisconnected}
      winner={winner}
      resultType={resultType}
      onMove={makeMove}
      onRollDice={rollDice}
      onEndTurn={endTurn}
      onResign={resign}
      onUndo={undoMove}
      canUndo={canUndo}
      turnStartedAt={null}
      lastOpponentMove={lastOpponentMove}
      onNewGame={reset}
      onBackToLobby={() => {
        reset();
        router.push("/");
      }}
      cubeValue={cubeValue}
      cubeOwner={cubeOwner}
      doubleOffered={doubleOffered}
      doubleOfferedBy={doubleOfferedBy}
      canDouble={canDouble}
      onDouble={offerDouble}
      onAcceptDouble={acceptDouble}
      onRejectDouble={rejectDouble}
      forcedMoveNotice={forcedMoveNotice}
      turnHistory={turnHistory}
      // Consultation mode
      isAIGame
      consultationEnabled={consultation.enabled}
      onToggleConsultation={consultation.toggle}
      consultationAnalysis={consultation.lastMoveAnalysis}
      consultationAnalysisLoading={consultation.analysisLoading}
      consultationHintLoading={consultation.hintLoading}
      hintMoves={consultation.hintMoves}
      consultationGnubgReady={consultation.gnubgReady}
      canRequestHint={allDiceAvailable}
      onRequestHint={handleRequestHint}
      onClearHint={consultation.clearHint}
    />
  );
}

export default function AIMatchPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            height: "100vh",
            background: "var(--color-bg-deepest)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-secondary)",
            fontSize: "0.875rem",
          }}
        >
          Loading...
        </div>
      }
    >
      <AIMatchInner />
    </Suspense>
  );
}
