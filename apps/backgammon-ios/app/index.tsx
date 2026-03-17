import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  ScrollView,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/contexts/ThemeContext";
import { Theme } from "@/constants/themes";

const FEATURES = ["Verifiable Dice", "Real-time Multiplayer", "Provably Fair"];

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [address, setAddress] = useState("");
  const [inputFocused, setInputFocused] = useState(false);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  const handleLogin = () => {
    const trimmed = address.trim();
    if (!trimmed) return;
    router.replace({ pathname: "/home", params: { address: trimmed } });
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <View style={styles.logoContainer}>
          <Image
            source={require("@/assets/images/icon.png")}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        {/* Brand Name */}
        <Text style={styles.brandName}>Gammon</Text>

        {/* Tagline */}
        <Text style={styles.tagline}>
          The world's fairest backgammon platform
        </Text>

        {/* Feature Pills */}
        <View style={styles.pillsRow}>
          {FEATURES.map((feature) => (
            <View key={feature} style={styles.pill}>
              <Text style={styles.pillText}>{feature}</Text>
            </View>
          ))}
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.label}>XION ADDRESS</Text>
          <TextInput
            style={[
              styles.input,
              inputFocused && styles.inputFocused,
            ]}
            placeholder="xion1..."
            placeholderTextColor={colors.textFaint}
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={handleLogin}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />

          <TouchableOpacity
            style={[styles.button, !address.trim() && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={!address.trim()}
            activeOpacity={0.8}
          >
            <Text style={styles.buttonText}>Enter Lobby</Text>
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            By continuing, you agree to our{" "}
            <Text
              style={styles.footerLink}
              onPress={() => Linking.openURL("https://burnt.com/terms")}
            >
              Terms of Service
            </Text>
            {" and "}
            <Text
              style={styles.footerLink}
              onPress={() => Linking.openURL("https://burnt.com/privacy")}
            >
              Privacy Policy
            </Text>
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: Theme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    scrollContent: {
      flexGrow: 1,
      paddingHorizontal: 28,
      justifyContent: "center",
      paddingVertical: 40,
    },
    logoContainer: {
      alignItems: "center",
      marginBottom: 16,
    },
    logo: {
      width: 80,
      height: 80,
      borderRadius: 16,
    },
    brandName: {
      fontSize: 32,
      fontWeight: "700",
      color: colors.text,
      textAlign: "center",
      fontFamily: Platform.OS === "ios" ? "Georgia" : "serif",
      letterSpacing: 1,
      marginBottom: 8,
    },
    tagline: {
      fontSize: 15,
      color: colors.textSecondary,
      textAlign: "center",
      marginBottom: 28,
      lineHeight: 22,
    },
    pillsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 8,
      marginBottom: 36,
    },
    pill: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    pillText: {
      fontSize: 12,
      color: colors.textMuted,
      letterSpacing: 0.3,
    },
    form: {
      gap: 12,
      marginBottom: 40,
    },
    label: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textMuted,
      letterSpacing: 1.5,
      marginBottom: 2,
    },
    input: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      color: colors.text,
      borderWidth: 1,
      borderColor: colors.border,
    },
    inputFocused: {
      borderColor: colors.accent,
    },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      paddingHorizontal: 20,
      alignItems: "center",
      marginTop: 4,
    },
    buttonDisabled: {
      opacity: 0.4,
    },
    buttonText: {
      color: colors.accentFg,
      fontSize: 16,
      fontWeight: "600",
      letterSpacing: 0.3,
    },
    footer: {
      alignItems: "center",
      paddingHorizontal: 20,
    },
    footerText: {
      fontSize: 12,
      color: colors.textFaint,
      textAlign: "center",
      lineHeight: 18,
    },
    footerLink: {
      color: colors.textMuted,
      textDecorationLine: "underline",
    },
  });
}
