import Constants from "expo-constants";

export const WS_URL =
  Constants.expoConfig?.extra?.wsUrl ??
  process.env.EXPO_PUBLIC_WS_URL ??
  "ws://localhost:3001/ws";

export const API_BASE = WS_URL.replace(/^ws(s?):/, "http$1:").replace(
  /\/ws$/,
  "",
);
