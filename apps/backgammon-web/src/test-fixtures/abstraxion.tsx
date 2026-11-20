"use client";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromBase64, toBase64, toUtf8 } from "@cosmjs/encoding";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { API_BASE } from "@/lib/api";

type FixtureWalletName = "alice" | "bob";

type FixtureWallet = {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
};

const wallets: Record<FixtureWalletName, FixtureWallet> = {
  alice: {
    address: "xion1s76af50mxrhccpz4cmw7ucus2xe40qkrq7q44j",
    publicKey: fromBase64("A9eTYxr3qg5wlDndR/wAGs0LBydnC2Zw6lKKyDywEn9K"),
    privateKey: new Uint8Array(32).fill(0x15),
  },
  bob: {
    address: "xion1dap3mkhdep3lhp3fkl27u70kx0063mp04zue58",
    publicKey: fromBase64("Aqg5epNfDfzrprqWGPZFHvTYBjer9OavJmn7yd5qj9Ks"),
    privateKey: new Uint8Array(32).fill(0x16),
  },
};

const selectionStorageKey = "gammon.sandbox.wallet";
const selectionEvent = "gammon:sandbox-wallet-selected";

function selectedWalletName(): FixtureWalletName {
  if (typeof window === "undefined") return "alice";
  const querySelection = new URLSearchParams(window.location.search).get("sandboxWallet");
  if (querySelection === "alice" || querySelection === "bob") return querySelection;
  const storedSelection = window.localStorage.getItem(selectionStorageKey);
  return storedSelection === "bob" ? "bob" : "alice";
}

function selectWallet(name: FixtureWalletName): void {
  window.localStorage.setItem(selectionStorageKey, name);
  const url = new URL(window.location.href);
  url.searchParams.set("sandboxWallet", name);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(selectionEvent));
}

declare global {
  interface Window {
    __gammonSandboxWallet?: {
      readonly principals: Readonly<Record<FixtureWalletName, string>>;
      current(): FixtureWalletName;
      select(name: FixtureWalletName): void;
    };
  }
}

type SigningClient = {
  getGranteeAccountData(): Promise<{ address: string; pubkey: Uint8Array }>;
  execute(
    sender: string,
    contract: string,
    msg: Record<string, unknown>,
    gas: string,
    memo?: string,
    funds?: readonly { denom: string; amount: string }[],
  ): Promise<{ transactionHash: string; code: number; events: unknown[] }>;
};

type FixtureContextValue = {
  readonly connected: boolean;
  readonly initializing: boolean;
  readonly wallet: FixtureWallet;
  login(): Promise<void>;
  logout(): Promise<void>;
};

const FixtureContext = createContext<FixtureContextValue | null>(null);

function useFixture(): FixtureContextValue {
  const value = useContext(FixtureContext);
  if (!value) throw new Error("AbstraxionProvider is required");
  return value;
}

async function signAdr36(wallet: FixtureWallet, signer: string, message: string | Uint8Array): Promise<string> {
  if (signer !== wallet.address) throw new Error("Sandbox signer does not match the selected wallet");
  const messageBytes = typeof message === "string" ? toUtf8(message) : message;
  const signDoc = {
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [{ type: "sign/MsgSignData", value: { data: toBase64(messageBytes), signer } }],
    sequence: "0",
  };
  return toBase64(secp256k1.sign(toUtf8(JSON.stringify(signDoc)), wallet.privateKey));
}

function signingClient(wallet: FixtureWallet): SigningClient {
  return {
    async getGranteeAccountData() {
      return { address: wallet.address, pubkey: wallet.publicKey };
    },
    async execute(sender, contract, msg, _gas, _memo, funds = []) {
      if (sender !== wallet.address) throw new Error("Sandbox sender does not match the selected wallet");
      const response = await fetch(`${API_BASE}/__sandbox/chain/execute`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, contract, msg, funds }),
      });
      if (!response.ok) throw new Error("Sandbox chain execution failed");
      const result = await response.json() as { transactionHash?: unknown; code?: unknown; events?: unknown };
      if (typeof result.transactionHash !== "string" || !/^[0-9a-f]{64}$/i.test(result.transactionHash)) {
        throw new Error("Sandbox chain returned an invalid transaction hash");
      }
      return {
        transactionHash: result.transactionHash,
        code: typeof result.code === "number" ? result.code : 0,
        events: Array.isArray(result.events) ? result.events : [],
      };
    },
  };
}

export function AbstraxionProvider({ children }: { children: ReactNode; config: unknown }) {
  const [name, setName] = useState<FixtureWalletName | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const syncSelection = () => {
      const selected = selectedWalletName();
      window.localStorage.setItem(selectionStorageKey, selected);
      setName(selected);
      setConnected(true);
    };
    syncSelection();
    window.__gammonSandboxWallet = {
      principals: { alice: wallets.alice.address, bob: wallets.bob.address },
      current: selectedWalletName,
      select: selectWallet,
    };
    window.addEventListener(selectionEvent, syncSelection);
    window.addEventListener("popstate", syncSelection);
    return () => {
      window.removeEventListener(selectionEvent, syncSelection);
      window.removeEventListener("popstate", syncSelection);
      delete window.__gammonSandboxWallet;
    };
  }, []);

  const login = useCallback(async () => { setConnected(true); }, []);
  const logout = useCallback(async () => { setConnected(false); }, []);
  const value = useMemo(() => ({
    connected: connected && name !== null, initializing: name === null,
    wallet: wallets[name ?? "alice"], login, logout,
  }), [connected, login, logout, name]);

  return <FixtureContext.Provider value={value}>{children}</FixtureContext.Provider>;
}

export function useAbstraxionAccount() {
  const { connected, initializing, wallet, login, logout } = useFixture();
  return {
    data: initializing ? undefined : { bech32Address: wallet.address },
    isConnected: connected,
    isConnecting: false,
    isInitializing: initializing,
    isLoading: false,
    isReturningFromAuth: false,
    isLoggingIn: false,
    isError: false,
    error: "",
    login,
    logout,
  };
}

export function useAbstraxionSigningClient() {
  const { connected, wallet } = useFixture();
  const client = useMemo(() => connected ? signingClient(wallet) : undefined, [connected, wallet]);
  const signArb = useCallback(
    async (signer: string, message: string | Uint8Array) => signAdr36(wallet, signer, message),
    [wallet],
  );
  return { client, signArb: connected ? signArb : undefined, rpcUrl: API_BASE };
}

export function useAbstraxionClient() {
  return { client: undefined, error: undefined };
}


