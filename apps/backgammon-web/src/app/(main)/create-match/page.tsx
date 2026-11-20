"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAbstraxionSigningClient } from "@burnt-labs/abstraxion";
import { z } from "zod";
import { useAuth } from "@/hooks/useAuth";
import { useFundsConfig } from "@/hooks/useFundsConfig";
import { useGame } from "@/hooks/useGame";
import { useServerSession } from "@/hooks/useServerSession";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";
import { API_BASE } from "@/lib/api";
import { authenticatedFetch } from "@/lib/server-session";
import { VERUSD_DENOM, VERUSD_ESCROW_CONTRACT } from "@/lib/config";
import { WS_URL } from "@/lib/ws-config";
import { withReturnTo } from "@/lib/return-to";
import { safeMoneyFailure, unavailableMoneyMessage, usdCentsError, xionAddressError } from "../cash-action-safety";
import { CashQuoteDisclosure } from "../cash-quote-disclosure";
const QuoteSchema = z.object({
  id: z.string().uuid(), gameId: z.string().uuid(), quoteHash: z.string().regex(/^[a-f0-9]{64}$/), playerA: z.string(), playerB: z.string(),
  stakeMicroUsd: z.string().regex(/^\d+$/), reservePerPlayerMicroUsd: z.string().regex(/^\d+$/), rakeBps: z.number(), cubeCap: z.literal(8),
  rules: z.record(z.string(), z.unknown()), state: z.enum(["offered", "accepted", "reserving", "active", "settlement_pending", "settled", "refunded", "review", "expired"]), expiresAt: z.string().datetime(), fundingDeadline: z.string().datetime().nullable(), version: z.number(),
  fundsMode: z.enum(["free", "verusd_testnet", "verusd_production", "legacy_unverified"]), testFunds: z.boolean(),
  asset: z.object({ denom: z.string(), decimals: z.number(), symbol: z.string(), displayDenomination: z.string() }),
  termsSnapshot: z.record(z.string(), z.unknown()), legalSnapshot: z.record(z.string(), z.unknown()),
});
type Quote = z.infer<typeof QuoteSchema>;
const CashConfigSchema = z.object({
  wagerEnabled: z.boolean(), testFunds: z.boolean(), cashTermsVersion: z.string().nullable(), responsiblePlayVersion: z.string().nullable(), actionBlockers: z.object({ wager: z.array(z.string()) }),
});
const TxResultSchema = z.object({ transactionHash: z.string().regex(/^[0-9a-fA-F]{64}$/) }).passthrough();
const browserSandboxRefundRecovery = process.env.NEXT_PUBLIC_E2E_SANDBOX === "1" && process.env.NODE_ENV === "development";

function idempotencyHeaders(): HeadersInit { return { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }; }
function toDisplay(micro: string): string { const value = BigInt(micro); return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`; }
function message(error: unknown): string { console.error("Cash-game action failed", error); return safeMoneyFailure("wager"); }
function sessionMoneyGateMessage(status: "disconnected" | "authorizing" | "error" | "ready", error: string | null): string {
  if (status === "error") return `${error ?? "Wallet authorization could not be verified"}. Retry authorization or change wallets before taking a money action. No funds will be reserved.`;
  if (status === "authorizing") return "Wallet authorization is in progress. No funds will be reserved until it finishes.";
  if (status === "disconnected") return "Connect a wallet and authorize its secure session before taking a money action. No funds will be reserved.";
  return unavailableMoneyMessage();
}

export default function CreateMatchPage() {
  const router = useRouter();
  const { address, isConnected, logout } = useAuth();
  const session = useServerSession();
  const funds = useFundsConfig();
  const isNativeApp = useIsNativeApp();
  const { client } = useAbstraxionSigningClient();
  const [quote, setQuote] = useState<Quote | null>(null);
  const game = useGame(WS_URL, address, quote?.gameId);
  const [matchLength, setMatchLength] = useState(1);
  const [timeControl, setTimeControl] = useState(10);
  const [cashConfig, setCashConfig] = useState<z.infer<typeof CashConfigSchema> | null>(null);
  const [opponent, setOpponent] = useState("");
  const [stake, setStake] = useState("");
  const [wagerAccepted, setWagerAccepted] = useState(false);
  const [reserveAccepted, setReserveAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opponentInput = useRef<HTMLInputElement>(null);
  const stakeInput = useRef<HTMLInputElement>(null);
  const sessionGateMessage = sessionMoneyGateMessage(session.status, session.error);
  const cashAvailable = !isNativeApp && funds.status === "ready" && funds.config.entryEnabled && Boolean(funds.config.attestedAt) && funds.config.actionBlockers.wager.length === 0 && funds.config.legalVersions.responsiblePlay !== null && funds.config.wagerEnabled && cashConfig?.wagerEnabled && cashConfig?.actionBlockers.wager.length === 0 && session.status === "ready";
  useEffect(() => {
    if (isNativeApp || funds.status !== "ready" || !funds.config.wagerEnabled) return;
    let active = true;
    void fetch(`${API_BASE}/api/cash-games/config`, { credentials: "include" })
      .then(async (response) => { if (!response.ok) throw new Error("Cash-game rules are unavailable"); return CashConfigSchema.parse(await response.json()); })
      .then((config) => { if (active) setCashConfig(config); })
      .catch((reason: unknown) => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [funds.config?.wagerEnabled, funds.status, isNativeApp]);

  useEffect(() => {
    if (game.status === "playing" && game.gameId) {
      router.push(`/match/${game.gameId}${quote ? `?cashQuote=${quote.id}` : ""}`);
    }
  }, [game.gameId, game.status, quote?.id, router]);
  useEffect(() => {
    if (!quote || (quote.state !== "accepted" && quote.state !== "reserving")) return;
    const interval = window.setInterval(() => {
      void authenticatedFetch(`/api/cash-games/quotes/${quote.id}`)
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not refresh the cash-game offer");
          return z.object({ quote: QuoteSchema }).parse(await response.json()).quote;
        })
        .then(setQuote)
        .catch((reason: unknown) => setError(message(reason)));
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [quote?.id, quote?.state]);
  useEffect(() => { setWagerAccepted(false); setReserveAccepted(false); }, [quote?.id, quote?.quoteHash]);

  const createFreeMatch = useCallback(() => {
    setError(null);
    if (!game.authenticated) { setError("Connect your wallet and complete the secure session before creating a match."); return; }
    game.createGame(matchLength, timeControl * 60);
    setNotice("Free match created. Share the invite link once it appears.");
  }, [game, matchLength, timeControl]);

  const createQuote = useCallback(async () => {
    const opponentError = xionAddressError(opponent, address);
    const stakeError = usdCentsError(stake) ?? (BigInt(stake.replace(".", "")) > 100_000n ? "The maximum stake is $1,000.00 per point." : null);
    if (session.status !== "ready") { setError(sessionGateMessage); return; }
    if (isNativeApp || !cashConfig?.wagerEnabled) { setError(unavailableMoneyMessage()); return; }
    if (opponentError) { setError(opponentError); opponentInput.current?.focus(); return; }
    if (stakeError) { setError(stakeError); stakeInput.current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch("/api/cash-games/quotes", { method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({ opponent: opponent.trim(), stakeUsd: stake }) });
      if (!response.ok) throw new Error("cash-game quote rejected");
      const payload = z.object({ quote: QuoteSchema }).parse(await response.json());
      setQuote(payload.quote);
      setNotice("Offer created. Review the exact terms and share the private acceptance link with the named opponent.");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }, [address, cashConfig?.wagerEnabled, isNativeApp, opponent, session.status, sessionGateMessage, stake]);

  const acceptOwnQuote = useCallback(async () => {
    if (session.status !== "ready") { setError(sessionGateMessage); return; }
    if (!quote || !cashConfig?.cashTermsVersion || !cashConfig.responsiblePlayVersion || !wagerAccepted) { setError("Review this exact offer and accept its wager disclosures before continuing."); return; }
    setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch(`/api/cash-games/quotes/${quote.id}/accept`, {
        method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({
          quoteHash: quote.quoteHash,
          consent: {
            acceptedAt: new Date().toISOString(),
            cashTermsVersion: cashConfig.cashTermsVersion,
            responsiblePlayVersion: cashConfig.responsiblePlayVersion,
            maximumLossAcknowledged: true,
            testFundsAcknowledged: cashConfig.testFunds,
          },
        }),
      });
      if (!response.ok) throw new Error("quote acceptance rejected");
      setQuote(z.object({ quote: QuoteSchema }).parse(await response.json()).quote);
      setWagerAccepted(false);
      setNotice("Your acceptance is recorded. The opponent must independently review and accept before either reserve can be sent.");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }, [cashConfig, quote, session.status, sessionGateMessage, wagerAccepted]);

  const reserve = useCallback(async () => {
    if (session.status !== "ready") { setError(sessionGateMessage); return; }
    if (!quote || !reserveAccepted || !client || !address || !VERUSD_DENOM || !VERUSD_ESCROW_CONTRACT) { setError("Review and confirm the exact reserve before sending it. No transaction was sent."); return; }
    setBusy(true); setError(null);
    try {
      const result = TxResultSchema.parse(await client.execute(address, VERUSD_ESCROW_CONTRACT, { deposit_reserve: { game_id: quote.gameId } }, "auto", undefined, [{ denom: VERUSD_DENOM, amount: quote.reservePerPlayerMicroUsd }]));
      const response = await authenticatedFetch(`/api/cash-games/quotes/${quote.id}/reserve-confirmation`, { method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({ txHash: result.transactionHash }) });
      if (!response.ok) throw new Error("reserve confirmation rejected");
      setQuote(z.object({ quote: QuoteSchema }).parse(await response.json()).quote);
      setReserveAccepted(false);
      setNotice("Your reserve is final. The cash game starts only after both reserves are independently verified.");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }, [address, client, quote, reserveAccepted, session.status, sessionGateMessage]);

  const recoverSandboxRefund = useCallback(async () => {
    if (!quote) return;
    setBusy(true); setError(null);
    try {
      const response = await authenticatedFetch(`/__sandbox/cash-games/quotes/${quote.id}/refund-recovery`, {
        method: "POST",
        headers: idempotencyHeaders(),
      });
      if (!response.ok) throw new Error("sandbox refund recovery rejected");
      const nextQuote = z.object({ quote: QuoteSchema }).parse(await response.json()).quote;
      setQuote(nextQuote);
      setNotice(nextQuote.state === "refunded"
        ? "Sandbox refund completed. The durable receipt now records the refund."
        : "Sandbox refund recovery is queued. The durable receipt will refresh when the worker completes it.");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }, [quote]);


  const freeLink = game.gameId ? `${typeof window === "undefined" ? "" : window.location.origin}/join/free_${game.gameId}` : null;
  const cashLink = quote ? `${typeof window === "undefined" ? "" : window.location.origin}/join/cash_${quote.id}` : null;

  const copyInvite = useCallback(async (link: string, label: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setNotice(`${label} copied.`);
    } catch {
      setError("The link could not be copied. Select and copy it manually.");
    }
  }, []);
  const changeWallet = useCallback(async () => {
    await logout();
    window.location.replace(withReturnTo("/login", "/create-match"));
  }, [logout]);


  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6" aria-live="polite">
      <header>
        <h1 className="font-display text-3xl">Create a match</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">Free matches never move money. Cash games use a separate dollar-denominated escrow flow settled in verUSD, with exact terms, reserves, and receipts.</p>
        <Link href="/matchmaking" className="btn-primary mt-4 inline-flex min-h-11 items-center justify-center px-4">Find an opponent</Link>
      </header>
      {error && <p role="alert" className="rounded border border-red-700/40 p-3 text-sm">{error}</p>}
      {notice && <p role="status" className="rounded border border-emerald-700/40 p-3 text-sm">{notice}</p>}

      <section className="space-y-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
        <h2 className="text-xl font-semibold">Private free invite</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">Create a private free match to share with a specific friend. No wager or deposit is involved.</p>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold sm:col-span-2">Match settings</legend>
          <label className="grid gap-1 text-sm">
            Match length
            <select value={matchLength} onChange={(event) => setMatchLength(Number(event.target.value))} className="input min-h-11">
              {[1, 3, 5, 7].map((length) => <option key={length} value={length}>{length} point{length === 1 ? "" : "s"}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Per-turn time
            <select value={timeControl} onChange={(event) => setTimeControl(Number(event.target.value))} className="input min-h-11">
              {[5, 10, 15, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
            </select>
          </label>
        </fieldset>
        <button aria-describedby={session.status === "ready" ? undefined : "create-session-status"} disabled={!isConnected || !game.authenticated} onClick={createFreeMatch} className="btn-primary min-h-11 disabled:opacity-50">Create free invite</button>
        {session.status !== "ready" && (
          <section id="create-session-status" className="space-y-3 rounded border border-[var(--color-warning)] p-3 text-sm">
            <p role={session.status === "error" ? "alert" : "status"}>{sessionGateMessage} Free and cash submissions remain disabled.</p>
            {session.status === "error" && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary min-h-11" onClick={session.retry}>Retry authorization</button>
                <button type="button" className="min-h-11 rounded border px-4 py-2" onClick={() => void changeWallet()}>Change wallet</button>
              </div>
            )}
          </section>
        )}
        {freeLink && (
          <div className="rounded border p-3">
            <p className="text-sm">Share this free-match link:</p>
            <code className="block break-all pt-1 text-xs">{freeLink}</code>
            <button className="mt-2 min-h-11 underline" onClick={() => void copyInvite(freeLink, "Free-match link")}>Copy link</button>
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
        <div>
          <h2 className="text-xl font-semibold">Dollar cash game</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Amounts are denominated in U.S. dollars and reserved on Xion as verUSD. verUSD is a token, not a bank deposit.</p>
        </div>
        {isNativeApp ? (
          <p className="text-sm text-[var(--color-text-secondary)]">The native app supports free play only. Cash-game offers, reserves, and money movement are unavailable.</p>
        ) : !cashAvailable ? (
          <p role={session.status === "error" ? "alert" : "status"} className="text-sm text-[var(--color-text-secondary)]">
            {session.status !== "ready" ? sessionGateMessage : unavailableMoneyMessage()} Free play remains available.
          </p>
        ) : !quote ? (
          <>
            {cashConfig.testFunds && <p role="status" className="rounded border border-[var(--color-warning)] p-3 text-sm font-semibold">TEST FUNDS ONLY — every cash-game quote, reserve, and receipt has no cash value and cannot be withdrawn as real money.</p>}
            <p className="text-sm text-[var(--color-text-secondary)]">Each player reserves the maximum exposure for the selected stake: up to 8× the stake per point, with gammon and backgammon scoring. Cube changes never request an extra deposit.</p>
            <label className="grid gap-1 text-sm">
              Opponent XION address
              <input ref={opponentInput} value={opponent} onChange={(event) => setOpponent(event.target.value)} placeholder="xion1…" className="input min-h-11 font-mono" autoComplete="off" spellCheck={false} aria-invalid={Boolean(opponent) && Boolean(xionAddressError(opponent, address))} aria-describedby="opponent-help" />
              <span id="opponent-help" className="text-xs text-[var(--color-text-muted)]">{xionAddressError(opponent, address) ?? "Enter the recipient’s XION address; you cannot select your own wallet."}</span>
            </label>
            <label className="grid gap-1 text-sm">
              Dollar stake per point
              <span className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true">$</span>
                <input ref={stakeInput} aria-label="Dollar stake per point" inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} placeholder="5.00" className="input min-h-11 w-full pl-7" aria-invalid={Boolean(stake) && Boolean(usdCentsError(stake) ?? (BigInt(stake.replace(".", "")) > 100_000n ? "The maximum stake is $1,000.00 per point." : null))} aria-describedby="stake-help" />
              </span>
              <span id="stake-help" className="text-xs text-[var(--color-text-muted)]">{usdCentsError(stake) ?? (stake && BigInt(stake.replace(".", "")) > 100_000n ? "The maximum stake is $1,000.00 per point." : "Use a canonical positive whole-cent amount up to $1,000.00; deployment and eligibility limits are checked before an offer is created.")}</span>
            </label>
            <button disabled={busy} onClick={() => void createQuote()} className="btn-primary min-h-11 disabled:opacity-50">Create cash-game offer</button>
          </>
        ) : (
          <div className="space-y-3">
            <dl className="grid gap-2 text-sm">
              <div><dt className="inline text-[var(--color-text-muted)]">Stake per point: </dt><dd className="inline font-mono">${toDisplay(quote.stakeMicroUsd)} {quote.asset.displayDenomination} · {quote.asset.symbol}</dd></div>
              <div><dt className="inline text-[var(--color-text-muted)]">Maximum reserve per player: </dt><dd className="inline font-mono">${toDisplay(quote.reservePerPlayerMicroUsd)} {quote.asset.displayDenomination} · {quote.asset.symbol}</dd></div>
              <div><dt className="inline text-[var(--color-text-muted)]">Cube cap: </dt><dd className="inline">×{quote.cubeCap}</dd></div>
              <div><dt className="inline text-[var(--color-text-muted)]">Rake: </dt><dd className="inline">{quote.rakeBps / 100}%</dd></div>
              <div><dt className="inline text-[var(--color-text-muted)]">Offer expires: </dt><dd className="inline">{new Date(quote.expiresAt).toLocaleString()}</dd></div>
            </dl>
            <code className="block break-all rounded border p-2 text-xs">Quote hash: {quote.quoteHash}</code>
            <p className="text-sm font-semibold">Recipient: {quote.playerB}. Custody: the Xion {quote.asset.symbol} escrow contract holds each verified reserve until settlement or refund. {quote.testFunds ? "Test funds — no cash value" : "Production verUSD"}.</p>
            {cashLink && (
              <div className="rounded border p-3">
                <p className="text-sm">Only share this link with the named opponent:</p>
                <code className="block break-all pt-1 text-xs">{cashLink}</code>
                <button className="mt-2 min-h-11 underline" onClick={() => void copyInvite(cashLink, "Private acceptance link")}>Copy private acceptance link</button>
              </div>
            )}
            <CashQuoteDisclosure quote={quote} />
            {quote.state === "offered" && (
              <>
                <label className="flex items-start gap-3 text-sm">
                  <input className="mt-1 h-5 w-5" type="checkbox" checked={wagerAccepted} onChange={(event) => setWagerAccepted(event.target.checked)} />
                  <span>I accept this exact wager with {quote.playerB}: ${toDisplay(quote.stakeMicroUsd)} per point, maximum reserve ${toDisplay(quote.reservePerPlayerMicroUsd)}, cube cap ×{quote.cubeCap}, {quote.rakeBps / 100}% rake, and quote {quote.quoteHash}. I reviewed the <Link className="underline" href="/terms">Terms</Link>, <Link className="underline" href="/privacy">Privacy Notice</Link>, and <Link className="underline" href="/responsible-play">Responsible Play</Link> policy. {quote.testFunds ? "Test funds — no cash value" : "Production verUSD"}.</span>
                </label>
                <button disabled={busy || !wagerAccepted || session.status !== "ready"} onClick={() => void acceptOwnQuote()} className="btn-primary min-h-11 disabled:opacity-50">Accept this exact wager</button>
              </>
            )}
            {quote.state === "accepted" && <p className="text-sm">Waiting for the opponent’s independent acceptance. No reserve transaction is available yet.</p>}
            {quote.state === "reserving" && quote.fundingDeadline !== null && (
              <>
                <label className="flex items-start gap-3 text-sm">
                  <input className="mt-1 h-5 w-5" type="checkbox" checked={reserveAccepted} onChange={(event) => setReserveAccepted(event.target.checked)} />
                  <span>I confirm sending exactly ${toDisplay(quote.reservePerPlayerMicroUsd)} {quote.asset.symbol} ({quote.testFunds ? "Test funds — no cash value" : "production funds"}) from my wallet to the Xion escrow contract for quote {quote.quoteHash}. This transfer is not reversible.</span>
                </label>
                <button disabled={busy || !reserveAccepted || session.status !== "ready"} onClick={() => void reserve()} className="btn-primary min-h-11 disabled:opacity-50">Reserve ${toDisplay(quote.reservePerPlayerMicroUsd)} in {quote.asset.symbol}</button>
              </>
            )}
            {quote.state === "active" && browserSandboxRefundRecovery && (
              <section className="space-y-2 rounded border border-[var(--color-warning)] p-3 text-sm">
                <p>Development sandbox only: queue the normal cash-game refund recovery flow.</p>
                <button disabled={busy} onClick={() => void recoverSandboxRefund()} className="min-h-11 rounded border px-4 py-2 disabled:opacity-50">Recover sandbox refund</button>
              </section>
            )}
            {["settlement_pending", "settled", "refunded", "review", "expired"].includes(quote.state) && <p className="text-sm">This offer is no longer available for play. Open Activity for its durable receipt and recovery status.</p>}
          </div>
        )}
      </section>
    </main>
  );
}
