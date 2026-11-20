"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/api";

const SUPPORT_TOPICS = [
  { value: "account_access", label: "Account access" },
  { value: "payment", label: "Payment problem" },
  { value: "missing_deposit", label: "Missing deposit" },
  { value: "returned_payment", label: "Returned payment" },
  { value: "failed_cash_out", label: "Failed cash-out" },
  { value: "incorrect_settlement", label: "Incorrect game settlement" },
  { value: "location_error", label: "Location or eligibility error" },
  { value: "responsible_play", label: "Responsible-play help" },
] as const;

type SupportTopic = typeof SUPPORT_TOPICS[number]["value"];

interface CreatedCase {
  id: string;
  state: string;
  createdAt: string;
}

function emailValidationError(value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) return "Enter a contact email address.";
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(trimmedValue)) {
    return "Enter a valid contact email address.";
  }
  return "";
}

function descriptionValidationError(value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) return "Describe what happened and the outcome you expect.";
  if (trimmedValue.length < 20) return "Describe what happened in at least 20 characters.";
  if (trimmedValue.length > 5_000) return "Keep your description to 5,000 characters or fewer.";
  return "";
}

export default function SupportPage() {
  const [reference, setReference] = useState("");
  const [category, setCategory] = useState<SupportTopic>("account_access");
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState({ email: "", description: "" });
  const emailInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedCase | null>(null);
  const [existingCases, setExistingCases] = useState<CreatedCase[]>([]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setReference(params.get("reference")?.slice(0, 128) ?? "");
    const requestedCategory = params.get("category");
    if (SUPPORT_TOPICS.some((topic) => topic.value === requestedCategory)) {
      setCategory(requestedCategory as SupportTopic);
    }
    const storedCaseIds = Object.keys(window.localStorage)
      .filter((key) => key.startsWith("gammon-support:"))
      .map((key) => key.slice("gammon-support:".length));
    void Promise.all(storedCaseIds.map(async (id) => {
      const token = window.localStorage.getItem(`gammon-support:${id}`);
      if (!token) return null;
      const response = await fetch(`${API_BASE}/api/support/cases/${encodeURIComponent(id)}`, {
        credentials: "omit",
        headers: { "x-support-token": token },
      });
      if (!response.ok) return null;
      const body = await response.json() as { supportCase?: CreatedCase };
      return body.supportCase ?? null;
    })).then((cases) => setExistingCases(cases.filter((supportCase): supportCase is CreatedCase => supportCase !== null)));
  }, []);

  const mailHref = useMemo(() => {
    const subject = reference ? `Gammon support — ${reference}` : "Gammon support request";
    return `mailto:support@burnt.com?subject=${encodeURIComponent(subject)}`;
  }, [reference]);

  async function submitCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFieldErrors = {
      email: emailValidationError(email),
      description: descriptionValidationError(description),
    };

    setFieldErrors(nextFieldErrors);
    setError("");
    setCreated(null);
    if (nextFieldErrors.email || nextFieldErrors.description) {
      (nextFieldErrors.email ? emailInputRef : descriptionInputRef).current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE}/api/support/cases/public`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          contactEmail: email,
          description: description.trim(),
          reference: reference || null,
        }),
      });
      const body = await response.json() as {
        supportCase?: CreatedCase;
        accessToken?: string;
        error?: string;
      };
      if (!response.ok || !body.supportCase || !body.accessToken) {
        throw new Error(body.error === "invalid_support_case" ? "Check the form fields and try again." : "Support is temporarily unavailable.");
      }
      setExistingCases((cases) => [body.supportCase!, ...cases.filter((supportCase) => supportCase.id !== body.supportCase!.id)]);
      window.localStorage.setItem(`gammon-support:${body.supportCase.id}`, body.accessToken);
      setCreated(body.supportCase);
      setDescription("");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      setError(
        message === "Check the form fields and try again."
          ? message
          : "Support is temporarily unavailable. Try again or use the email link below.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl space-y-6 p-6 text-[var(--color-text-primary)]">
      <header>
        <h1 className="font-display text-3xl">Support and complaints</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
          Submit a durable case with an operation, game, transfer, or settlement reference. Never send a seed phrase,
          private key, password, government-document number, or full bank-account number.
        </p>
      </header>

      {created && (
        <section role="status" className="rounded-lg border border-[var(--color-success)] bg-green-700/10 p-5">
          <h2 className="font-semibold">Case submitted</h2>
          <p className="mt-2 text-sm">Reference <code className="break-all">{created.id}</code></p>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Status: {created.state}. Save this reference; your private status credential is stored only in this browser.
          </p>
        </section>
      )}
      {existingCases.length > 0 && (
        <section aria-labelledby="existing-support-cases" className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
          <h2 id="existing-support-cases" className="text-xl font-semibold">Cases saved in this browser</h2>
          <ul className="mt-3 space-y-2">
            {existingCases.map((supportCase) => (
              <li key={supportCase.id} className="rounded border border-[var(--color-border-subtle)] p-3 text-sm">
                <code className="break-all">{supportCase.id}</code>
                <span className="ml-2 font-semibold">{supportCase.state}</span>
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  Opened {new Date(supportCase.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="support-form-heading" className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
        <h2 id="support-form-heading" className="text-xl font-semibold">Open a case</h2>
        <form className="mt-4 space-y-4" onSubmit={submitCase} noValidate>
          <div>
            <label htmlFor="support-category" className="block text-sm font-semibold">Topic</label>
            <select id="support-category" value={category} onChange={(event) => setCategory(event.target.value as SupportTopic)} className="mt-1 min-h-11 w-full rounded border bg-transparent px-3">
              {SUPPORT_TOPICS.map((topic) => <option key={topic.value} value={topic.value}>{topic.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="support-email" className="block text-sm font-semibold">Contact email</label>
            <input
              ref={emailInputRef}
              id="support-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => {
                const value = event.target.value;
                setEmail(value);
                if (fieldErrors.email && !emailValidationError(value)) {
                  setFieldErrors((errors) => ({ ...errors, email: "" }));
                }
              }}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby="support-email-error"
              className="mt-1 min-h-11 w-full rounded border bg-transparent px-3"
            />
            <p id="support-email-error" role="alert" className={fieldErrors.email ? "mt-1 text-xs text-[var(--color-danger)]" : "sr-only"}>{fieldErrors.email}</p>
          </div>
          <div>
            <label htmlFor="support-reference-input" className="block text-sm font-semibold">Game or operation reference <span className="font-normal">(optional)</span></label>
            <input id="support-reference-input" maxLength={128} value={reference} onChange={(event) => setReference(event.target.value)} className="mt-1 min-h-11 w-full rounded border bg-transparent px-3 font-mono" />
          </div>
          <div>
            <label htmlFor="support-description" className="block text-sm font-semibold">What happened and what outcome do you expect?</label>
            <textarea
              ref={descriptionInputRef}
              id="support-description"
              minLength={20}
              maxLength={5000}
              required
              value={description}
              onChange={(event) => {
                const value = event.target.value;
                setDescription(value);
                if (fieldErrors.description && !descriptionValidationError(value)) {
                  setFieldErrors((errors) => ({ ...errors, description: "" }));
                }
              }}
              aria-invalid={Boolean(fieldErrors.description)}
              aria-describedby="support-description-help support-description-error"
              className="mt-1 min-h-36 w-full rounded border bg-transparent p-3"
            />
            <p id="support-description-help" className="mt-1 text-xs text-[var(--color-text-muted)]">20–5,000 characters. Do not include sensitive credentials.</p>
            <p id="support-description-error" role="alert" className={fieldErrors.description ? "mt-1 text-xs text-[var(--color-danger)]" : "sr-only"}>{fieldErrors.description}</p>
          </div>
          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary min-h-11 disabled:opacity-60">
            {submitting ? "Submitting…" : "Submit case"}
          </button>
        </form>
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          If the form is unavailable, <a className="underline" href={mailHref}>email support</a>.
        </p>
      </section>

      <section aria-labelledby="support-responsible" className="rounded-lg border border-[var(--color-border-subtle)] p-5">
        <h2 id="support-responsible" className="text-xl font-semibold">Responsible-play help</h2>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          Cooling-off, self-exclusion, and spending restrictions are available from the responsible-play hub.
        </p>
        <Link className="mt-3 inline-block underline" href="/responsible-play">Open responsible-play controls</Link>
      </section>

      <nav aria-label="Legal links" className="flex flex-wrap gap-4 text-sm">
        <Link className="underline" href="/terms">Terms of Service</Link>
        <Link className="underline" href="/privacy">Privacy Policy</Link>
        <Link className="underline" href="/login">Back to Gammon</Link>
      </nav>
    </main>
  );
}
