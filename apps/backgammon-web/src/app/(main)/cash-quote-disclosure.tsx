import type { ReactNode } from "react";

type QuoteTerms = {
  stakeMicroUsd: string;
  reservePerPlayerMicroUsd: string;
  rakeBps: number;
  quoteHash: string;
  fundsMode: "free" | "verusd_testnet" | "verusd_production" | "legacy_unverified";
  testFunds: boolean;
  asset: { symbol: string; displayDenomination: string };
  termsSnapshot: Record<string, unknown>;
  legalSnapshot: Record<string, unknown>;
};

function usd(micro: bigint): string {
  return `$${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}

function text(snapshot: Record<string, unknown>, key: string): string {
  return typeof snapshot[key] === "string" ? snapshot[key] : "legacy/unverified";
}

type BalanceDisclosureProps = {
  id?: string;
  available?: string | null;
  committed?: string | null;
  pending?: string | null;
  observedAt?: string | null;
  stale?: boolean;
  custody: ReactNode;
};

export function BalanceDisclosure({ id, available, committed, pending, observedAt, stale = false, custody }: BalanceDisclosureProps) {
  const hasBalance = available !== null && available !== undefined && committed !== null && committed !== undefined && pending !== null && pending !== undefined;
  return (
    <section id={id} className="space-y-2 rounded border border-[var(--color-border-subtle)] p-3 text-sm" aria-labelledby={id ? `${id}-title` : undefined}>
      <h3 id={id ? `${id}-title` : undefined} className="font-semibold">How your balance works</h3>
      {hasBalance && (
        <dl className="grid gap-2 sm:grid-cols-3">
          <div><dt className="text-[var(--color-text-muted)]">Available</dt><dd className="font-semibold tabular-nums">{available}</dd><dd className="text-xs text-[var(--color-text-secondary)]">verUSD confirmed for a new action</dd></div>
          <div><dt className="text-[var(--color-text-muted)]">Committed</dt><dd className="font-semibold tabular-nums">{committed}</dd><dd className="text-xs text-[var(--color-text-secondary)]">verUSD reserved for active cash games</dd></div>
          <div><dt className="text-[var(--color-text-muted)]">Pending</dt><dd className="font-semibold tabular-nums">{pending}</dd><dd className="text-xs text-[var(--color-text-secondary)]">verUSD awaiting provider or chain completion</dd></div>
        </dl>
      )}
      {!hasBalance && <p>Available funds are confirmed for a new action; committed funds are reserved for active cash games; pending funds await provider or chain completion.</p>}
      <p><strong>Custody:</strong> {custody}</p>
      <p><strong>Source and freshness:</strong> {observedAt ? <>authoritative Xion on-chain balance observed {new Date(observedAt).toLocaleString()}{stale ? "; this reading is stale and cannot authorize a money action." : "; this is a fresh reading, which is required before money authorization."}</> : "no live or as-of wallet balance state is included here; verify an authoritative fresh balance before authorizing a money action, because stale data cannot authorize one."}</p>
      <p><strong>Token and insurance:</strong> verUSD is a digital settlement token, not a bank deposit, and is not FDIC- or SIPC-insured.</p>
    </section>
  );
}

export function CashQuoteDisclosure({ quote, children }: { quote: QuoteTerms; children?: ReactNode }) {
  const stake = BigInt(quote.stakeMicroUsd);
  const reserve = BigInt(quote.reservePerPlayerMicroUsd);
  const example = (label: string, multiplier: bigint) => {
    const gross = stake * 2n * multiplier;
    const fee = gross * BigInt(quote.rakeBps) / 10_000n;
    const net = gross - fee;
    return <li key={label}><strong>{label} at a turned ×2 cube:</strong> gross loss {usd(gross)}, rake {usd(fee)}, winner receives own reserve plus {usd(net)}, and the loser receives unused reserve {usd(reserve - gross)}.</li>;
  };
  return (
    <div className="space-y-3 rounded border border-[var(--color-border-subtle)] p-3 text-sm">
      {quote.fundsMode === "legacy_unverified" ? <p className="font-semibold text-[var(--color-warning)]">TEST/UNVERIFIED FUNDS — no cash value.</p> : quote.testFunds ? <p className="font-semibold text-[var(--color-warning)]">TEST FUNDS ONLY — no cash value.</p> : null}
      <p><strong>Maximum exposure:</strong> each participant pre-reserves {usd(reserve)} {quote.asset.displayDenomination} ({quote.asset.symbol}); no cube change requests more money. The dollar amount is primary and {quote.asset.symbol} is the settlement asset.</p>
      <ul className="list-disc space-y-1 pl-5">{example("Normal win", 1n)}{example("Gammon", 2n)}{example("Backgammon", 3n)}</ul>
      <p><strong>Cancellation, custody, and interruption:</strong> an unaccepted quote expires without a reserve. Verified reserves stay in the Xion escrow contract until a verified settlement or refund. Funding timeout, no-show, disconnect, proof failure, or recovery pause never infer a winner: the record remains under review until both resume, a refund, or an authorized no-forfeit resolution.</p>
      <BalanceDisclosure custody={<>This wager&apos;s verified reserve is held by the Xion escrow contract until a verified settlement or refund.</>} />
      <p><strong>Timing:</strong> offer expiry, turn, response, and interruption deadlines are fixed by the quote rules. Expiry or review does not erase this receipt.</p>
      <p><strong>Bound evidence:</strong> quote hash <code className="break-all">{quote.quoteHash}</code>; cash terms {text(quote.termsSnapshot, "cashTermsVersion")}; responsible play {text(quote.termsSnapshot, "responsiblePlayVersion")}; legal terms {text(quote.legalSnapshot, "terms")}.</p>
      {children}
    </div>
  );
}
