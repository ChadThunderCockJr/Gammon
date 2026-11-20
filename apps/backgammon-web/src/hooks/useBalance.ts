"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { authenticatedFetch } from "@/lib/server-session";
import { useAuth } from "./useAuth";
import { useServerSession } from "./useServerSession";

const WalletSchema = z.object({
  balance: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("fresh"),
      availableMicroUsd: z.string().regex(/^\d+$/),
      committedMicroUsd: z.string().regex(/^\d+$/),
      pendingMicroUsd: z.string().regex(/^\d+$/),
      observedAt: z.string().datetime(),
    }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
  ]),
});

export type BalanceState =
  | { readonly status: "disconnected" | "loading"; readonly available: null; readonly committed: null; readonly pending: null; readonly observedAt: null; readonly error: null }
  | { readonly status: "fresh" | "stale"; readonly available: string; readonly committed: string; readonly pending: string; readonly observedAt: string; readonly error: null }
  | { readonly status: "unavailable"; readonly available: null; readonly committed: null; readonly pending: null; readonly observedAt: null; readonly error: string };

function formatMicroUsd(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `$${whole}.${fraction}`;
}

export function useBalance(): BalanceState & { readonly balance: string | null; readonly isLoading: boolean; readonly refetch: () => Promise<void> } {
  const { address, isConnected } = useAuth();
  const secureSession = useServerSession();
  const [state, setState] = useState<BalanceState>({ status: "disconnected", available: null, committed: null, pending: null, observedAt: null, error: null });

  const refetch = useCallback(async () => {
    if (!address || !isConnected) {
      setState({ status: "disconnected", available: null, committed: null, pending: null, observedAt: null, error: null });
      return;
    }
    if (secureSession.status !== "ready") {
      setState({ status: "loading", available: null, committed: null, pending: null, observedAt: null, error: null });
      return;
    }
    setState((current) => current.status === "fresh"
      ? { ...current, status: "stale" }
      : { status: "loading", available: null, committed: null, pending: null, observedAt: null, error: null });
    try {
      const response = await authenticatedFetch("/api/funds/wallet");
      if (!response.ok) throw new Error("Wallet balance is unavailable");
      const wallet = WalletSchema.parse(await response.json());
      if (wallet.balance.status === "unavailable") throw new Error("Wallet balance is unavailable");
      setState({
        status: "fresh",
        available: formatMicroUsd(wallet.balance.availableMicroUsd),
        committed: formatMicroUsd(wallet.balance.committedMicroUsd),
        pending: formatMicroUsd(wallet.balance.pendingMicroUsd),
        observedAt: wallet.balance.observedAt,
        error: null,
      });
    } catch {
      setState({ status: "unavailable", available: null, committed: null, pending: null, observedAt: null, error: "Wallet balance is unavailable" });
    }
  }, [address, isConnected, secureSession.status]);

  useEffect(() => { void refetch(); }, [refetch]);
  useEffect(() => {
    if (!address || !isConnected || secureSession.status !== "ready") return;
    const interval = window.setInterval(() => { void refetch(); }, 30_000);
    return () => window.clearInterval(interval);
  }, [address, isConnected, refetch, secureSession.status]);

  return { ...state, balance: state.available, isLoading: state.status === "loading", refetch };
}
