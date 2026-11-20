"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { CashQuoteDisclosure } from "../cash-quote-disclosure";
import { useAuth } from "@/hooks/useAuth";
import { useFundsConfig } from "@/hooks/useFundsConfig";
import { useServerSession } from "@/hooks/useServerSession";
import { authenticatedFetch } from "@/lib/server-session";

const OperationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["enroll", "link_bank", "deposit", "cash_out", "wager_reserve", "wager_settlement", "refund"]),
  state: z.enum(["created", "awaiting_user", "queued", "processing", "pending", "complete", "canceled", "failed", "refunding", "refunded", "review"]),
  amountMicroUsd: z.string().nullable(),
  assetDenom: z.string().nullable(),
  fundsMode: z.enum(["free", "verusd_testnet", "verusd_production", "legacy_unverified"]),
  testFunds: z.boolean(),
  transfer: z.object({
    source: z.object({ type: z.string() }), destination: z.object({ type: z.string() }),
    grossMicroUsd: z.string().nullable(), feeMicroUsd: z.string(), netMicroUsd: z.string().nullable(), balanceEffectMicroUsd: z.string().nullable(),
  }),
  transitions: z.array(z.object({ sequence: z.number(), state: z.string(), occurredAt: z.string().datetime(), reference: z.string().nullable() })),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const SettlementReceiptSchema = z.object({
  cubeValue: z.number(),
  cubeWasTurned: z.boolean(),
  gameId: z.string(),
  quoteId: z.string(),
  resultMultiplier: z.number(),
  settlementId: z.string(),
  winner: z.string(),
  settlement: z.object({
    liabilityMicroUsd: z.string(),
    loserRefundMicroUsd: z.string(),
    rakeMicroUsd: z.string(),
    totalDepositedMicroUsd: z.string(),
    winnerPayoutMicroUsd: z.string(),
  }),
});
const RefundReceiptSchema = z.object({
  kind: z.literal("refund"),
  gameId: z.string(),
  quoteId: z.string(),
  refundId: z.string(),
  reason: z.string(),
  refundedAt: z.string().datetime(),
});
const ReceiptSchema = z.union([SettlementReceiptSchema, RefundReceiptSchema]);
const QuoteSchema = z.object({
  id: z.string().uuid(), gameId: z.string(), quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["offered", "accepted", "reserving", "active", "settlement_pending", "settled", "refunded", "review", "expired"]),
  playerA: z.string().optional(), playerB: z.string().optional(),
  rules: z.record(z.string(), z.unknown()),
  stakeMicroUsd: z.string(), reservePerPlayerMicroUsd: z.string(), rakeBps: z.number().nonnegative(),
  fundsMode: z.enum(["free", "verusd_testnet", "verusd_production", "legacy_unverified"]),
  testFunds: z.boolean(),
  asset: z.object({ denom: z.string(), decimals: z.number(), symbol: z.string(), displayDenomination: z.string() }),
  balanceSnapshot: z.record(z.string(), z.unknown()), termsSnapshot: z.record(z.string(), z.unknown()), legalSnapshot: z.record(z.string(), z.unknown()),
  acceptances: z.array(z.object({ principal: z.string(), quoteHash: z.string(), acceptedAt: z.string().datetime(), evidence: z.record(z.string(), z.unknown()) })),
  createdAt: z.string().nullable().optional(), updatedAt: z.string().nullable().optional(),
  cashSessionStartedAt: z.string().nullable().optional(), realityCheckAcknowledgedAt: z.string().nullable().optional(),
  receipt: ReceiptSchema.nullable(), settlementTxHash: z.string().nullable(), reviewReason: z.string().nullable().optional(),
  recovery: z.object({ fundedStartDeadline: z.string().nullable().optional(), reviewDeadline: z.string().nullable().optional(), resolutionState: z.string().nullable().optional(), resolutionReason: z.string().nullable().optional() }).nullable().optional(),
});

type Operation = z.infer<typeof OperationSchema>;
type Quote = z.infer<typeof QuoteSchema>;
const TERMINAL_STATES: Record<string, true> = {
  canceled: true,
  complete: true,
  expired: true,
  failed: true,
  refunded: true,
  settled: true,
};

function dollars(micro?: string | null): string {
  if (!micro || !/^\d+$/.test(micro)) return "—";
  const value = BigInt(micro);
  return `$${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}

function timestamp(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function quoteStateLabel(state: Quote["state"]): string {
  return {
    offered: "Awaiting acceptance", accepted: "Accepted", reserving: "Funding", active: "In play",
    settlement_pending: "Settlement pending", settled: "Settled", refunded: "Refunded", review: "Under review", expired: "Expired",
  }[state];
}
function operationStateLabel(state: Operation["state"]): string {
  return {
    created: "Created", awaiting_user: "Awaiting your transfer", queued: "Queued", processing: "Processing",
    pending: "Pending confirmation", complete: "Complete", canceled: "Canceled", failed: "Failed",
    refunding: "Refund in progress", refunded: "Refunded", review: "Under review",
  }[state];
}
function operationKindLabel(kind: Operation["kind"]): string {
  return {
    enroll: "Wallet enrollment", link_bank: "Bank link", deposit: "Deposit", cash_out: "Cash out",
    wager_reserve: "Wager reserve", wager_settlement: "Wager settlement", refund: "Refund",
  }[kind];
}
function StateBadge({ label, terminal }: { label: string; terminal: boolean }) {
  return <span aria-label={`State: ${label}`} className="rounded-full border px-2 py-1 text-xs font-semibold" style={{ borderColor: terminal ? "var(--color-border-strong)" : "var(--color-warning)" }}>{terminal ? "●" : "◷"} {label}</span>;
}

function TestFundsBadge({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return <span className="rounded-full border border-[var(--color-warning)] px-2 py-1 text-xs font-semibold text-[var(--color-warning)]">Test funds — no cash value</span>;
}

function quoteOpponent(quote: Quote, address?: string | null): string {
  if (address && quote.playerA === address) return quote.playerB ?? "Participant";
  if (address && quote.playerB === address) return quote.playerA ?? "Participant";
  return quote.playerB ?? quote.playerA ?? "Participant";
}

function receiptSummary(quote: Quote): string {
  if (!quote.receipt) return "Receipt pending";
  return "kind" in quote.receipt ? "Refund receipt" : "Settlement receipt";
}

function supportHref(reference: string): string {
  return `/support?reference=${encodeURIComponent(reference)}`;
}

function snapshotText(snapshot: Record<string, unknown>, key: string): string {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value : "Legacy/unverified";
}

function operationGuidance(operation: Operation): { nextUpdate: string; timing: string; doNotRepeat: boolean } {
  switch (operation.state) {
    case "created":
      return {
        nextUpdate: "The next state recorded for this operation—an action request, queue entry, or cancellation—is authoritative.",
        timing: "Wait for this operation's status to change; its Last update time is the current record.",
        doNotRepeat: true,
      };
    case "awaiting_user":
      return {
        nextUpdate: "The original transfer request's confirmation is the authoritative next update.",
        timing: "Submit the requested transfer once, then wait for its confirmation on this operation.",
        doNotRepeat: true,
      };
    case "queued":
      return {
        nextUpdate: "A processing or confirmation status written to this operation is the authoritative next update.",
        timing: "The queue advances asynchronously; use the Last update time rather than an estimated completion time.",
        doNotRepeat: true,
      };
    case "processing":
      return {
        nextUpdate: "The provider or wallet confirmation recorded here is the authoritative next update.",
        timing: "Processing completes only when the provider reports back to this operation.",
        doNotRepeat: true,
      };
    case "pending":
      return {
        nextUpdate: "The pending confirmation or final operation record is the authoritative next update.",
        timing: "Confirmation timing is external; the accounted amounts remain recorded while confirmation is pending.",
        doNotRepeat: true,
      };
    case "complete":
      return {
        nextUpdate: "This completed operation record is the authoritative receipt.",
        timing: "No further action is scheduled unless a separate operation is created.",
        doNotRepeat: false,
      };
    case "canceled":
      return {
        nextUpdate: "This cancellation record is the authoritative outcome.",
        timing: "No further processing is scheduled for this operation.",
        doNotRepeat: false,
      };
    case "failed":
      return {
        nextUpdate: "This failed operation record is the authoritative outcome until Support advises otherwise.",
        timing: "Do not retry from this record; any later attempt must appear as a new operation.",
        doNotRepeat: true,
      };
    case "refunding":
      return {
        nextUpdate: "The refund completion recorded on this operation is the authoritative next update.",
        timing: "The refund is in progress; accounted amounts remain recorded until the refund receipt is final.",
        doNotRepeat: true,
      };
    case "refunded":
      return {
        nextUpdate: "This refunded operation record is the authoritative receipt.",
        timing: "No further processing is scheduled for this operation.",
        doNotRepeat: false,
      };
    case "review":
      return {
        nextUpdate: "The review resolution—completion, refund, cancellation, or failure—recorded here is authoritative.",
        timing: "Review has no implied deadline; wait for the recorded resolution.",
        doNotRepeat: true,
      };
  }
}

export default function ActivityPage() {
  const params = useSearchParams();
  const quoteId = params.get("cashQuote");
  const selectedOperationId = params.get("operation");
  const { address } = useAuth();
  const session = useServerSession();
  const funds = useFundsConfig();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (session.status !== "ready") return;
    setStatus("loading");
    setError(null);
    try {
      const [walletResponse, quotesResponse] = await Promise.all([
        authenticatedFetch("/api/funds/wallet"),
        authenticatedFetch("/api/cash-games/quotes"),
      ]);
      if (!walletResponse.ok) throw new Error("Money activity is unavailable.");
      if (!quotesResponse.ok) throw new Error("Cash-game receipt history is unavailable.");
      const wallet = z.object({ operations: z.array(OperationSchema) }).passthrough().parse(await walletResponse.json());
      const quoteHistory = z.object({ quotes: z.array(QuoteSchema) }).parse(await quotesResponse.json()).quotes;
      setOperations(wallet.operations);
      setQuotes(quoteHistory);
      if (quoteId) {
        const quoteResponse = await authenticatedFetch(`/api/cash-games/quotes/${quoteId}`);
        if (!quoteResponse.ok) throw new Error("This settlement receipt is unavailable to the connected wallet.");
        setQuote(z.object({ quote: QuoteSchema }).parse(await quoteResponse.json()).quote);
      } else {
        setQuote(null);
      }
      setStatus("ready");
    } catch {
      setError("Activity and receipts could not be loaded. Retry.");
      setStatus("error");
    }
  }, [quoteId, session.status]);

  useEffect(() => { void refresh(); }, [refresh]);
  const selectedQuoteState = quote?.state ?? null;
  useEffect(() => {
    if (!quoteId || !selectedQuoteState || selectedQuoteState in TERMINAL_STATES) return;
    const interval = window.setInterval(() => { void refresh(); }, 4_000);
    return () => window.clearInterval(interval);
  }, [quoteId, refresh, selectedQuoteState]);

  const selectedOperation = useMemo(
    () => operations.find((operation) => operation.id === selectedOperationId) ?? null,
    [operations, selectedOperationId],
  );
  const selectedOperationGuidance = selectedOperation ? operationGuidance(selectedOperation) : null;
  const testFunds = funds.status === "ready" && funds.config.testFunds;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="font-display text-3xl">Activity and receipts</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          Pending is not complete. Balances and payouts become final only after the authoritative operation or settlement receipt is complete.
        </p>
        {testFunds && <p className="mt-2 font-semibold text-[var(--color-warning)]">Test funds — no cash value</p>}
      </header>

      <div aria-live="polite">
        {status === "loading" && <p role="status">Refreshing activity…</p>}
        {error && (
          <div role="alert" className="rounded border border-[var(--color-danger)] p-3 text-sm">
            {error} <button type="button" className="underline" onClick={() => void refresh()}>Retry</button>
          </div>
        )}
      </div>

      {selectedOperation && (
        <section aria-labelledby="operation-detail-title" className="space-y-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="operation-detail-title" className="text-xl font-semibold">{operationKindLabel(selectedOperation.kind)}</h2>
            <StateBadge label={operationStateLabel(selectedOperation.state)} terminal={selectedOperation.state === "complete" || selectedOperation.state === "canceled" || selectedOperation.state === "failed" || selectedOperation.state === "refunded"} />
          </div>
          <TestFundsBadge enabled={selectedOperation.testFunds} />
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-[var(--color-text-muted)]">Accounted amount</dt><dd>{dollars(selectedOperation.amountMicroUsd)} USD · {selectedOperation.assetDenom ?? "verUSD"}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Gross / fee / net</dt><dd>{dollars(selectedOperation.transfer.grossMicroUsd)} / {dollars(selectedOperation.transfer.feeMicroUsd)} / {dollars(selectedOperation.transfer.netMicroUsd)} USD · {selectedOperation.assetDenom ?? "verUSD"}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Balance effect</dt><dd>{dollars(selectedOperation.transfer.balanceEffectMicroUsd)} USD · {selectedOperation.assetDenom ?? "verUSD"}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">From / to</dt><dd>{selectedOperation.transfer.source.type.replaceAll("_", " ")} → {selectedOperation.transfer.destination.type.replaceAll("_", " ")}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Reference</dt><dd className="break-all font-mono">{selectedOperation.id}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Created</dt><dd>{timestamp(selectedOperation.createdAt)}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Last update</dt><dd>{timestamp(selectedOperation.updatedAt)}</dd></div>
          </dl>
          {selectedOperationGuidance && (
            <div className="rounded border border-[var(--color-border-subtle)] p-3 text-sm">
              <p><strong>Authoritative next update:</strong> {selectedOperationGuidance.nextUpdate}</p>
              <p className="mt-1 text-[var(--color-text-secondary)]"><strong>Timing:</strong> {selectedOperationGuidance.timing}</p>
              {selectedOperationGuidance.doNotRepeat && <p role="alert" className="mt-2 font-semibold text-[var(--color-warning)]">Do not repeat this submission or transfer. Wait for the authoritative update above.</p>}
              <Link className="mt-2 inline-block underline" href={supportHref(selectedOperation.id)}>Get help with this operation</Link>
            </div>
          )}
          <ol className="space-y-1 border-t border-[var(--color-border-subtle)] pt-3 text-sm">
            {selectedOperation.transitions.map((transition) => <li key={transition.sequence}>{transition.sequence}. {operationStateLabel(transition.state as Operation["state"])} · {timestamp(transition.occurredAt)}{transition.reference ? ` · ${transition.reference}` : ""}</li>)}
          </ol>
        </section>
      )}

      {quote && (
        <section aria-labelledby="settlement-title" className="space-y-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="settlement-title" className="text-xl font-semibold">Cash-game receipt</h2>
            <StateBadge label={quoteStateLabel(quote.state)} terminal={quote.state === "settled" || quote.state === "refunded" || quote.state === "expired"} />
          </div>
          <TestFundsBadge enabled={quote.testFunds} />
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-[var(--color-text-muted)]">Opponent</dt><dd className="break-all font-mono">{quoteOpponent(quote, address)}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Game</dt><dd className="break-all font-mono">{quote.gameId}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Quote</dt><dd className="break-all font-mono">{quote.id}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Stake per point</dt><dd>{dollars(quote.stakeMicroUsd)} {quote.asset.displayDenomination} · {quote.asset.symbol}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Maximum reserve</dt><dd>{dollars(quote.reservePerPlayerMicroUsd)} {quote.asset.displayDenomination} · {quote.asset.symbol}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Created</dt><dd>{timestamp(quote.createdAt)}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Cash session started</dt><dd>{timestamp(quote.cashSessionStartedAt)}</dd></div>
            <div><dt className="text-[var(--color-text-muted)]">Reality check acknowledged</dt><dd>{timestamp(quote.realityCheckAcknowledgedAt)}</dd></div>
          </dl>
          <CashQuoteDisclosure quote={quote}>
            <div className="border-t border-[var(--color-border-subtle)] pt-3 text-xs">
              <p className="font-semibold">Persisted accepted terms</p>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                <div><dt className="text-[var(--color-text-muted)]">Cancellation</dt><dd>{snapshotText(quote.termsSnapshot, "cancellation")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Custody</dt><dd>{snapshotText(quote.termsSnapshot, "custody")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Recovery and disconnect rules</dt><dd>{snapshotText(quote.termsSnapshot, "recovery")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Timing rules</dt><dd>{snapshotText(quote.termsSnapshot, "timing")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Offer expiry</dt><dd>{typeof quote.termsSnapshot.expirySeconds === "number" ? `${quote.termsSnapshot.expirySeconds} seconds` : "Legacy/unverified"}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Rules version</dt><dd>{snapshotText(quote.rules, "version")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Cash terms version</dt><dd>{snapshotText(quote.termsSnapshot, "cashTermsVersion")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Responsible play version</dt><dd>{snapshotText(quote.termsSnapshot, "responsiblePlayVersion")}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Legal terms version</dt><dd>{snapshotText(quote.legalSnapshot, "terms")}</dd></div>
              </dl>
              <p className="mt-3 font-semibold">Participant acceptances</p>
              {quote.acceptances.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {quote.acceptances.map((acceptance) => <li key={acceptance.principal}>Accepted by <span className="font-mono">{acceptance.principal}</span> at {timestamp(acceptance.acceptedAt)} · bound quote hash <code>{acceptance.quoteHash}</code></li>)}
                </ul>
              ) : <p className="mt-1">No participant acceptance timestamp is recorded.</p>}
            </div>
          </CashQuoteDisclosure>
          {quote.state === "review" && (
            <div role="alert" className="rounded border border-[var(--color-warning)] bg-[var(--color-bg-elevated)] p-3 text-sm">
              <p className="font-semibold">Reserved funds are held for review.</p>
              <p className="mt-1 text-[var(--color-text-secondary)]">No winner or payout is final until this receipt changes to settled or refunded.</p>
              {quote.recovery?.reviewDeadline && <p className="mt-1 text-[var(--color-text-secondary)]">Review deadline: {timestamp(quote.recovery.reviewDeadline)}.</p>}
            </div>
          )}
          {quote.receipt ? "kind" in quote.receipt ? (
            <>
              <div role="status" className="rounded border border-[var(--color-border-strong)] p-3 text-sm">
                <p className="font-semibold">Escrow reserves refunded</p>
                <p className="mt-1 text-[var(--color-text-secondary)]">Refunded {timestamp(quote.receipt.refundedAt)}.</p>
              </div>
              <p className="break-all text-xs">Refund ID: <code>{quote.receipt.refundId}</code></p>
              <p className="break-all text-xs">Settlement transaction: <code>{quote.settlementTxHash ?? "Confirmed by the escrow receipt"}</code></p>
            </>
          ) : (
            <>
              <dl className="grid gap-2 border-t border-[var(--color-border-subtle)] pt-3 text-sm sm:grid-cols-2">
                <div><dt className="text-[var(--color-text-muted)]">Winner</dt><dd className="break-all font-mono">{quote.receipt.winner}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Cube × result</dt><dd>{quote.receipt.cubeValue} × {quote.receipt.resultMultiplier}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Transferred loss</dt><dd>{dollars(quote.receipt.settlement.liabilityMicroUsd)} {quote.asset.symbol}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Rake</dt><dd>{dollars(quote.receipt.settlement.rakeMicroUsd)} {quote.asset.symbol}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Winner payout</dt><dd>{dollars(quote.receipt.settlement.winnerPayoutMicroUsd)} {quote.asset.symbol}</dd></div>
                <div><dt className="text-[var(--color-text-muted)]">Loser reserve released</dt><dd>{dollars(quote.receipt.settlement.loserRefundMicroUsd)} {quote.asset.symbol}</dd></div>
              </dl>
              <p className="break-all text-xs">Settlement ID: <code>{quote.receipt.settlementId}</code></p>
              <p className="break-all text-xs">Settlement transaction: <code>{quote.settlementTxHash ?? "Awaiting chain confirmation"}</code></p>
            </>
          ) : (
            <p role="status" className="text-sm text-[var(--color-text-secondary)]">Settlement receipt pending. Reserved funds remain committed until settlement, refund, or review completes.</p>
          )}
          <Link className="underline" href={supportHref(quote.id)}>Report a settlement problem</Link>
        </section>
      )}

      <section aria-labelledby="quote-list-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="quote-list-title" className="text-xl font-semibold">Cash-game quotes and receipts</h2>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Each entry is a signed quote and its current authoritative settlement status.</p>
          </div>
          <button type="button" className="underline" onClick={() => void refresh()}>Refresh</button>
        </div>
        {status === "ready" && quotes.length === 0 && <p className="text-sm text-[var(--color-text-secondary)]">No cash-game quotes are recorded for this account.</p>}
        <ul className="space-y-2">
          {quotes.map((historyQuote) => (
            <li key={historyQuote.id}>
              <Link
                href={`/activity?cashQuote=${encodeURIComponent(historyQuote.id)}`}
                className="block rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-4 no-underline"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <strong className="text-[var(--color-text-primary)]">Cash-game quote</strong>
                  <StateBadge label={quoteStateLabel(historyQuote.state)} terminal={historyQuote.state === "settled" || historyQuote.state === "refunded" || historyQuote.state === "expired"} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <TestFundsBadge enabled={historyQuote.testFunds} />
                  <span>Opponent: <span className="font-mono">{quoteOpponent(historyQuote, address)}</span></span>
                  <span>Stake: {dollars(historyQuote.stakeMicroUsd)} {historyQuote.asset.displayDenomination} · {historyQuote.asset.symbol}</span>
                  <span>Maximum reserve: {dollars(historyQuote.reservePerPlayerMicroUsd)} {historyQuote.asset.displayDenomination} · {historyQuote.asset.symbol}</span>
                </div>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {receiptSummary(historyQuote)} · Created {timestamp(historyQuote.createdAt)}
                  {historyQuote.updatedAt && ` · Updated ${timestamp(historyQuote.updatedAt)}`}
                </p>
                {historyQuote.settlementTxHash && <p className="mt-1 break-all text-xs text-[var(--color-text-muted)]">Settlement transaction: <code>{historyQuote.settlementTxHash}</code></p>}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="operation-list-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="operation-list-title" className="text-xl font-semibold">Money operations</h2>
          <button type="button" className="underline" onClick={() => void refresh()}>Refresh</button>
        </div>
        {status === "ready" && operations.length === 0 && <p className="text-sm text-[var(--color-text-secondary)]">No money operations are recorded for this account.</p>}
        <ul className="space-y-2">
          {operations.map((operation) => (
            <li key={operation.id}>
              <Link
                href={`/activity?operation=${encodeURIComponent(operation.id)}`}
                className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-3 no-underline"
              >
                <span>
                  <strong className="block">{operationKindLabel(operation.kind)}</strong>
                  <span className="text-xs text-[var(--color-text-muted)]">{timestamp(operation.updatedAt)} · {dollars(operation.transfer.netMicroUsd)} USD · {operation.assetDenom ?? "verUSD"} {operation.testFunds && "· Test funds"}</span>
                </span>
                <StateBadge label={operationStateLabel(operation.state)} terminal={operation.state === "complete" || operation.state === "canceled" || operation.state === "failed" || operation.state === "refunded"} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
