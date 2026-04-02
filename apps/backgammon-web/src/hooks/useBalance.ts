import { useState, useCallback, useEffect } from "react";
import { useAuth } from "./useAuth";
import { API_BASE } from "@/lib/api";

/**
 * Hook to fetch and display the user's custodial balance.
 * Queries GET /api/balance/:address on the game server.
 */
export function useBalance() {
  const { address, isConnected } = useAuth();
  const [balance, setBalance] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!address || !isConnected) {
      setBalance(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/balance/${address}`);
      if (!res.ok) throw new Error("Failed to fetch balance");
      const data = await res.json();
      // Convert from raw units to display format (6 decimal places for USDC)
      const raw = BigInt(data.balance || "0");
      const whole = raw / 1_000_000n;
      const frac = raw % 1_000_000n;
      const formatted = `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
      setBalance(formatted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Balance fetch failed");
      setBalance(null);
    } finally {
      setIsLoading(false);
    }
  }, [address, isConnected]);

  // Fetch on mount and when address changes
  useEffect(() => {
    refetch();
  }, [refetch]);

  return { balance, isLoading, error, refetch };
}
