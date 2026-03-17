import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Colors } from "@/constants/colors";

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");

  const handleLogin = () => {
    const trimmed = address.trim();
    if (!trimmed) return;
    router.replace({ pathname: "/home", params: { address: trimmed } });
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top + 60 }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Backgammon</Text>
        <Text style={styles.subtitle}>On-chain verifiable dice</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>XION Address</Text>
        <TextInput
          style={styles.input}
          placeholder="xion1..."
          placeholderTextColor="#555"
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={handleLogin}
        />

        <TouchableOpacity
          style={[styles.button, !address.trim() && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={!address.trim()}
        >
          <Text style={styles.buttonText}>Enter Lobby</Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          Enter your XION wallet address to connect to the game server.
          Wallet signing will be added in a future update.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    paddingHorizontal: 24,
  },
  header: {
    alignItems: "center",
    marginBottom: 48,
  },
  title: {
    fontSize: 36,
    fontWeight: "bold",
    color: Colors.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: Colors.textMuted,
  },
  form: {
    gap: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.surfaceLight,
  },
  button: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
  hint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
    marginTop: 8,
  },
});
