import { API_BASE } from "./api";

export interface ServerSession {
  readonly principal: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

let activeSession: ServerSession | null = null;
let pendingSession: Promise<ServerSession> | null = null;
interface ActiveWalletSigner {
  readonly signer: string;
  readonly publicKey: Uint8Array;
  readonly sign: (signer: string, message: string) => Promise<string | Uint8Array>;
}
let activeWalletSigner: ActiveWalletSigner | null = null;
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}


function storedSession(principal: string): ServerSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem("gammon-server-session");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ServerSession;
    return value.principal === principal && Date.parse(value.expiresAt) > Date.now() + 30_000 ? value : null;
  } catch {
    return null;
  }
}

export function currentServerSession(): ServerSession | null {
  return activeSession;
}

export async function ensureServerSession(input: {
  readonly principal: string;
  readonly signer: string;
  readonly publicKey: Uint8Array;
  readonly sign: (signer: string, message: string) => Promise<string | Uint8Array>;
}): Promise<ServerSession> {
  activeWalletSigner = {
    signer: input.signer,
    publicKey: input.publicKey,
    sign: input.sign,
  };
  if (pendingSession) return pendingSession;
  pendingSession = (async () => {
    const existing = activeSession?.principal === input.principal ? activeSession : storedSession(input.principal);
    if (existing) {
      const check = await fetch(`${API_BASE}/api/session/current`, { credentials: "include" });
      const body = check.ok ? await check.json() as { principal?: unknown } : null;
      if (body?.principal === input.principal) {
        activeSession = existing;
        return existing;
      }
      activeSession = null;
      window.sessionStorage.removeItem("gammon-server-session");
    }
    const challengeResponse = await fetch(`${API_BASE}/api/session/challenge`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: input.principal, signer: input.signer }),
    });
    if (!challengeResponse.ok) throw new Error("Could not start a secure game session");
    const challenge = await challengeResponse.json() as { challengeToken?: unknown; message?: unknown };
    if (typeof challenge.challengeToken !== "string" || typeof challenge.message !== "string") {
      throw new Error("The session challenge was invalid");
    }
    const signed = await input.sign(input.signer, challenge.message);
    const signature = typeof signed === "string" ? signed : bytesToBase64(signed);
    const publicKey = bytesToBase64(input.publicKey);
    const verification = await fetch(`${API_BASE}/api/session/verify`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken: challenge.challengeToken, signature, publicKey }),
    });
    if (!verification.ok) throw new Error("Wallet authorization could not be verified");
    const session = await verification.json() as ServerSession;
    if (!session.csrfToken || session.principal !== input.principal) throw new Error("The session response was invalid");
    activeSession = session;
    window.sessionStorage.setItem("gammon-server-session", JSON.stringify(session));
    return session;
  })();
  try {
    return await pendingSession;
  } finally {
    pendingSession = null;
  }
}

export async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    const session = activeSession;
    if (!session) throw new Error("Secure session is not ready");
    headers.set("x-csrf-token", session.csrfToken);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
}
export type FinanceStepUpPurpose =
  | "enroll"
  | "link_token"
  | "link_bank"
  | "deposit"
  | "cash_out"
  | "cash_out_confirm";

export async function financeAuthorizedFetch(
  path: string,
  purpose: FinanceStepUpPurpose,
  init: RequestInit,
): Promise<Response> {
  const session = activeSession;
  const walletSigner = activeWalletSigner;
  if (!session || !walletSigner) throw new Error("Secure wallet authorization is not ready");
  if (typeof init.body !== "string") throw new TypeError("Finance request body must be JSON");
  const body = JSON.parse(init.body) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Finance request body must be an object");
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (!headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
  const idempotencyKey = headers.get("idempotency-key");
  if (!idempotencyKey) throw new Error("Finance idempotency key is unavailable");
  const binding = { body, idempotencyKey, path };
  const challengeResponse = await authenticatedFetch("/api/session/finance-step-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose, binding }),
  });
  if (!challengeResponse.ok) throw new Error("Finance authorization could not be started");
  const challenge = await challengeResponse.json() as { challengeToken?: unknown; message?: unknown };
  if (typeof challenge.challengeToken !== "string" || typeof challenge.message !== "string") {
    throw new Error("Finance authorization challenge was invalid");
  }
  const signed = await walletSigner.sign(walletSigner.signer, challenge.message);
  const signature = typeof signed === "string" ? signed : bytesToBase64(signed);
  const stepUp = {
    challengeToken: challenge.challengeToken,
    signature,
    publicKey: bytesToBase64(walletSigner.publicKey),
  };
  return authenticatedFetch(path, {
    ...init,
    headers,
    body: JSON.stringify({ ...(body as Record<string, unknown>), stepUp }),
  });
}


export function clearServerSession(): void {
  activeSession = null;
  pendingSession = null;
  activeWalletSigner = null;
  if (typeof window !== "undefined") window.sessionStorage.removeItem("gammon-server-session");
}
