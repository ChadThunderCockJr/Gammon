"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { formatMicroUsd } from "@xion-beginner/backgammon-core";
import { useFundsConfig } from "@/hooks/useFundsConfig";
import { useAuth } from "@/hooks/useAuth";
import { useServerSession } from "@/hooks/useServerSession";
import { authenticatedFetch } from "@/lib/server-session";

const MicroUsdSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const LimitTypeSchema = z.enum([
  "deposit_limit",
  "wager_limit",
  "daily_wager_limit",
  "daily_loss_limit",
]);
type LimitType = z.infer<typeof LimitTypeSchema>;

const RestrictionsSchema = z.object({
  selfExcludedUntil: z.string().datetime().nullable().optional(),
  coolingOffUntil: z.string().datetime().nullable().optional(),
  depositLimitMicroUsd: MicroUsdSchema.nullable().optional(),
  wagerLimitMicroUsd: MicroUsdSchema.nullable().optional(),
  dailyWagerLimitMicroUsd: MicroUsdSchema.nullable().optional(),
  dailyLossLimitMicroUsd: MicroUsdSchema.nullable().optional(),
  pendingIncrease: z.object({
    type: LimitTypeSchema,
    amountMicroUsd: MicroUsdSchema,
    effectiveAt: z.string().datetime(),
  }).nullable().optional(),
  activity24h: z.object({
    depositsMicroUsd: MicroUsdSchema,
    wagerCommitmentsMicroUsd: MicroUsdSchema,
    realizedLossesMicroUsd: MicroUsdSchema,
  }).optional(),
  limitChange: z.object({
    appliedImmediately: z.boolean(),
    effectiveAt: z.string().datetime().nullable(),
  }).nullable().optional(),
}).passthrough();


function describe(error: unknown): string {
  void error;
  return "The request could not be completed. Check the form and retry.";
}

const limitLabels: Readonly<Record<LimitType, string>> = {
  deposit_limit: "24-hour deposit limit",
  wager_limit: "Per-game wager limit",
  daily_wager_limit: "24-hour wager limit",
  daily_loss_limit: "24-hour loss limit",
};

function money(value: string | null | undefined): string {
  return value === null || value === undefined
    ? "Not set"
    : `${formatMicroUsd(BigInt(value))} · verUSD`;
}

function configuredCap(value: string | null | undefined): string {
  return value === null || value === undefined ? "No configured cap" : money(value);
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString();
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  await response.body?.cancel().catch(() => undefined);
  return new Error(fallback);
}

const USD_CENTS = /^(?:0|[1-9]\d{0,8})\.\d{2}$/;

function limitAmountError(value: string): string | null {
  return USD_CENTS.test(value)
    ? null
    : "Enter a nonnegative dollar amount in whole cents, for example 0.00.";
}

function remaining(cap: string | null | undefined, used: string): string {
  if (cap === null || cap === undefined) return "No configured cap";
  const value = BigInt(cap) - BigInt(used);
  return value > 0n ? money(value.toString()) : `${money("0")} (cap reached)`;
}

export default function ResponsiblePlayPage() {
  const { logout } = useAuth();
  const session = useServerSession();
  const funds = useFundsConfig();
  const help = funds.config?.responsiblePlayHelp;
  const canManageControls = session.status === "ready";
  const [restrictions, setRestrictions] = useState<z.infer<typeof RestrictionsSchema> | null>(null);
  const [limitType, setLimitType] = useState<LimitType>("daily_wager_limit");
  const [amount, setAmount] = useState("");
  const [breakReview, setBreakReview] = useState<{
    type: "self_exclusion" | "cooling_off";
    durationDays: number;
    label: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amountInput = useRef<HTMLInputElement>(null);
  const [amountError, setAmountError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (session.status !== "ready") return;
    setError(null);
    const response = await authenticatedFetch("/api/funds/responsible-play");
    if (!response.ok) throw new Error("Responsible-play controls are unavailable.");
    setRestrictions(RestrictionsSchema.parse(await response.json()));
  }, [session.status]);

  useEffect(() => {
    if (!canManageControls) return;
    void refresh().catch((reason) => setError(describe(reason)));
  }, [canManageControls, refresh]);

  const restrict = useCallback(async (
    type: "self_exclusion" | "cooling_off" | LimitType,
    durationDays?: number,
  ) => {
    if (session.status !== "ready") return;
    const isLimit = LimitTypeSchema.safeParse(type).success;
    if (isLimit) {
      const validationError = limitAmountError(amount);
      if (validationError) {
        setAmountError(validationError);
        amountInput.current?.focus();
        return;
      }
      setAmountError(null);
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = isLimit ? { type, amount } : { type, durationDays };
      const response = await authenticatedFetch("/api/funds/responsible-play/restrict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await responseError(response, "The restriction could not be applied.");
      const updated = RestrictionsSchema.parse(await response.json());
      setRestrictions(updated);
      if (!isLimit) setBreakReview(null);
      if (isLimit && updated.limitChange && !updated.limitChange.appliedImmediately) {
        setNotice(`The higher limit takes effect after the 24-hour delay, at ${dateTime(updated.limitChange.effectiveAt ?? "")}.`);
      } else {
        setNotice(isLimit
          ? "The new limit is active now."
          : "The break is active now for deposits and cash-game wagers.");
      }
      if (isLimit) setAmount("");
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  }, [amount, session.status]);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="font-display text-3xl">Responsible play</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          Set breaks and money limits when you need them. You can review these protections and get help without signing in.
        </p>
      </header>

      <section className="rounded-lg border p-5" aria-labelledby="responsible-play-protections">
        <h2 id="responsible-play-protections" className="font-semibold">How protections work</h2>
        <dl className="mt-3 space-y-3 text-sm text-[var(--color-text-secondary)]">
          <div>
            <dt className="font-medium text-[var(--color-text-primary)]">Breaks take effect immediately</dt>
            <dd className="mt-1">Cooling-off and self-exclusion block deposits and new cash-game wagers for the selected period. A break cannot be shortened after it starts.</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--color-text-primary)]">Limits protect against overspending</dt>
            <dd className="mt-1">A first or lower configured cap is active immediately. Raising a cap takes effect only after a 24-hour delay.</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--color-text-primary)]">Your access to records and recovery remains available</dt>
            <dd className="mt-1">These controls do not block cash-outs, refunds, settlements, game records, or free play.</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border p-5" aria-labelledby="responsible-play-help">
        <h2 id="responsible-play-help" className="font-semibold">Help and complaints</h2>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          If play is causing harm, take a break and contact support for help or to make a complaint.
        </p>
        <Link href="/support" className="mt-3 inline-block min-h-11 rounded border px-4 py-2 text-sm font-medium">
          Open support and complaints
        </Link>
        {funds.status === "ready" && help ? (
          <p className="mt-4 text-sm text-[var(--color-text-secondary)]">
            <a href={help.url} target="_blank" rel="noreferrer" className="underline">{help.name}</a>{" "}
            (version {help.version}, expires {dateTime(help.expiresAt)}; <code className="break-all">{help.sha256}</code>)
          </p>
        ) : funds.status === "loading" ? (
          <p className="mt-4 text-sm text-[var(--color-text-secondary)]">Checking whether external responsible-play help is configured.</p>
        ) : funds.status === "unavailable" ? (
          <p className="mt-4 text-sm text-[var(--color-text-secondary)]">External responsible-play help could not be loaded. Support remains available, and free play is unaffected.</p>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-text-secondary)]">No external responsible-play help contact is currently configured. Support remains available, and free play is unaffected; production money-feature availability is controlled by backend configuration.</p>
        )}
      </section>

      {session.status === "disconnected" ? (
        <section className="rounded-lg border p-5" aria-labelledby="manage-responsible-play">
          <h2 id="manage-responsible-play" className="font-semibold">Manage your controls</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            Connect the wallet that owns your account to review or change its restrictions.
          </p>
          <Link href="/login" className="mt-3 inline-block min-h-11 rounded border px-4 py-2 text-sm font-medium">
            Connect wallet
          </Link>
        </section>
      ) : session.status === "authorizing" ? (
        <section className="rounded-lg border p-5" aria-labelledby="manage-responsible-play">
          <h2 id="manage-responsible-play" className="font-semibold">Authorizing wallet</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            Confirming the connected wallet&apos;s secure session. Your controls will be available when authorization finishes.
          </p>
        </section>
      ) : session.status === "error" ? (
        <section className="rounded-lg border p-5" aria-labelledby="manage-responsible-play">
          <h2 id="manage-responsible-play" className="font-semibold">Wallet authorization needs attention</h2>
          <p role="alert" className="mt-2 text-sm text-[var(--color-text-secondary)]">{session.error}</p>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">No responsible-play control was changed. Retry authorization, or log out to use a different wallet.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" onClick={session.retry} className="min-h-11 rounded border px-4 py-2 text-sm font-medium">Retry authorization</button>
            <button type="button" onClick={() => { void logout(); }} className="min-h-11 rounded border px-4 py-2 text-sm font-medium">Log out or change wallet</button>
          </div>
        </section>
      ) : (
        <>
          <section className="rounded-lg border p-5" aria-labelledby="current-restrictions">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="current-restrictions" className="font-semibold">Configured caps and restrictions</h2>
              <button
                type="button"
                onClick={() => void refresh().catch((reason) => setError(describe(reason)))}
                className="min-h-11 rounded border px-4 py-2 text-sm"
              >
                Refresh
              </button>
            </div>
            {restrictions ? (
              <div className="mt-4 space-y-4 text-sm">
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-[var(--color-text-muted)]">Self-exclusion</dt>
                    <dd>{restrictions.selfExcludedUntil ? `Until ${dateTime(restrictions.selfExcludedUntil)}` : "Not active"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)]">Cooling-off</dt>
                    <dd>{restrictions.coolingOffUntil ? `Until ${dateTime(restrictions.coolingOffUntil)}` : "Not active"}</dd>
                  </div>
                </dl>
                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="rounded border p-3" aria-label="24-hour deposit cap">
                    <p className="font-medium">24-hour deposit cap</p>
                    <dl className="mt-2 grid gap-1">
                      <div><dt className="text-[var(--color-text-muted)]">Configured cap</dt><dd>{configuredCap(restrictions.depositLimitMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Authoritative used</dt><dd>{money(restrictions.activity24h?.depositsMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Remaining</dt><dd>{remaining(restrictions.depositLimitMicroUsd, restrictions.activity24h?.depositsMicroUsd ?? "0")}</dd></div>
                    </dl>
                  </section>
                  <section className="rounded border p-3" aria-label="Per-game wager cap">
                    <p className="font-medium">Per-game wager cap</p>
                    <dl className="mt-2 grid gap-1">
                      <div><dt className="text-[var(--color-text-muted)]">Configured cap</dt><dd>{configuredCap(restrictions.wagerLimitMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Authoritative used</dt><dd>Not applicable — this cap is evaluated for each new game.</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Remaining for the next game</dt><dd>{configuredCap(restrictions.wagerLimitMicroUsd)}</dd></div>
                    </dl>
                  </section>
                  <section className="rounded border p-3" aria-label="24-hour wager cap">
                    <p className="font-medium">24-hour wager cap</p>
                    <dl className="mt-2 grid gap-1">
                      <div><dt className="text-[var(--color-text-muted)]">Configured cap</dt><dd>{configuredCap(restrictions.dailyWagerLimitMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Authoritative used</dt><dd>{money(restrictions.activity24h?.wagerCommitmentsMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Remaining</dt><dd>{remaining(restrictions.dailyWagerLimitMicroUsd, restrictions.activity24h?.wagerCommitmentsMicroUsd ?? "0")}</dd></div>
                    </dl>
                  </section>
                  <section className="rounded border p-3" aria-label="24-hour loss cap">
                    <p className="font-medium">24-hour loss cap</p>
                    <dl className="mt-2 grid gap-1">
                      <div><dt className="text-[var(--color-text-muted)]">Configured cap</dt><dd>{configuredCap(restrictions.dailyLossLimitMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Authoritative used</dt><dd>{money(restrictions.activity24h?.realizedLossesMicroUsd)}</dd></div>
                      <div><dt className="text-[var(--color-text-muted)]">Remaining</dt><dd>{remaining(restrictions.dailyLossLimitMicroUsd, restrictions.activity24h?.realizedLossesMicroUsd ?? "0")}</dd></div>
                    </dl>
                  </section>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--color-text-secondary)]">Loading controls…</p>
            )}
            {restrictions?.pendingIncrease && (
              <p className="mt-4 rounded border border-amber-600/50 bg-amber-600/10 p-3 text-sm">
                Pending: {limitLabels[restrictions.pendingIncrease.type]} configured cap increases to{" "}
                {money(restrictions.pendingIncrease.amountMicroUsd)} at{" "}
                {dateTime(restrictions.pendingIncrease.effectiveAt)}.
              </p>
            )}
          </section>

          <div aria-live="polite" aria-atomic="true">
            {notice && <p className="rounded border border-emerald-700/50 bg-emerald-700/10 p-3 text-sm">{notice}</p>}
            {error && <p role="alert" className="rounded border border-red-700/50 bg-red-700/10 p-3 text-sm">{error}</p>}
          </div>

          <section className="space-y-4 rounded-lg border p-5" aria-labelledby="take-a-break">
            <div>
              <h2 id="take-a-break" className="font-semibold">Take a break</h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                A break cannot be shortened after it starts.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" disabled={busy} onClick={() => setBreakReview({ type: "cooling_off", durationDays: 1, label: "1-day cooling-off" })} className="min-h-11 rounded border px-4 py-2 disabled:opacity-50">
                1-day cooling-off
              </button>
              <button type="button" disabled={busy} onClick={() => setBreakReview({ type: "cooling_off", durationDays: 7, label: "7-day cooling-off" })} className="min-h-11 rounded border px-4 py-2 disabled:opacity-50">
                7-day cooling-off
              </button>
              <button type="button" disabled={busy} onClick={() => setBreakReview({ type: "self_exclusion", durationDays: 30, label: "30-day self-exclusion" })} className="min-h-11 rounded border border-red-700/60 px-4 py-2 text-[var(--color-danger)] disabled:opacity-50">
                30-day self-exclusion
              </button>
              <button type="button" disabled={busy} onClick={() => setBreakReview({ type: "self_exclusion", durationDays: 365, label: "1-year self-exclusion" })} className="min-h-11 rounded border border-red-700/60 px-4 py-2 text-[var(--color-danger)] disabled:opacity-50">
                1-year self-exclusion
              </button>
            </div>
            {breakReview && (
              <div className="rounded-lg border-2 border-[var(--color-danger)] bg-red-700/10 p-4" role="region" aria-labelledby="confirm-break-title">
                <h3 id="confirm-break-title" className="font-semibold">Confirm {breakReview.label}</h3>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                  This starts immediately and cannot be shortened. Deposits and new cash-game wagers will be blocked; free play, records, refunds, settlements, and cash-outs remain available.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restrict(breakReview.type, breakReview.durationDays)}
                    className="min-h-11 rounded bg-[var(--color-danger)] px-4 py-2 font-semibold text-white disabled:opacity-50"
                  >
                    {busy ? "Applying…" : `Confirm ${breakReview.label}`}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setBreakReview(null)} className="min-h-11 rounded border px-4 py-2 disabled:opacity-50">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-4 rounded-lg border p-5" aria-labelledby="set-money-limit">
            <div>
              <h2 id="set-money-limit" className="font-semibold">Set a configured money cap</h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                Amounts are shown as $X.XX; verUSD is the matching asset denomination. A lower limit or first limit is immediate. Increasing a limit takes effect after 24 hours.
              </p>
            </div>
            <label className="grid gap-1 text-sm" htmlFor="limit-type">
              Configured cap
              <select
                id="limit-type"
                value={limitType}
                onChange={(event) => setLimitType(LimitTypeSchema.parse(event.target.value))}
                className="min-h-11 rounded border bg-[var(--color-surface)] px-3 py-2"
              >
                {LimitTypeSchema.options.map((type) => (
                  <option key={type} value={type}>{limitLabels[type]}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm" htmlFor="limit-amount">
              Configured cap in US dollars
              <input
                ref={amountInput}
                id="limit-amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  const value = event.target.value;
                  setAmount(value);
                  setAmountError(value ? limitAmountError(value) : null);
                }}
                onBlur={() => setAmountError(limitAmountError(amount))}
                placeholder="0.00"
                autoComplete="off"
                aria-invalid={Boolean(amountError)}
                aria-describedby="limit-amount-help limit-amount-error"
                className="min-h-11 rounded border bg-transparent px-3 py-2"
              />
              <span id="limit-amount-help" className="text-xs text-[var(--color-text-muted)]">
                Enter a canonical nonnegative dollar amount in whole cents, for example 0.00.
              </span>
              <span id="limit-amount-error" role={amountError ? "alert" : undefined} className="text-xs text-[var(--color-danger)]">
                {amountError}
              </span>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restrict(limitType)}
              className="min-h-11 w-full rounded border px-4 py-2 font-medium disabled:opacity-50 sm:w-auto"
            >
              {busy ? "Applying…" : "Apply configured cap"}
            </button>
          </section>
        </>
      )}
    </main>
  );
}
