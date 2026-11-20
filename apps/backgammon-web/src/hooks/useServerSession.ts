"use client";

import { useAbstraxionAccount, useAbstraxionSigningClient } from "@burnt-labs/abstraxion";
import { useCallback, useEffect, useState } from "react";
import { clearServerSession, ensureServerSession, type ServerSession } from "@/lib/server-session";

export type SecureSessionState =
  | { readonly status: "disconnected" | "authorizing"; readonly session: null; readonly error: null }
  | { readonly status: "ready"; readonly session: ServerSession; readonly error: null }
  | { readonly status: "error"; readonly session: null; readonly error: string };

export function useServerSession(): SecureSessionState & { readonly retry: () => void } {
  const { data: account } = useAbstraxionAccount();
  const { client, signArb } = useAbstraxionSigningClient();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SecureSessionState>({
    status: account?.bech32Address ? "authorizing" : "disconnected",
    session: null,
    error: null,
  });

  useEffect(() => {
    const principal = account?.bech32Address;
    if (!principal || !client || !signArb) {
      setState({ status: principal ? "authorizing" : "disconnected", session: null, error: null });
      return;
    }
    let cancelled = false;
    setState({ status: "authorizing", session: null, error: null });
    void client.getGranteeAccountData()
      .then((signer) => {
        if (!signer) throw new Error("Wallet session key is unavailable");
        return ensureServerSession({
          principal,
          signer: signer.address,
          publicKey: signer.pubkey,
          sign: signArb,
        });
      })
      .then((session) => {
        if (!cancelled) setState({ status: "ready", session, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", session: null, error: "Wallet authorization could not be verified" });
      });
    return () => { cancelled = true; };
  }, [account?.bech32Address, attempt, client, signArb]);

  const retry = useCallback(() => {
    clearServerSession();
    setAttempt((value) => value + 1);
  }, []);

  return { ...state, retry };
}
