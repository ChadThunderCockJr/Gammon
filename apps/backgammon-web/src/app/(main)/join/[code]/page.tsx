"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAbstraxionSigningClient } from "@burnt-labs/abstraxion";
import { z } from "zod";
import Link from "next/link";
import { useFundsConfig } from "@/hooks/useFundsConfig";
import { useAuth } from "@/hooks/useAuth";
import { useGame } from "@/hooks/useGame";
import { useServerSession } from "@/hooks/useServerSession";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";
import { authenticatedFetch } from "@/lib/server-session";
import { API_BASE } from "@/lib/api";
import { VERUSD_DENOM, VERUSD_ESCROW_CONTRACT } from "@/lib/config";
import { WS_URL } from "@/lib/ws-config";
import { withReturnTo } from "@/lib/return-to";
import { safeMoneyFailure } from "../../cash-action-safety";
import { CashQuoteDisclosure } from "../../cash-quote-disclosure";
const QuoteSchema = z.object({
  id: z.string().uuid(), gameId: z.string().uuid(), quoteHash: z.string().regex(/^[a-f0-9]{64}$/), playerA: z.string(), playerB: z.string(),
  stakeMicroUsd: z.string(), reservePerPlayerMicroUsd: z.string(), rakeBps: z.number(), cubeCap: z.literal(8),
  state: z.enum(["offered", "accepted", "reserving", "active", "settlement_pending", "settled", "refunded", "review", "expired"]), expiresAt: z.string().datetime(), fundingDeadline: z.string().datetime().nullable(),
  fundsMode: z.enum(["free", "verusd_testnet", "verusd_production", "legacy_unverified"]), testFunds: z.boolean(),
  asset: z.object({ denom: z.string(), decimals: z.number(), symbol: z.string(), displayDenomination: z.string() }),
  termsSnapshot: z.record(z.string(), z.unknown()), legalSnapshot: z.record(z.string(), z.unknown()),
}).passthrough();
type Quote = z.infer<typeof QuoteSchema>;
const ConfigSchema = z.object({ testFunds: z.boolean(), wagerEnabled: z.boolean(), cashTermsVersion: z.string().nullable(), responsiblePlayVersion: z.string().nullable() });
const TxResultSchema = z.object({ transactionHash: z.string().regex(/^[0-9a-fA-F]{64}$/) }).passthrough();
const browserSandboxRefundRecovery = process.env.NEXT_PUBLIC_E2E_SANDBOX === "1" && process.env.NODE_ENV === "development";

function display(micro: string): string { const number = BigInt(micro); return `${number / 1_000_000n}.${(number % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`; }
function headers(): HeadersInit { return { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }; }
function readable(error: unknown): string { console.error("Cash-game action failed", error); return safeMoneyFailure("wager"); }
function sessionMoneyGateMessage(status: "disconnected" | "authorizing" | "error" | "ready", error: string | null): string {
  if (status === "error") return `${error ?? "Wallet authorization could not be verified"}. Retry authorization or change wallets before taking a money action. No funds will be reserved.`;
  if (status === "authorizing") return "Wallet authorization is in progress. No funds will be reserved until it finishes.";
  if (status === "disconnected") return "Connect a wallet and authorize its secure session before taking a money action. No funds will be reserved.";
  return safeMoneyFailure("wager");
}

function parseInviteCode(value: string): { kind: "free" | "cash"; id: string } | null {
  const match = /^(free|cash)_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);
  return match ? { kind: match[1].toLowerCase() as "free" | "cash", id: match[2] } : null;
}

export default function JoinCodePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const { address, logout } = useAuth();
  const funds = useFundsConfig();
  const session = useServerSession();
  const isNativeApp = useIsNativeApp();
  const { client } = useAbstraxionSigningClient();
  const [quote, setQuote] = useState<Quote | null>(null);
  const game = useGame(WS_URL, address, quote?.gameId);
  const [config, setConfig] = useState<z.infer<typeof ConfigSchema> | null>(null);
  const [wagerAccepted, setWagerAccepted] = useState(false);
  const [reserveAccepted, setReserveAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const invite = parseInviteCode(params.code);
  const code = invite?.id ?? "";
  const cashCode = invite?.kind === "cash";
  const moneyAvailable = funds.status === "ready" && funds.config.entryEnabled && Boolean(funds.config.attestedAt) && funds.config.wagerEnabled && funds.config.actionBlockers.wager.length === 0 && funds.config.legalVersions.responsiblePlay !== null && session.status === "ready";
  const recipientWalletMatches = Boolean(address && quote && address === quote.playerB);
  const sessionGateMessage = sessionMoneyGateMessage(session.status, session.error);
  const changeWallet = useCallback(async () => {
    await logout();
    window.location.replace(withReturnTo("/login", `/join/${encodeURIComponent(params.code)}`));
  }, [logout, params.code]);

  const refreshQuote = useCallback(async () => {
    const response = await authenticatedFetch(`/api/cash-games/quotes/${code}`);
    if (!response.ok) throw new Error("Cash-game offer was not found, expired, or is not addressed to this wallet.");
    setQuote(z.object({ quote: QuoteSchema }).parse(await response.json()).quote);
  }, [code]);

  useEffect(() => {
    if (isNativeApp || !cashCode || session.status !== "ready") return;
    void Promise.all([
      refreshQuote(),
      fetch(`${API_BASE}/api/cash-games/config`, { credentials: "include" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Cash-game rules are unavailable");
          return ConfigSchema.parse(await response.json());
        }),
    ]).then(([, nextConfig]) => setConfig(nextConfig)).catch((reason: unknown) => setError(readable(reason)));
  }, [cashCode, isNativeApp, refreshQuote, session.status]);
  useEffect(() => {
    if (!quote || (quote.state !== "accepted" && quote.state !== "reserving")) return;
    const interval = window.setInterval(() => {
      void refreshQuote().catch((reason: unknown) => setError(readable(reason)));
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [quote?.id, quote?.state, refreshQuote]);
  useEffect(() => { setWagerAccepted(false); setReserveAccepted(false); }, [quote?.id, quote?.quoteHash]);


  useEffect(() => {
    if (invite?.kind === "free" && game.authenticated) game.joinGame(code);
  }, [code, game.authenticated, game.joinGame, invite?.kind]);

  useEffect(() => {
    if (game.status === "playing" && game.gameId) {
      router.push(`/match/${game.gameId}${quote ? `?cashQuote=${quote.id}` : ""}`);
    }
  }, [game.gameId, game.status, quote?.id, router]);

  const acceptQuote = useCallback(async () => {
    if (session.status !== "ready") { setError(sessionGateMessage); return; }
    if (!quote) { setError("This cash-game action is unavailable until required legal, provider, eligibility, and operational approvals are active."); return; }
    if (!address || address !== quote.playerB) { setError(`Only the intended recipient can accept this offer. Connect wallet ${quote.playerB} to continue.`); return; }
    if (isNativeApp || !moneyAvailable || !config?.wagerEnabled || !config.cashTermsVersion || !config.responsiblePlayVersion || !wagerAccepted) { setError("This cash-game action is unavailable until required legal, provider, eligibility, and operational approvals are active."); return; }
    setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch(`/api/cash-games/quotes/${quote.id}/accept`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          quoteHash: quote.quoteHash,
          consent: {
            acceptedAt: new Date().toISOString(),
            cashTermsVersion: config.cashTermsVersion,
            responsiblePlayVersion: config.responsiblePlayVersion,
            maximumLossAcknowledged: true,
            testFundsAcknowledged: config.testFunds,
          },
        }),
      });
      if (!response.ok) throw new Error("quote acceptance rejected");
      setWagerAccepted(false);
      await refreshQuote();
    } catch (reason) { setError(readable(reason)); }
    finally { setBusy(false); }
  }, [address, config, isNativeApp, moneyAvailable, quote, refreshQuote, session.status, sessionGateMessage, wagerAccepted]);

  const reserve = useCallback(async () => {
    if (session.status !== "ready") { setError(sessionGateMessage); return; }
    if (isNativeApp || !moneyAvailable || !quote || !reserveAccepted || !address || !client || !VERUSD_DENOM || !VERUSD_ESCROW_CONTRACT) { setError("This cash-game action is unavailable until required approvals are active. No transaction was sent."); return; }
    setBusy(true); setError(null);
    try {
      const result = TxResultSchema.parse(await client.execute(address, VERUSD_ESCROW_CONTRACT, { deposit_reserve: { game_id: quote.gameId } }, "auto", undefined, [{ denom: VERUSD_DENOM, amount: quote.reservePerPlayerMicroUsd }]));
      const response = await authenticatedFetch(`/api/cash-games/quotes/${quote.id}/reserve-confirmation`, { method: "POST", headers: headers(), body: JSON.stringify({ txHash: result.transactionHash }) });
      if (!response.ok) throw new Error("reserve confirmation rejected");
      setReserveAccepted(false);
      await refreshQuote();
    } catch (reason) { setError(readable(reason)); }
    finally { setBusy(false); }
  }, [address, client, isNativeApp, moneyAvailable, quote, refreshQuote, reserveAccepted, session.status, sessionGateMessage]);

  const recoverSandboxRefund = useCallback(async () => {
    if (!quote) return;
    setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch(`/__sandbox/cash-games/quotes/${quote.id}/refund-recovery`, {
        method: "POST",
        headers: headers(),
      });
      if (!response.ok) throw new Error("sandbox refund recovery rejected");
      const nextQuote = z.object({ quote: QuoteSchema }).parse(await response.json()).quote;
      setQuote(nextQuote);
      setNotice(nextQuote.state === "refunded"
        ? "Sandbox refund completed. The durable receipt now records the refund."
        : "Sandbox refund recovery is queued. The durable receipt will refresh when the worker completes it.");
    } catch (reason) { setError(readable(reason)); }
    finally { setBusy(false); }
  }, [quote]);


  if (!invite) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
        <h1 className="font-display text-3xl">Invalid invite</h1>
        <p>This link does not identify a typed free or cash-game invite.</p>
      </main>
    );
  }

  if (!cashCode) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
        <h1 className="font-display text-3xl">Join free match</h1>
        {game.error ? <p role="alert">{game.error}</p> : <p>{game.authenticated ? "Joining the free match…" : "Connect your wallet and authorize the secure session to join."}</p>}
      </main>
    );
  }
  if (isNativeApp) {
    return (
      <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
        <h1 className="font-display text-3xl">Cash games are unavailable in the app</h1>
        <p>The native app supports free play only. This cash-game link did not reserve funds or join a game.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-xl space-y-5 p-4 sm:p-6" aria-live="polite">
      <h1 className="font-display text-3xl">Review cash-game offer</h1>
      {error && <p role="alert" className="rounded border border-red-700/40 p-3 text-sm">{error}</p>}
      {notice && <p role="status" className="rounded border border-emerald-700/40 p-3 text-sm">{notice}</p>}
      {session.status !== "ready" ? (
        <section className="space-y-3 rounded border border-[var(--color-warning)] p-3 text-sm">
          <p role={session.status === "error" ? "alert" : "status"}>{sessionGateMessage}</p>
          {session.status === "error" && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary min-h-11" onClick={session.retry}>Retry authorization</button>
              <button type="button" className="min-h-11 rounded border px-4 py-2" onClick={() => void changeWallet()}>Change wallet</button>
            </div>
          )}
        </section>
      ) : !quote ? (
        <p>Loading the private offer for this wallet…</p>
      ) : (
        <section className="space-y-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
          {config?.testFunds && <p role="status" className="rounded border border-[var(--color-warning)] p-3 text-sm font-semibold">TEST FUNDS ONLY — this quote, reserve, and receipt have no cash value and cannot be withdrawn as real money.</p>}
          <dl className="grid gap-2 text-sm">
            <div><dt className="inline text-[var(--color-text-muted)]">Offer from (opponent): </dt><dd className="inline break-all font-mono">{quote.playerA}</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Recipient (you): </dt><dd className="inline break-all font-mono">{quote.playerB}</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Connected wallet: </dt><dd className="inline break-all font-mono">{address ?? "No wallet connected"}</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Stake per point: </dt><dd className="inline font-mono">${display(quote.stakeMicroUsd)} in verUSD</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Maximum reserve: </dt><dd className="inline font-mono">${display(quote.reservePerPlayerMicroUsd)} in verUSD</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Cube cap: </dt><dd className="inline">×{quote.cubeCap}</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Rake: </dt><dd className="inline">{quote.rakeBps / 100}%</dd></div>
            <div><dt className="inline text-[var(--color-text-muted)]">Expires: </dt><dd className="inline">{new Date(quote.expiresAt).toLocaleString()}</dd></div>
          </dl>
          <p className="text-sm font-semibold">Custody: the Xion {quote.asset.symbol} escrow contract holds verified reserves until settlement or refund. {quote.testFunds ? "Test funds — no cash value" : "Production verUSD"}.</p>
          <CashQuoteDisclosure quote={quote} />
          {!recipientWalletMatches && <p role="alert" className="rounded border border-red-700/40 p-3 text-sm">Only Recipient (you), wallet {quote.playerB}, can accept this offer. {address ? `Connected wallet ${address} does not match.` : "Connect the recipient wallet to continue."}</p>}
          {!moneyAvailable && <p role="alert" className="rounded border border-[var(--color-warning)] p-3 text-sm">This cash-game action is unavailable until its required legal documents, provider integrations, eligibility controls, and operational approvals are active. No funds will be reserved.</p>}
          {(quote.state === "offered" || quote.state === "accepted") && (
            <>
              <label className="flex items-start gap-3 text-sm">
                <input className="mt-1 h-5 w-5" type="checkbox" checked={wagerAccepted} onChange={(event) => setWagerAccepted(event.target.checked)} />
                <span>I, Recipient (you) ({quote.playerB}), accept this exact wager from Offer from (opponent) ({quote.playerA}): ${display(quote.stakeMicroUsd)} per point, maximum reserve ${display(quote.reservePerPlayerMicroUsd)}, cube cap ×{quote.cubeCap}, {quote.rakeBps / 100}% rake, and quote {quote.quoteHash}. I reviewed the <Link className="underline" href="/terms">Terms</Link>, <Link className="underline" href="/privacy">Privacy Notice</Link>, and <Link className="underline" href="/responsible-play">Responsible Play</Link> policy. {quote.testFunds ? "Test funds — no cash value" : "Production verUSD"}.</span>
              </label>
              <button disabled={!moneyAvailable || !recipientWalletMatches || !wagerAccepted || busy || !config?.wagerEnabled} onClick={() => void acceptQuote()} className="btn-primary min-h-11 disabled:opacity-50">Accept this exact wager</button>
            </>
          )}
          {quote.state === "reserving" && quote.fundingDeadline !== null && (
            <>
              <label className="flex items-start gap-3 text-sm">
                <input className="mt-1 h-5 w-5" type="checkbox" checked={reserveAccepted} onChange={(event) => setReserveAccepted(event.target.checked)} />
                <span>I confirm sending exactly ${display(quote.reservePerPlayerMicroUsd)} {quote.asset.symbol} ({quote.testFunds ? "Test funds — no cash value" : "production funds"}) from my wallet to the Xion escrow contract for quote {quote.quoteHash}. This transfer is not reversible.</span>
              </label>
              <button disabled={!moneyAvailable || busy || !reserveAccepted} onClick={() => void reserve()} className="btn-primary min-h-11 disabled:opacity-50">Reserve ${display(quote.reservePerPlayerMicroUsd)} in {quote.asset.symbol}</button>
            </>
          )}
          {quote.state === "active" && <button onClick={() => router.push(`/match/${quote.gameId}?cashQuote=${quote.id}`)} className="btn-primary min-h-11">Review funded start</button>}
          {browserSandboxRefundRecovery && (quote.state === "active" || quote.state === "review") && (
            <section className="mt-3 space-y-2 rounded border border-[var(--color-warning)] p-3 text-sm">
              <p>Development sandbox only: queue the normal cash-game refund recovery flow.</p>
              <button disabled={busy} onClick={() => void recoverSandboxRefund()} className="min-h-11 rounded border px-4 py-2 disabled:opacity-50">Recover sandbox refund</button>
            </section>
          )}
          {["settlement_pending", "settled", "refunded", "review", "expired"].includes(quote.state) && (
            <p className="text-sm">This offer is no longer available to join as an active cash game.</p>
          )}
        </section>
      )}
    </main>
  );
}
