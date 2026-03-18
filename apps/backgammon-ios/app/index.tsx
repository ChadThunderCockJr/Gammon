import { useRef, useEffect } from "react";
import { StyleSheet, BackHandler, Platform } from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaView } from "react-native-safe-area-context";

const GAMMON_URL = "https://gammon.nyc";

// Safari-like user agent so OAuth providers (Google, Apple) don't block us.
// "GammonApp" tag lets the web app detect it's running inside the native shell.
const APP_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 GammonApp/1.0";

export default function App() {
  const webviewRef = useRef<WebView>(null);

  // Handle Android back button
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      webviewRef.current?.goBack();
      return true;
    });
    return () => handler.remove();
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <WebView
        ref={webviewRef}
        source={{ uri: GAMMON_URL }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsBackForwardNavigationGestures
        sharedCookiesEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        userAgent={APP_USER_AGENT}
        javaScriptCanOpenWindowsAutomatically
        thirdPartyCookiesEnabled
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0E08",
  },
  webview: {
    flex: 1,
  },
});
