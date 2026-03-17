import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Colors } from "@/constants/colors";
import { useGame } from "@/hooks/useGame";
import { WS_URL } from "@/lib/config";

export default function HomeScreen() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [joinCode, setJoinCode] = useState("");

  const {
    status,
    gameId,
    connected,
    authenticated,
    error,
    createGame,
    joinGame,
    joinQueue,
    leaveQueue,
  } = useGame(WS_URL, address || null);

  // Navigate to game screen when game starts
  React.useEffect(() => {
    if (status === "playing" && gameId) {
      router.push({
        pathname: "/game/[id]",
        params: { id: gameId, address: address || "" },
      });
    }
  }, [status, gameId, router, address]);

  const handleCreateGame = () => {
    createGame(0); // Free game (no wager)
  };

  const handleJoinGame = () => {
    const code = joinCode.trim();
    if (!code) return;
    joinGame(code);
  };

  const handleMatchmaking = () => {
    if (status === "queued") {
      leaveQueue();
    } else {
      joinQueue(0); // Free matchmaking
    }
  };

  const shortAddr = address
    ? `${address.slice(0, 10)}...${address.slice(-6)}`
    : "";

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top + 16 }]}
      contentContainerStyle={styles.content}
    >
      {/* Connection status */}
      <View style={styles.statusBar}>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: authenticated ? Colors.green : connected ? Colors.gold : Colors.red },
          ]}
        />
        <Text style={styles.statusText}>
          {authenticated
            ? `Connected as ${shortAddr}`
            : connected
              ? "Authenticating..."
              : "Connecting..."}
        </Text>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Quick Play */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Play</Text>
        <TouchableOpacity
          style={[styles.primaryButton, !authenticated && styles.buttonDisabled]}
          onPress={handleMatchmaking}
          disabled={!authenticated}
        >
          {status === "queued" ? (
            <View style={styles.queueRow}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.primaryButtonText}>
                Finding opponent... Tap to cancel
              </Text>
            </View>
          ) : (
            <Text style={styles.primaryButtonText}>Find Match</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Create / Join */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Private Game</Text>

        <TouchableOpacity
          style={[styles.secondaryButton, !authenticated && styles.buttonDisabled]}
          onPress={handleCreateGame}
          disabled={!authenticated}
        >
          <Text style={styles.secondaryButtonText}>Create Game</Text>
        </TouchableOpacity>

        {status === "waiting" && gameId && (
          <View style={styles.codeBox}>
            <Text style={styles.codeLabel}>Share this code:</Text>
            <Text style={styles.code} selectable>
              {gameId}
            </Text>
            <Text style={styles.codeHint}>Waiting for opponent...</Text>
          </View>
        )}

        <View style={styles.joinRow}>
          <TextInput
            style={styles.joinInput}
            placeholder="Game code"
            placeholderTextColor="#555"
            value={joinCode}
            onChangeText={setJoinCode}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[
              styles.joinButton,
              (!authenticated || !joinCode.trim()) && styles.buttonDisabled,
            ]}
            onPress={handleJoinGame}
            disabled={!authenticated || !joinCode.trim()}
          >
            <Text style={styles.joinButtonText}>Join</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Verify Rolls */}
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.linkButton}
          onPress={() =>
            router.push({
              pathname: "/verify-rolls",
              params: { address: address || "" },
            })
          }
        >
          <Text style={styles.linkButtonText}>Verify Dice Rolls</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 24,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  errorBox: {
    backgroundColor: "rgba(244, 67, 54, 0.15)",
    borderRadius: 8,
    padding: 12,
  },
  errorText: {
    color: Colors.red,
    fontSize: 13,
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  primaryButton: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
  secondaryButton: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  codeBox: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    gap: 6,
  },
  codeLabel: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  code: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.gold,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  codeHint: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  joinRow: {
    flexDirection: "row",
    gap: 10,
  },
  joinInput: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.surfaceLight,
  },
  joinButton: {
    backgroundColor: Colors.surfaceLight,
    borderRadius: 12,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  joinButtonText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  linkButton: {
    paddingVertical: 12,
    alignItems: "center",
  },
  linkButtonText: {
    color: Colors.accentLight,
    fontSize: 15,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
