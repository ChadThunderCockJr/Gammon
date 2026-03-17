import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/contexts/ThemeContext";
import { Theme } from "@/constants/themes";
import { useGame } from "@/hooks/useGame";
import { WS_URL } from "@/lib/config";

export default function HomeScreen() {
  const { address } = useLocalSearchParams<{ address: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [joinCode, setJoinCode] = useState("");

  const styles = useMemo(() => makeStyles(colors), [colors]);

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
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.greeting}>Welcome back</Text>
        {shortAddr ? (
          <Text style={styles.addressText}>{shortAddr}</Text>
        ) : null}
      </View>

      {/* Connection status */}
      <View style={styles.statusBar}>
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor: authenticated
                ? colors.green
                : connected
                  ? colors.gold
                  : colors.red,
            },
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

      {/* Quick Play Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Quick Play</Text>
        <TouchableOpacity
          style={[
            styles.primaryButton,
            !authenticated && styles.buttonDisabled,
          ]}
          onPress={handleMatchmaking}
          disabled={!authenticated}
        >
          {status === "queued" ? (
            <View style={styles.queueRow}>
              <ActivityIndicator color={colors.accentFg} size="small" />
              <Text style={styles.primaryButtonText}>
                Finding opponent... Tap to cancel
              </Text>
            </View>
          ) : (
            <Text style={styles.primaryButtonText}>Find Match</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Private Game Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Private Game</Text>

        <TouchableOpacity
          style={[
            styles.secondaryButton,
            !authenticated && styles.buttonDisabled,
          ]}
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
            placeholderTextColor={colors.textFaint}
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

      {/* Verify Dice Rolls Link */}
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
    </ScrollView>
  );
}

function makeStyles(colors: Theme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    content: {
      paddingHorizontal: 20,
      paddingBottom: 40,
      gap: 16,
    },

    // Header
    header: {
      gap: 4,
      marginBottom: 4,
    },
    greeting: {
      fontSize: 24,
      fontWeight: "700",
      color: colors.text,
    },
    addressText: {
      fontSize: 13,
      color: colors.textMuted,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },

    // Status bar
    statusBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    statusText: {
      fontSize: 13,
      color: colors.textMuted,
    },

    // Error
    errorBox: {
      backgroundColor: "rgba(204, 68, 68, 0.15)",
      borderRadius: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: "rgba(204, 68, 68, 0.3)",
    },
    errorText: {
      color: colors.red,
      fontSize: 13,
    },

    // Card container
    card: {
      backgroundColor: colors.surface,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
      gap: 12,
    },

    // Section title
    sectionTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.text,
    },

    // Primary button (Find Match)
    primaryButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: "center",
    },
    primaryButtonText: {
      color: colors.accentFg,
      fontSize: 16,
      fontWeight: "700",
    },

    // Secondary button (Create Game)
    secondaryButton: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 14,
      alignItems: "center",
    },
    secondaryButtonText: {
      color: colors.text,
      fontSize: 16,
      fontWeight: "600",
    },

    // Disabled state
    buttonDisabled: {
      opacity: 0.4,
    },

    // Queue row
    queueRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },

    // Code display
    codeBox: {
      backgroundColor: colors.surface,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
      alignItems: "center",
      gap: 6,
    },
    codeLabel: {
      fontSize: 13,
      color: colors.textMuted,
    },
    code: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.gold,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    codeHint: {
      fontSize: 12,
      color: colors.textMuted,
    },

    // Join row
    joinRow: {
      flexDirection: "row",
      gap: 10,
    },
    joinInput: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: colors.border,
      paddingHorizontal: 13,
      paddingVertical: 13,
      fontSize: 15,
      color: colors.text,
    },
    joinButton: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 20,
      justifyContent: "center",
    },
    joinButtonText: {
      color: colors.text,
      fontSize: 16,
      fontWeight: "600",
    },

    // Verify Dice Rolls link
    linkButton: {
      paddingVertical: 8,
      alignItems: "center",
    },
    linkButtonText: {
      color: colors.accentLight,
      fontSize: 15,
      fontWeight: "600",
    },
  });
}
