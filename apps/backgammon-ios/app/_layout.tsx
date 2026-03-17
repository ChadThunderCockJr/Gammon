import { DarkTheme, ThemeProvider } from "@react-navigation/native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ThemeProvider as AppThemeProvider, useTheme } from "../contexts/ThemeContext";

function RootLayoutInner() {
  const { colors } = useTheme();

  return (
    <ThemeProvider value={DarkTheme}>
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen
            name="home"
            options={{ headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen
            name="game/[id]"
            options={{ headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen
            name="verify-rolls"
            options={{
              title: "Verify Rolls",
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.text,
            }}
          />
        </Stack>
      </View>
      <StatusBar style="light" />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <AppThemeProvider>
          <RootLayoutInner />
        </AppThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1 },
});
