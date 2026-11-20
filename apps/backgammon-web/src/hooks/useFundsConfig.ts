"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { API_BASE } from "@/lib/api";

const FundsConfigSchema = z.object({
  mode: z.enum(["free", "verusd_testnet", "verusd_production"]),
  testFunds: z.boolean(),
  entryEnabled: z.boolean(),
  recoveryEnabled: z.boolean(),
  depositEnabled: z.boolean(),
  cashOutEnabled: z.boolean(),
  wagerEnabled: z.boolean(),
  settlementEnabled: z.boolean(),
  asset: z.object({ symbol: z.literal("verUSD"), decimals: z.literal(6) }).nullable(),
  legalVersions: z.object({
    terms: z.string().nullable(),
    privacy: z.string().nullable(),
    braleEndUserTerms: z.string().nullable(),
    achAuthorization: z.string().nullable(),
    responsiblePlay: z.string().nullable(),
  }),
  legalDocuments: z.object({
    braleEua: z.object({ url: z.string().url(), version: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
    plaidPrivacy: z.object({ url: z.string().url(), version: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
    achAuthorization: z.object({ url: z.string().url(), version: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).nullable(),
  }).nullable(),
  responsiblePlayHelp: z.object({
    name: z.string().min(1).max(100),
    url: z.string().url(),
    version: z.string().min(1).max(100),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    expiresAt: z.string().datetime(),
  }).nullable(),
  attestedAt: z.string().datetime().nullable(),
  blockers: z.array(z.string()),
  actionBlockers: z.object({
    deposit: z.array(z.string()),
    cash_out: z.array(z.string()),
    wager: z.array(z.string()),
    settle: z.array(z.string()),
    refund: z.array(z.string()),
    history: z.array(z.string()),
  }),
});

export type FundsConfig = z.infer<typeof FundsConfigSchema>;
export type FundsConfigState =
  | { readonly status: "loading"; readonly config: null; readonly error: null }
  | { readonly status: "ready"; readonly config: FundsConfig; readonly error: null }
  | { readonly status: "unavailable"; readonly config: null; readonly error: string };

export function useFundsConfig(): FundsConfigState & { readonly refresh: () => void } {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<FundsConfigState>({ status: "loading", config: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", config: null, error: null });
    void fetch(`${API_BASE}/api/funds/config`, { signal: controller.signal, credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Money configuration is unavailable");
        return FundsConfigSchema.parse(await response.json());
      })
      .then((config) => setState({ status: "ready", config, error: null }))
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ status: "unavailable", config: null, error: "Money configuration is unavailable" });
      });
    return () => controller.abort();
  }, [version]);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return { ...state, refresh };
}
