import React, { useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Colors } from "@/constants/colors";
import { useGame } from "@/hooks/useGame";
import { WS_URL } from "@/lib/config";
import Board from "@/components/Board";
import type { Player } from "@xion-beginner/backgammon-core";

export default function GameScreen() {
  const { id, address } = useLocalSearchParams<{
    id: string;
    address: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    gameState,
    myColor,
    legalMoves,
    status,
    winner,
    resultType,
    opponent,
    opponentDisconnected,
    error,
    pendingConfirmation,
    canUndo,
    canDouble,
    doubleOffered,
    doubleOfferedBy,
    disconnectCountdown,
    lastReaction,
    lastOpponentMove,
    connected,
    rollDice,
    makeMove,
    endTurn,
    undoMove,
    resign,
    offerDouble,
    acceptDouble,
    rejectDouble,
    sendReaction,
    reset,
  } = useGame(WS_URL, address || null);

  const isMyTurn = useMemo(() => {
    if (!gameState || !myColor) return false;
    return gameState.currentPlayer === myColor;
  }, [gameState, myColor]);

  const needsRoll = useMemo(() => {
    if (!gameState || !isMyTurn) return false;
    return gameState.dice === null;
  }, [gameState, isMyTurn]);

  const handleResign = useCallback(() => {
    Alert.alert("Resign", "Are you sure you want to resign?", [
      { text: "Cancel", style: "cancel" },
      { text: "Resign", style: "destructive", onPress: resign },
    ]);
  }, [resign]);

  const handleGoHome = useCallback(() => {
    reset();
    router.back();
  }, [reset, router]);

  const shortOpponent = opponent
    ? opponent.startsWith("xion")
      ? `${opponent.slice(0, 8)}...${opponent.slice(-4)}`
      : opponent
    : "...";

  const turnLabel = useMemo(() => {
    if (!gameState || !myColor) return "";
    if (isMyTurn) {
      if (needsRoll) return "Your turn — tap Roll";
      if (pendingConfirmation) return "Confirm your moves";
      return "Your turn — move";
    }
    return `${shortOpponent}'s turn`;
  }, [gameState, myColor, isMyTurn, needsRoll, pendingConfirmation, shortOpponent]);

  // Dice display
  const diceText = useMemo(() => {
    if (!gameState?.dice) return "";
    return `${dieChar(gameState.dice[0])} ${dieChar(gameState.dice[1])}`;
  }, [gameState?.dice]);

  const movesRemainingText = useMemo(() => {
    if (!gameState?.movesRemaining?.length) return "";
    return gameState.movesRemaining.map(dieChar).join(" ");
  }, [gameState?.movesRemaining]);

  if (!gameState || !myColor) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
        <Text style={styles.loadingText}>
          {connected ? "Loading game..." : "Connecting..."}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View style={styles.playerInfo}>
          <View
            style={[
              styles.colorDot,
              {
                backgroundColor:
                  myColor === "white" ? Colors.white : Colors.black,
              },
            ]}
          />
          <Text style={styles.playerLabel}>
            You ({myColor})
          </Text>
        </View>
        <Text style={styles.vs}>vs</Text>
        <Text style={styles.opponentLabel} numberOfLines={1}>
          {shortOpponent}
        </Text>
      </View>

      {/* Disconnection / error banners */}
      {opponentDisconnected && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Opponent disconnected
            {disconnectCountdown !== null
              ? ` (${disconnectCountdown}s)`
              : ""}
          </Text>
        </View>
      )}
      {error && (
        <View style={[styles.banner, { backgroundColor: "rgba(244,67,54,0.2)" }]}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      )}

      {/* Reaction display */}
      {lastReaction && (
        <View style={styles.reactionBubble}>
          <Text style={styles.reactionEmoji}>{lastReaction.emoji}</Text>
        </View>
      )}

      {/* Board */}
      <View style={styles.boardContainer}>
        <Board
          board={gameState.board}
          myColor={myColor}
          legalMoves={legalMoves}
          isMyTurn={isMyTurn}
          dice={gameState.dice}
          onMove={makeMove}
          movesRemaining={gameState.movesRemaining}
          lastOpponentMove={lastOpponentMove}
          gameOver={status === "finished"}
        />
      </View>

      {/* Dice & moves remaining */}
      {gameState.dice && (
        <View style={styles.diceRow}>
          <Text style={styles.diceText}>{diceText}</Text>
          {gameState.movesRemaining.length > 0 &&
            gameState.movesRemaining.length !==
              (gameState.dice[0] === gameState.dice[1] ? 4 : 2) && (
              <Text style={styles.remainingText}>
                Left: {movesRemainingText}
              </Text>
            )}
        </View>
      )}

      {/* Cube value */}
      {gameState.cubeValue > 1 && (
        <Text style={styles.cubeText}>
          Cube: {gameState.cubeValue}x
          {gameState.cubeOwner
            ? ` (${gameState.cubeOwner === myColor ? "you" : "opp"})`
            : ""}
        </Text>
      )}

      {/* Turn label */}
      <Text style={styles.turnLabel}>{turnLabel}</Text>

      {/* Double offer modal */}
      {doubleOffered && doubleOfferedBy !== myColor && (
        <View style={styles.doubleModal}>
          <Text style={styles.doubleText}>
            Opponent offers to double the cube
          </Text>
          <View style={styles.doubleButtons}>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: Colors.green }]}
              onPress={acceptDouble}
            >
              <Text style={styles.actionButtonText}>Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: Colors.red }]}
              onPress={rejectDouble}
            >
              <Text style={styles.actionButtonText}>Decline</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Action buttons */}
      {status === "playing" && (
        <View style={styles.actions}>
          {needsRoll && !doubleOffered && (
            <View style={styles.rollRow}>
              {canDouble && (
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: Colors.surfaceLight }]}
                  onPress={offerDouble}
                >
                  <Text style={styles.actionButtonText}>Double</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: Colors.accent, flex: 1 }]}
                onPress={rollDice}
              >
                <Text style={styles.actionButtonText}>Roll Dice</Text>
              </TouchableOpacity>
            </View>
          )}

          {!needsRoll && isMyTurn && (
            <View style={styles.moveActions}>
              {canUndo && (
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: Colors.surfaceLight }]}
                  onPress={undoMove}
                >
                  <Text style={styles.actionButtonText}>Undo</Text>
                </TouchableOpacity>
              )}
              {(pendingConfirmation || legalMoves.length === 0) && (
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: Colors.green, flex: 1 }]}
                  onPress={endTurn}
                >
                  <Text style={styles.actionButtonText}>
                    {pendingConfirmation ? "Confirm" : "End Turn"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          <TouchableOpacity
            style={styles.resignButton}
            onPress={handleResign}
          >
            <Text style={styles.resignText}>Resign</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Game over */}
      {status === "finished" && winner && (
        <View style={styles.gameOverBox}>
          <Text style={styles.gameOverTitle}>
            {winner === myColor ? "You Won!" : "You Lost"}
          </Text>
          <Text style={styles.gameOverDetail}>
            {resultType === "backgammon"
              ? "Backgammon!"
              : resultType === "gammon"
                ? "Gammon!"
                : resultType === "resign"
                  ? "By resignation"
                  : resultType === "timeout"
                    ? "By timeout"
                    : "Normal win"}
          </Text>
          <TouchableOpacity style={styles.homeButton} onPress={handleGoHome}>
            <Text style={styles.homeButtonText}>Back to Lobby</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom padding */}
      <View style={{ height: insets.bottom + 16 }} />
    </View>
  );
}

function dieChar(value: number): string {
  const chars = ["", "\u2680", "\u2681", "\u2682", "\u2683", "\u2684", "\u2685"];
  return chars[value] || String(value);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    paddingHorizontal: 8,
  },
  loadingText: {
    color: Colors.textMuted,
    fontSize: 16,
    textAlign: "center",
    marginTop: 100,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  playerInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  colorDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#555",
  },
  playerLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  vs: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  opponentLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
    maxWidth: 120,
  },
  banner: {
    backgroundColor: "rgba(255,193,7,0.2)",
    borderRadius: 8,
    padding: 8,
    marginHorizontal: 8,
    marginBottom: 4,
  },
  bannerText: {
    color: Colors.gold,
    fontSize: 13,
    textAlign: "center",
  },
  reactionBubble: {
    position: "absolute",
    top: 100,
    alignSelf: "center",
    zIndex: 10,
  },
  reactionEmoji: {
    fontSize: 48,
  },
  boardContainer: {
    alignItems: "center",
    marginVertical: 8,
  },
  diceRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    paddingVertical: 4,
  },
  diceText: {
    fontSize: 32,
    color: Colors.text,
  },
  remainingText: {
    fontSize: 14,
    color: Colors.textMuted,
  },
  cubeText: {
    fontSize: 13,
    color: Colors.gold,
    textAlign: "center",
  },
  turnLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
    textAlign: "center",
    paddingVertical: 6,
  },
  doubleModal: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 16,
    marginVertical: 8,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: Colors.surfaceLight,
  },
  doubleText: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
    textAlign: "center",
  },
  doubleButtons: {
    flexDirection: "row",
    gap: 12,
  },
  actions: {
    paddingHorizontal: 16,
    gap: 8,
  },
  rollRow: {
    flexDirection: "row",
    gap: 10,
  },
  moveActions: {
    flexDirection: "row",
    gap: 10,
  },
  actionButton: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  actionButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  resignButton: {
    alignItems: "center",
    paddingVertical: 8,
  },
  resignText: {
    color: Colors.textMuted,
    fontSize: 13,
    textDecorationLine: "underline",
  },
  gameOverBox: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 24,
    marginHorizontal: 16,
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.surfaceLight,
  },
  gameOverTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: Colors.gold,
  },
  gameOverDetail: {
    fontSize: 15,
    color: Colors.textMuted,
  },
  homeButton: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 8,
  },
  homeButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
