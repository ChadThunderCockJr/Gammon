import { useCallback } from "react";
import { useAbstraxionAccount } from "@burnt-labs/abstraxion";
import { authenticatedFetch, clearServerSession } from "@/lib/server-session";

export function useAuth() {
  const { data: account, isConnected, isConnecting, isInitializing, login, logout } = useAbstraxionAccount();
  const logoutEverywhere = useCallback(async () => {
    try {
      await authenticatedFetch("/api/session/logout", { method: "POST" });
    } catch {
      // Wallet logout must still proceed if the server session is already unavailable.
    } finally {
      clearServerSession();
    }
    await logout();
  }, [logout]);
  return {
    address: account?.bech32Address ?? null,
    isConnected,
    isConnecting: isInitializing || isConnecting,
    login,
    logout: logoutEverywhere,
  };
}
