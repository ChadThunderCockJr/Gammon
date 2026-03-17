import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Linking,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Colors } from "@/constants/colors";
import { fetchDiceProofs } from "@/lib/api";
import {
  verifyDiceRoll,
  DRAND_CHAIN_HASH,
  type DiceProof,
  type DiceProofsResponse,
} from "@/lib/dice-verify";

type VerifyStatus = "idle" | "pending" | "valid" | "invalid";

interface VerifiedRoll extends DiceProof {
  status: VerifyStatus;
  details?: string;
}

export default function VerifyRollsScreen() {
  const insets = useSafeAreaInsets();
  const [gameId, setGameId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proofs, setProofs] = useState<DiceProofsResponse | null>(null);
  const [rolls, setRolls] = useState<VerifiedRoll[]>([]);
  const [verifyingAll, setVerifyingAll] = useState(false);

  const handleFetchProofs = useCallback(async () => {
    const trimmed = gameId.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setProofs(null);
    setRolls([]);
    try {
      const data: DiceProofsResponse = await fetchDiceProofs(trimmed);
      setProofs(data);
      setRolls(
        data.rolls.map((r) => ({
          ...r,
          status: "idle" as VerifyStatus,
        })),
      );
    } catch (e: any) {
      setError(e.message || "Failed to fetch dice proofs");
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  const verifyOne = useCallback(
    async (index: number) => {
      const roll = rolls[index];
      if (!roll) return;

      setRolls((prev) =>
        prev.map((r, i) =>
          i === index ? { ...r, status: "pending" } : r,
        ),
      );

      const result = await verifyDiceRoll({
        drandRound: roll.drandRound,
        drandRandomness: roll.drandRandomness,
        drandSignature: roll.drandSignature,
        playerWhite: roll.playerWhite,
        playerBlack: roll.playerBlack,
        turnNumber: roll.turnNumber,
        dice: roll.dice,
      });

      setRolls((prev) =>
        prev.map((r, i) =>
          i === index
            ? {
                ...r,
                status: result.valid ? "valid" : "invalid",
                details: result.details,
              }
            : r,
        ),
      );
    },
    [rolls],
  );

  const handleVerifyAll = useCallback(async () => {
    setVerifyingAll(true);
    for (let i = 0; i < rolls.length; i++) {
      await verifyOne(i);
    }
    setVerifyingAll(false);
  }, [rolls.length, verifyOne]);

  const openDrandBeacon = (round: number) => {
    const url = `https://api.drand.sh/${DRAND_CHAIN_HASH}/public/${round}`;
    Linking.openURL(url);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: insets.bottom + 24 },
      ]}
    >
      {/* Input */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Game ID"
          placeholderTextColor={Colors.textMuted}
          value={gameId}
          onChangeText={setGameId}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={handleFetchProofs}
        />
        <TouchableOpacity
          style={[styles.fetchButton, !gameId.trim() && styles.buttonDisabled]}
          onPress={handleFetchProofs}
          disabled={!gameId.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator color={Colors.accentFg} size="small" />
          ) : (
            <Text style={styles.fetchButtonText}>Fetch</Text>
          )}
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Results */}
      {proofs && (
        <>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>
              Game: <Text style={styles.metaMono}>{proofs.gameId}</Text>
            </Text>
            <Text style={styles.metaLabel}>
              White:{" "}
              <Text style={styles.metaMono}>
                {proofs.playerWhite.slice(0, 12)}...
              </Text>
            </Text>
            <Text style={styles.metaLabel}>
              Black:{" "}
              <Text style={styles.metaMono}>
                {proofs.playerBlack.slice(0, 12)}...
              </Text>
            </Text>
            <Text style={styles.metaLabel}>
              Rolls: {proofs.rolls.length}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.verifyAllButton,
              verifyingAll && styles.buttonDisabled,
            ]}
            onPress={handleVerifyAll}
            disabled={verifyingAll}
          >
            {verifyingAll ? (
              <View style={styles.verifyingRow}>
                <ActivityIndicator color={Colors.text} size="small" />
                <Text style={styles.verifyAllText}>Verifying...</Text>
              </View>
            ) : (
              <Text style={styles.verifyAllText}>
                Verify All Rolls (BLS)
              </Text>
            )}
          </TouchableOpacity>

          {/* Roll list */}
          {rolls.map((roll, i) => (
            <TouchableOpacity
              key={i}
              style={styles.rollCard}
              onPress={() => verifyOne(i)}
              activeOpacity={0.7}
            >
              <View style={styles.rollHeader}>
                <Text style={styles.rollTurn}>Turn {roll.turnNumber}</Text>
                <View style={styles.diceRow}>
                  <Text style={styles.dieText}>
                    {dieChar(roll.dice[0])} {dieChar(roll.dice[1])}
                  </Text>
                </View>
                <StatusBadge status={roll.status} />
              </View>

              <TouchableOpacity
                onPress={() => openDrandBeacon(roll.drandRound)}
              >
                <Text style={styles.roundLink}>
                  drand round #{roll.drandRound}
                </Text>
              </TouchableOpacity>

              {roll.details && (
                <Text
                  style={[
                    styles.detailText,
                    roll.status === "invalid" && { color: Colors.red },
                  ]}
                >
                  {roll.details}
                </Text>
              )}
            </TouchableOpacity>
          ))}
        </>
      )}

      {/* Explanation */}
      {!proofs && !loading && (
        <View style={styles.explainBox}>
          <Text style={styles.explainTitle}>
            Verifiable Dice with drand
          </Text>
          <Text style={styles.explainText}>
            Every dice roll uses randomness from the League of Entropy
            (drand) — a distributed network of organizations running BLS
            threshold signatures every 3 seconds. The server cannot
            influence the randomness.
          </Text>
          <Text style={styles.explainText}>
            Enter a game ID above to fetch and cryptographically verify
            every dice roll from that game, directly on your device.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function StatusBadge({ status }: { status: VerifyStatus }) {
  if (status === "idle") return null;
  if (status === "pending") {
    return <ActivityIndicator color={Colors.gold} size="small" />;
  }
  return (
    <View
      style={[
        statusStyles.badge,
        {
          backgroundColor:
            status === "valid"
              ? "rgba(96, 168, 96, 0.12)"
              : "rgba(204, 68, 68, 0.12)",
        },
      ]}
    >
      <Text
        style={[
          statusStyles.text,
          { color: status === "valid" ? Colors.green : Colors.red },
        ]}
      >
        {status === "valid" ? "VALID" : "INVALID"}
      </Text>
    </View>
  );
}

const statusStyles = StyleSheet.create({
  badge: {
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  text: {
    fontSize: 11,
    fontWeight: "700",
  },
});

function dieChar(value: number): string {
  const chars = [
    "",
    "\u2680",
    "\u2681",
    "\u2682",
    "\u2683",
    "\u2684",
    "\u2685",
  ];
  return chars[value] || String(value);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 16,
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  fetchButton: {
    backgroundColor: Colors.accent,
    borderRadius: 6,
    paddingHorizontal: 20,
    justifyContent: "center",
  },
  fetchButtonText: {
    color: Colors.accentFg,
    fontSize: 16,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  errorBox: {
    backgroundColor: "rgba(204, 68, 68, 0.12)",
    borderRadius: 8,
    padding: 12,
  },
  errorText: {
    color: Colors.red,
    fontSize: 13,
  },
  metaBox: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  metaLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.1 * 11,
  },
  metaMono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: Colors.text,
    textTransform: "none",
    letterSpacing: 0,
  },
  verifyAllButton: {
    backgroundColor: Colors.surface,
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  verifyAllText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  verifyingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rollCard: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rollHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rollTurn: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  diceRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  dieText: {
    fontSize: 20,
    color: Colors.text,
  },
  roundLink: {
    fontSize: 12,
    color: Colors.accentLight,
    textDecorationLine: "underline",
  },
  detailText: {
    fontSize: 11,
    color: Colors.textMuted,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  explainBox: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    padding: 20,
    gap: 12,
    marginTop: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  explainTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  explainText: {
    fontSize: 14,
    color: Colors.textMuted,
    lineHeight: 20,
  },
});
