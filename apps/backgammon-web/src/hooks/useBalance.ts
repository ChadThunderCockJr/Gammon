import { useState, useCallback, useEffect, useRef } from "react";
import { useAuth } from "./useAuth";
import { API_BASE } from "@/lib/api";
import { USDC_DENOM } from "@/lib/config";

const XION_RPC = process.env.NEXT_PUBLIC_RPC || "https://rpc.xion-testnet-2.burnt.com:443";
const GAMMON_DENOM = process.env.NEXT_PUBLIC_GAMMON_DENOM || USDC_DENOM;

/**
 * Hook to fetch and display the user's balance.
 *
 * Queries the on-chain balance directly via XION RPC (so Brale deposits
 * show up immediately). Falls back to the server custodial balance API.
 * Returns "0.00" for connected users with no balance (not null).
 * Returns null only when the user is not connected.
 */
export function useBalance() {
  const { address, isConnected } = useAuth();
  const [balance, setBalance] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastAddress = useRef<string | null>(null);

  const formatBalance = (rawAmount: string): string => {
    const raw = BigInt(rawAmount || "0");
    const divisor = BigInt(1000000);
    const whole = raw / divisor;
    const frac = raw % divisor;
    return `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
  };

  const refetch = useCallback(async () => {
    if (!address || !isConnected) {
      setBalance(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Primary: query on-chain balance via XION RPC (catches Brale deposits)
      const rpcRes = await fetch(
        `${XION_RPC}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(GAMMON_DENOM)}`,
      );
      if (rpcRes.ok) {
        const data = await rpcRes.json();
        const amount = data?.balance?.amount || "0";
        setBalance(formatBalance(amount));
        return;
      }
    } catch {
      // RPC failed, fall through to server API
    }

    try {
      // Fallback: server custodial balance API
      const res = await fetch(`${API_BASE}/api/balance/${address}`);
      if (res.ok) {
        const data = await res.json();
        setBalance(formatBalance(data.balance || "0"));
        return;
      }
    } catch {
      // Both failed
    }

    setError("Could not fetch balance");
    setBalance("0.00");
    setIsLoading(false);
  }, [address, isConnected]);

  // Fetch when address changes
  useEffect(() => {
    if (address && isConnected && address !== lastAddress.current) {
      lastAddress.current = address;
      refetch();
    } else if (!address || !isConnected) {
      lastAddress.current = null;
      setBalance(null);
    }
  }, [address, isConnected, refetch]);

  // Poll every 30s while connected
  useEffect(() => {
    if (!address || !isConnected) return;
    const interval = setInterval(refetch, 30000);
    return () => clearInterval(interval);
  }, [address, isConnected, refetch]);

  return { balance, isLoading, error, refetch };
}
