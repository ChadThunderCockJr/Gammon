"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAbstraxionSigningClient } from "@burnt-labs/abstraxion";
import { formatMicroUsd } from "@xion-beginner/backgammon-core";
import Link from "next/link";
import { z } from "zod";
import { useAuth } from "@/hooks/useAuth";
import { useBalance } from "@/hooks/useBalance";
import { useFundsConfig } from "@/hooks/useFundsConfig";
import { useServerSession } from "@/hooks/useServerSession";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";
import { authenticatedFetch, financeAuthorizedFetch } from "@/lib/server-session";
import { loadPlaidLink, type PlaidLinkHandler } from "@/lib/plaid-link";
import { canonicalIdentity, firstIdentityError, identityFields as validationIdentityFields, validateIdentity, type IdentityErrors, type IdentityField, type IdentityValues } from "./validation";
import { fundsLabel, safeMoneyFailure, unavailableMoneyMessage, usdCentsError, usdToMicroUsd } from "../cash-action-safety";
import { BalanceDisclosure } from "../cash-quote-disclosure";
const OperationSchema = z.object({ id: z.string().uuid(), state: z.string(), kind: z.string() }).passthrough();
const OperationResponseSchema = z.object({ operation: OperationSchema, result: z.unknown().nullable().optional() });
const MethodSchema = z.object({ id: z.string(), displayLabel: z.string(), state: z.string() }).passthrough();
const WalletSchema = z.object({
  profile: z.object({ status: z.string(), internalWalletAddress: z.string().min(1).optional() }).nullable(),
  paymentMethods: z.array(MethodSchema),
  operations: z.array(OperationSchema),
}).passthrough();
const LinkResultSchema = z.object({ linkToken: z.string().min(1) });
const CashOutSchema = z.object({
  operation: OperationSchema,
  fundingInstruction: z.object({
    from: z.string(),
    to: z.string(),
    denom: z.string(),
    amountMicroUsd: z.string().regex(/^\d+$/),
    displayAmount: z.string().regex(/^\$\d+\.\d{2}$/),
    contract: z.string(),
    messageKey: z.literal("authorize_finance_action"),
    operationId: z.string().uuid(),
    destination: z.string(),
    expiresAt: z.number().int().positive(),
    signature: z.string().min(1),
  }),
});
const CashOutStartSchema = z.union([
  CashOutSchema.extend({ resumed: z.boolean().optional() }),
  z.object({ operation: OperationSchema, recovered: z.literal(true) }),
]);
const ActiveCashOutSchema = z.object({
  error: z.literal("cash_out_intent_active"),
  operation: OperationSchema,
  expiresAt: z.number().int().positive(),
});
const TxResultSchema = z.object({ transactionHash: z.string().regex(/^[0-9A-Fa-f]{64}$/) });
const PendingCashOutConfirmationSchema = z.object({
  principal: z.string().min(1),
  operationId: z.string().uuid(),
  txHash: z.string().regex(/^[0-9A-Fa-f]{64}$/).nullable(),
});
const PENDING_CASH_OUT_CONFIRMATION_KEY = "gammon.pendingCashOutConfirmation.v1";

type Identity = IdentityValues;
type LegalDocuments = {
  braleEua: { url: string; version: string; sha256: string };
  plaidPrivacy: { url: string; version: string; sha256: string };
  achAuthorization: { url: string; version: string; sha256: string };
};



const emptyIdentity: Identity = { firstName: "", lastName: "", dateOfBirth: "", email: "", phoneNumber: "", country: "US", streetLine1: "", city: "", state: "", postalCode: "", documentNumber: "", documentType: "drivers_license" };

function idempotencyHeaders(): HeadersInit { return { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }; }
function errorMessage(action: "deposit" | "cash_out" | "wager", error: unknown): string {
  console.error(`Money ${action} action failed`, error);
  return safeMoneyFailure(action);
}

function ProviderDocumentLinks({ documents }: { documents: LegalDocuments }) {
  return (
    <>
      <a className="underline" href={documents.braleEua.url} target="_blank" rel="noreferrer">Brale EUA v{documents.braleEua.version}</a>
      {" "}(<code>{documents.braleEua.sha256}</code>),{" "}
      <a className="underline" href={documents.plaidPrivacy.url} target="_blank" rel="noreferrer">Plaid Privacy v{documents.plaidPrivacy.version}</a>
      {" "}(<code>{documents.plaidPrivacy.sha256}</code>), and{" "}
      <a className="underline" href={documents.achAuthorization.url} target="_blank" rel="noreferrer">ACH Authorization v{documents.achAuthorization.version}</a>
      {" "}(<code>{documents.achAuthorization.sha256}</code>)
    </>
  );
}

export default function WalletPage() {
  const isNativeApp = useIsNativeApp();
  if (isNativeApp) {
    return (
      <main className="mx-auto max-w-2xl space-y-5 p-6">
        <h1 className="font-display text-3xl">Balance</h1>
        <section className="rounded-lg border border-[var(--color-border-subtle)] p-6">
          <h2 className="text-xl font-semibold">Money features are unavailable in the app</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            The native app supports free play only. It cannot link a bank, add money, cash out, or open a cash game.
          </p>
          <Link href="/create-match" className="btn-primary mt-4 inline-flex min-h-11 items-center">
            Play a free match
          </Link>
        </section>
      </main>
    );
  }
  return <WalletWebPage />;
}

function WalletWebPage() {
  const { address, isConnected, logout } = useAuth();
  const { client } = useAbstraxionSigningClient();
  const session = useServerSession();
  const funds = useFundsConfig();
  const balance = useBalance();
  const [wallet, setWallet] = useState<z.infer<typeof WalletSchema> | null>(null);
  const [identity, setIdentity] = useState<Identity>(emptyIdentity);
  const [enrollmentAccepted, setEnrollmentAccepted] = useState(false);
  const [bankLinkAccepted, setBankLinkAccepted] = useState(false);
  const [reviewAccepted, setReviewAccepted] = useState(false);
  const [cashOutTransferAccepted, setCashOutTransferAccepted] = useState(false);
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [cashOut, setCashOut] = useState<z.infer<typeof CashOutSchema>["fundingInstruction"] | null>(null);
  const [cashOutTxHash, setCashOutTxHash] = useState<string | null>(null);
  const [cashOutRecoveryPending, setCashOutRecoveryPending] = useState(false);
  const [reviewAction, setReviewAction] = useState<"deposit" | "cash_out" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const methodInput = useRef<HTMLSelectElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [identityErrors, setIdentityErrors] = useState<IdentityErrors>({});
  const identityInputs = useRef<Partial<Record<IdentityField, HTMLInputElement | HTMLSelectElement | null>>>({});
  const selectedMethod = wallet?.paymentMethods.find((method) => method.id === methodId && method.state === "active") ?? null;
  const cashOutDestination = wallet?.profile?.internalWalletAddress ?? null;
  const plaidHandler = useRef<PlaidLinkHandler | null>(null);
  const [plaidReady, setPlaidReady] = useState(false);

  const versions = funds.config?.legalVersions;
  const configuredDocuments = funds.config?.legalDocuments;
  const legalDocuments: LegalDocuments | null = configuredDocuments?.braleEua && configuredDocuments.plaidPrivacy && configuredDocuments.achAuthorization
    ? configuredDocuments as LegalDocuments
    : null;
  const legalConfigReady = Boolean(
    versions?.terms
    && versions.privacy
    && versions.responsiblePlay
    && legalDocuments,
  );
  const relevantBlockers = funds.status === "ready"
    ? [...funds.config.actionBlockers.deposit, ...funds.config.actionBlockers.cash_out]
    : [];
  const moneyEnabled = funds.status === "ready"
    && funds.config.entryEnabled
    && Boolean(funds.config.attestedAt)
    && (funds.config.depositEnabled || funds.config.cashOutEnabled)
    && relevantBlockers.length === 0
    && legalConfigReady
    && session.status === "ready";
  const buildConsent = useCallback((purpose: "enroll" | "link_bank" | "deposit" | "cash_out", reviewedContext: Record<string, string | boolean>) => {
    if (!versions?.terms || !versions.privacy || !legalDocuments) return null;
    return {
      acceptedAt: new Date().toISOString(),
      purpose,
      reviewedContext,
      termsVersion: versions.terms,
      privacyVersion: versions.privacy,
      braleEuaVersion: legalDocuments.braleEua.version,
      plaidPrivacyVersion: legalDocuments.plaidPrivacy.version,
      achAuthorizationVersion: legalDocuments.achAuthorization.version,
      legalDocuments,
    };
  }, [legalDocuments, versions]);

  useEffect(() => {
    setCashOutTxHash(null);
    setCashOutRecoveryPending(false);
    if (!address) return;
    let stored: unknown = null;
    try {
      stored = JSON.parse(window.localStorage.getItem(PENDING_CASH_OUT_CONFIRMATION_KEY) ?? "null");
    } catch {
      window.localStorage.removeItem(PENDING_CASH_OUT_CONFIRMATION_KEY);
      return;
    }
    const recovered = PendingCashOutConfirmationSchema.safeParse(stored);
    if (!recovered.success) {
      window.localStorage.removeItem(PENDING_CASH_OUT_CONFIRMATION_KEY);
      return;
    }
    if (recovered.data.principal !== address) return;
    setOperationId(recovered.data.operationId);
    setCashOutTxHash(recovered.data.txHash?.toUpperCase() ?? null);
    setCashOutRecoveryPending(true);
    setNotice(recovered.data.txHash
      ? "An on-chain cash-out transfer is awaiting server verification. Retrying verification will not send it again."
      : "A cash-out submission had an uncertain response. Retrying asks the server to find the exact operation on-chain and will not send funds again.");
  }, [address]);
  const refreshWallet = useCallback(async () => {
    if (session.status !== "ready") return;
    const response = await authenticatedFetch("/api/funds/wallet");
    if (!response.ok) throw new Error("Wallet details are unavailable");
    const next = WalletSchema.parse(await response.json());
    setWallet(next);
    if (!next.paymentMethods.some((method) => method.id === methodId && method.state === "active")) {
      setMethodId(next.paymentMethods.find((method) => method.state === "active")?.id ?? "");
    }
  }, [methodId, session.status]);

  useEffect(() => { void refreshWallet().catch((error) => { console.error("Wallet refresh failed", error); setFailure("Wallet details are unavailable. No money action was submitted."); }); }, [refreshWallet]);
  const hasPendingBank = wallet?.paymentMethods.some((method) => method.state === "pending") ?? false;
  useEffect(() => {
    if (!hasPendingBank || session.status !== "ready") return;
    const timer = window.setInterval(() => {
      void refreshWallet().catch((error) => console.error("Bank verification refresh failed", error));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [hasPendingBank, refreshWallet, session.status]);

  useEffect(() => {
    if (!operationId || session.status !== "ready") return;
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const response = await authenticatedFetch(`/api/funds/operations/${operationId}`);
        if (!response.ok) throw new Error("Could not refresh money operation");
        const operation = OperationResponseSchema.parse(await response.json());
        if (disposed) return;
        if (operation.operation.state === "failed" || operation.operation.state === "canceled") {
          setFailure("A money operation did not complete. No balance change has been assumed; review its durable Activity record.");
          window.localStorage.removeItem(PENDING_CASH_OUT_CONFIRMATION_KEY);
          setCashOutTxHash(null);
          setCashOutRecoveryPending(false);
          setOperationId(null);
          return;
        }
        const link = LinkResultSchema.safeParse(operation.result);
        if (link.success) setLinkToken(link.data.linkToken);
        if (operation.operation.state === "complete") {
          setNotice("Money operation completed. Review its durable receipt in Activity.");
          window.localStorage.removeItem(PENDING_CASH_OUT_CONFIRMATION_KEY);
          setCashOutTxHash(null);
          setCashOutRecoveryPending(false);
          setOperationId(null);
          setLinkToken(null);
          await refreshWallet();
          await balance.refetch();
          return;
        }
        timer = window.setTimeout(() => { void poll(); }, 2_000);
      } catch (error) {
        if (!disposed) { console.error("Money operation refresh failed", error); setFailure("Money status is temporarily unavailable. No new action was submitted."); }
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
  }, [balance.refetch, operationId, refreshWallet, session.status]);

  const validateIdentityFields = useCallback((fields: readonly IdentityField[]): Identity | null => {
    const errors = validateIdentity(identity, fields);
    setIdentityErrors(errors);
    const invalidField = firstIdentityError(errors, fields);
    if (invalidField) {
      setFailure("Correct the highlighted field before submitting.");
      identityInputs.current[invalidField]?.focus();
      return null;
    }
    const normalized = canonicalIdentity(identity);
    setIdentity(normalized);
    return normalized;
  }, [identity]);

  const onPlaidSuccess = useCallback(async (publicToken: string) => {
    // The public token is one-time; tear down the handler before sending it.
    plaidHandler.current?.destroy();
    plaidHandler.current = null;
    setLinkToken(null);
    const consent = buildConsent("link_bank", { providerLinkCompleted: true });
    if (!consent || !bankLinkAccepted) { setFailure("Review and accept the bank-link completion disclosure before this account can be submitted."); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await financeAuthorizedFetch("/api/funds/wallet/link-bank/complete", "link_bank", { method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({ publicToken, consent }) });
      if (!response.ok) throw new Error("bank-link completion rejected");
      const created = z.object({ operation: OperationSchema }).parse(await response.json());
      setOperationId(created.operation.id);
      setNotice("Bank account submitted for verification.");
    } catch (error) { console.error("Bank-link completion failed", error); setFailure("The bank account could not be securely linked. No account was added."); }
    finally { setBusy(false); }
  }, [bankLinkAccepted, buildConsent]);
  useEffect(() => {
    if (!linkToken) {
      plaidHandler.current?.destroy();
      plaidHandler.current = null;
      setPlaidReady(false);
      return;
    }
    let disposed = false;
    void loadPlaidLink()
      .then((plaid) => {
        if (disposed) return;
        plaidHandler.current = plaid.create({
          token: linkToken,
          onSuccess: (publicToken) => { void onPlaidSuccess(publicToken); },
          onExit: (reason) => { if (reason) setFailure("Bank linking was canceled or could not be completed."); },
        });
        setPlaidReady(true);
      })
      .catch(() => {
        if (!disposed) setFailure("The secure bank-link provider could not load.");
      });
    return () => {
      disposed = true;
      plaidHandler.current?.destroy();
      plaidHandler.current = null;
      setPlaidReady(false);
    };
  }, [linkToken, onPlaidSuccess]);
  const enroll = useCallback(async () => {
    const normalizedIdentity = validateIdentityFields(validationIdentityFields);
    if (!normalizedIdentity) return;
    const consent = buildConsent("enroll", { walletAddress: address ?? "" });
    if (!address || !consent || !enrollmentAccepted) { setFailure("Review and accept the enrollment disclosures before submitting verification."); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await financeAuthorizedFetch("/api/funds/wallet/enroll", "enroll", {
        method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({
          walletAddress: address,
          consent,
          identity: {
            firstName: normalizedIdentity.firstName, lastName: normalizedIdentity.lastName, dateOfBirth: normalizedIdentity.dateOfBirth, email: normalizedIdentity.email, phoneNumber: normalizedIdentity.phoneNumber, country: normalizedIdentity.country,
            address: { streetLine1: normalizedIdentity.streetLine1, city: normalizedIdentity.city, state: normalizedIdentity.state, postalCode: normalizedIdentity.postalCode },
            identity: { number: normalizedIdentity.documentNumber, type: normalizedIdentity.documentType },
          },
        }),
      });
      if (!response.ok) throw new Error("enrollment response rejected");
      const created = z.object({ operation: OperationSchema }).parse(await response.json());
      setOperationId(created.operation.id);
      setNotice("Enrollment submitted. Status updates only after the provider confirms it.");
    } catch (error) { console.error("Enrollment failed", error); setFailure("Enrollment was not accepted. Check your details and eligibility; no money action was submitted."); }
    finally { setBusy(false); }
  }, [address, buildConsent, enrollmentAccepted, validateIdentityFields]);

  const requestBankLink = useCallback(async () => {
    const normalizedIdentity = validateIdentityFields(["firstName", "lastName", "dateOfBirth", "email"]);
    if (!normalizedIdentity) return;
    const legalName = `${normalizedIdentity.firstName} ${normalizedIdentity.lastName}`;
    const consent = buildConsent("link_bank", { identitySubmitted: true });
    if (!consent || !bankLinkAccepted) { setFailure("Review and accept the bank-link disclosures before opening the secure provider flow."); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await financeAuthorizedFetch("/api/funds/wallet/link-token", "link_token", { method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({ legalName, emailAddress: normalizedIdentity.email, dateOfBirth: normalizedIdentity.dateOfBirth, consent }) });
      if (!response.ok) throw new Error("bank-link response rejected");
      const created = z.object({ operation: OperationSchema, linkToken: z.string().min(1).nullable() }).parse(await response.json());
      if (!created.linkToken) throw new Error("bank-link token was not delivered");
      setOperationId(created.operation.id);
      setLinkToken(created.linkToken);
      setNotice("Preparing a secure bank-link session.");
    } catch (error) { console.error("Bank-link session request failed", error); setFailure("Bank linking is unavailable for this account. No bank account was added."); }
    finally { setBusy(false); }
  }, [bankLinkAccepted, buildConsent, validateIdentityFields]);

  const deposit = useCallback(async () => {
    const amountMicroUsd = usdToMicroUsd(amount);
    const consent = buildConsent("deposit", { amountMicroUsd: amountMicroUsd ?? "", paymentMethodId: methodId });
    if (!methodId || !consent || !reviewAccepted || !amountMicroUsd) { setFailure("Review the exact deposit amount and selected bank account, then accept its disclosures."); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await financeAuthorizedFetch("/api/funds/deposits", "deposit", { method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({ amount, paymentMethodId: methodId, consent }) });
      if (!response.ok) throw new Error("deposit response rejected");
      const created = z.object({ operation: OperationSchema }).parse(await response.json());
      setOperationId(created.operation.id);
      setReviewAction(null);
      setReviewAccepted(false);
      setNotice("Deposit submitted. It remains pending until Brale and the chain confirm it.");
    } catch (error) { setFailure(errorMessage("deposit", error)); }
    finally { setBusy(false); }
  }, [amount, buildConsent, methodId, reviewAccepted]);

  const beginCashOut = useCallback(async () => {
    if (cashOutRecoveryPending) {
      setFailure("Finish verifying the existing on-chain cash-out transfer before starting another.");
      return;
    }
    const amountMicroUsd = usdToMicroUsd(amount);
    const consent = buildConsent("cash_out", { amountMicroUsd: amountMicroUsd ?? "", paymentMethodId: methodId, destination: cashOutDestination ?? "" });
    if (!methodId || !consent || !reviewAccepted || !amountMicroUsd || !selectedMethod || !cashOutDestination) { setFailure("Review the exact cash-out amount, bank destination, and custody address, then accept its disclosures."); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await financeAuthorizedFetch("/api/funds/cash-outs", "cash_out", { method: "POST", headers: idempotencyHeaders(), body: JSON.stringify({ amount, paymentMethodId: methodId, consent }) });
      if (response.status === 409) {
        const active = ActiveCashOutSchema.parse(await response.json());
        setOperationId(active.operation.id);
        setFailure(`An earlier cash-out intent is still active until ${new Date(active.expiresAt * 1_000).toLocaleString()}. It will be canceled only after the chain proves no transfer succeeded.`);
        return;
      }
      if (!response.ok) throw new Error("cash-out response rejected");
      const created = CashOutStartSchema.parse(await response.json());
      window.localStorage.removeItem(PENDING_CASH_OUT_CONFIRMATION_KEY);
      setCashOutTxHash(null);
      setCashOutRecoveryPending(false);
      setOperationId(created.operation.id);
      if ("recovered" in created) {
        setCashOut(null);
        setReviewAction(null);
        setReviewAccepted(false);
        setNotice("A previously submitted on-chain cash-out was recovered. Provider settlement is pending; review its durable Activity receipt.");
        return;
      }
      setCashOut(created.fundingInstruction);
      setReviewAction(null);
      setReviewAccepted(false);
      setNotice(created.resumed
        ? "Resumed the one existing cash-out intent. Review and authorize its exact verUSD transfer below."
        : "Review the exact verUSD transfer below. The bank transfer cannot begin until its on-chain confirmation succeeds.");
    } catch (error) {
      setFailure(errorMessage("cash_out", error));
    } finally {
      setBusy(false);
    }
  }, [amount, buildConsent, cashOutDestination, cashOutRecoveryPending, methodId, reviewAccepted, selectedMethod]);

  const confirmCashOut = useCallback(async () => {
    if (!operationId || !address) {
      setFailure("The cash-out operation or wallet session is unavailable.");
      return;
    }
    if (!cashOutRecoveryPending && (!cashOut || !cashOutTransferAccepted || !client)) {
      setFailure("Confirm the exact destination and amount before authorizing the on-chain transfer.");
      return;
    }
    if (
      !cashOutRecoveryPending
      && cashOut
      && (cashOut.operationId !== operationId || cashOut.expiresAt <= Math.floor(Date.now() / 1_000))
    ) {
      setFailure("This transfer authorization expired. Start a new cash-out intent before moving funds.");
      return;
    }
    setBusy(true); setFailure(null);
    let submittedHash = cashOutTxHash;
    let executionAttempted = false;
    try {
      if (!cashOutRecoveryPending && !submittedHash) {
        if (!cashOut || !client) throw new Error("cash-out authorization unavailable");
        executionAttempted = true;
        const result = TxResultSchema.parse(await client.execute(
          address,
          cashOut.contract,
          {
            authorize_finance_action: {
              operation_id: cashOut.operationId,
              destination: cashOut.destination,
              expires_at: cashOut.expiresAt,
              signature: cashOut.signature,
            },
          },
          "auto",
          undefined,
          [{ denom: cashOut.denom, amount: cashOut.amountMicroUsd }],
        ));
        submittedHash = result.transactionHash.toUpperCase();
        window.localStorage.setItem(PENDING_CASH_OUT_CONFIRMATION_KEY, JSON.stringify({
          principal: address,
          operationId,
          txHash: submittedHash,
        }));
        setCashOutTxHash(submittedHash);
        setCashOutRecoveryPending(true);
      }
      const response = await financeAuthorizedFetch(
        `/api/funds/cash-outs/${operationId}/confirm-transfer`,
        "cash_out_confirm",
        {
          method: "POST",
          headers: idempotencyHeaders(),
          body: JSON.stringify(submittedHash ? { txHash: submittedHash } : {}),
        },
      );
      if (!response.ok) throw new Error("cash-out confirmation rejected");
      window.localStorage.removeItem(PENDING_CASH_OUT_CONFIRMATION_KEY);
      setCashOutTxHash(null);
      setCashOutRecoveryPending(false);
      setNotice("The restricted on-chain transfer was confirmed. Provider settlement is pending.");
      setCashOut(null); setCashOutTransferAccepted(false);
    } catch (error) {
      if (executionAttempted || cashOutRecoveryPending || submittedHash) {
        if (!submittedHash) {
          window.localStorage.setItem(PENDING_CASH_OUT_CONFIRMATION_KEY, JSON.stringify({
            principal: address,
            operationId,
            txHash: null,
          }));
        }
        setCashOutRecoveryPending(true);
        console.error("Cash-out verification failed after a possible chain submission", error);
        setFailure(submittedHash
          ? "The on-chain transfer may already be final. Retry verification below; Gammon will reuse the saved transaction and will not send funds again."
          : "The wallet response was uncertain. Retry verification below; Gammon will search for this exact operation on-chain and will not send funds again.");
      } else {
        setFailure(errorMessage("cash_out", error));
      }
    } finally { setBusy(false); }
  }, [address, cashOut, cashOutRecoveryPending, cashOutTransferAccepted, cashOutTxHash, client, operationId]);

  const updateIdentity = (field: IdentityField, value: string) => {
    setIdentity((current) => ({ ...current, [field]: value }));
    setIdentityErrors((current) => ({ ...current, [field]: undefined }));
    setEnrollmentAccepted(false);
    setBankLinkAccepted(false);
  };
  const deploymentMessage = funds.status === "loading"
    ? "Money-feature availability is loading. No money action can be taken until this deployment confirms it."
    : funds.status === "unavailable"
      ? "Money-feature availability could not be loaded. No money action can be taken."
      : unavailableMoneyMessage();
  const amountError = usdCentsError(amount);
  const validAmount = amountError === null;
  const openReview = (action: "deposit" | "cash_out") => {
    setFailure(null);
    if (action === "cash_out" && cashOutRecoveryPending) {
      setFailure("Finish verifying the existing on-chain cash-out transfer before starting another.");
      return;
    }
    if (!validAmount) {
      setFailure(amountError ?? "Enter a valid amount before reviewing this action.");
      amountInput.current?.focus();
      return;
    }
    if (!selectedMethod) {
      setFailure("Select a verified bank account before reviewing this action.");
      methodInput.current?.focus();
      return;
    }
    if (action === "cash_out" && !cashOutDestination) {
      setFailure("The approved cash-out custody address is unavailable. No cash-out can be started.");
      return;
    }
    setReviewAccepted(false);
    setReviewAction(action);
  };

  if (!isConnected || session.status === "disconnected") {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="font-display text-3xl">Balance</h1>
        <p className="mt-2 text-[var(--color-text-secondary)]">Connect a wallet to review money features. Free play does not require a deposit.</p>
      </main>
    );
  }

  if (session.status === "authorizing") {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="font-display text-3xl">Authorizing wallet</h1>
        <p className="mt-2 text-[var(--color-text-secondary)]">Confirming the connected wallet&apos;s secure session. Money features remain locked until authorization finishes.</p>
      </main>
    );
  }

  if (session.status === "error") {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="font-display text-3xl">Wallet authorization needs attention</h1>
        <p role="alert" className="text-[var(--color-text-secondary)]">{session.error}</p>
        <p className="text-sm text-[var(--color-text-secondary)]">No money action was submitted. Retry authorization, or log out to use a different wallet.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-primary min-h-11" onClick={session.retry}>Retry authorization</button>
          <button type="button" className="btn-secondary min-h-11" onClick={() => { void logout(); }}>Log out or change wallet</button>
        </div>
      </main>
    );
  }

  const identityFields: Array<[IdentityField, string, string]> = [
    ["firstName", "First name", "given-name"],
    ["lastName", "Last name", "family-name"],
    ["dateOfBirth", "Date of birth", "bday"],
    ["email", "Email", "email"],
    ["phoneNumber", "Phone", "tel"],
    ["streetLine1", "Street address", "address-line1"],
    ["city", "City", "address-level2"],
    ["state", "State or region", "address-level1"],
    ["postalCode", "Postal code", "postal-code"],
    ["country", "Country code", "country"],
    ["documentNumber", "Identity document number", "off"],
  ];

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6" aria-live="polite">
      <header>
        <h1 className="font-display text-3xl">Balance</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          Available, committed, and pending funds are separate. An operation is not final until its durable status is complete.
        </p>
      </header>

      {funds.status === "ready" && funds.config.testFunds && (
        <p className="rounded border border-[var(--color-warning)] p-3 font-semibold text-[var(--color-warning)]">
          TEST FUNDS ONLY — balances, quotes, and receipts have no cash value and do not represent real bank movement.
        </p>
      )}

      <section className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide">On-chain balance</h2>
        {balance.status === "fresh" || balance.status === "stale" ? (
          <>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{funds.status === "ready" ? fundsLabel(funds.config.testFunds) : "verUSD balance"}</p>
            <BalanceDisclosure
              id="how-your-balance-works"
              available={balance.available}
              committed={balance.committed}
              pending={balance.pending}
              observedAt={balance.observedAt}
              stale={balance.status === "stale"}
              custody={<>Available and pending verUSD are wallet-token balances on Xion. Committed verUSD is held in the Xion escrow contract for active cash-game reserves.</>}
            />
            <button className="mt-3 min-h-11 underline" onClick={() => void balance.refetch()}>Refresh balance</button>
          </>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            {balance.status === "loading" ? "Reading the authoritative chain balance…" : "Balance unavailable. It is not shown as zero, and money actions are disabled."}
          </p>
        )}
      </section>

      {cashOutRecoveryPending && operationId && !cashOut && (
        <section className="space-y-3 rounded-lg border-2 border-[var(--color-gold-primary)] bg-[var(--color-bg-surface)] p-5" aria-labelledby="cash-out-recovery-title">
          <h2 id="cash-out-recovery-title" className="text-xl font-semibold">Resume cash-out verification</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {cashOutTxHash
              ? "The wallet already submitted this restricted transfer. Gammon saved its transaction hash before contacting the server."
              : "The wallet response was uncertain. Gammon will search the chain for this exact signed operation before doing anything else."}
            {" "}Retrying verification will not send funds again.
          </p>
          {cashOutTxHash && <p className="break-all font-mono text-xs">{cashOutTxHash}</p>}
          <p className="break-all text-xs text-[var(--color-text-secondary)]">Operation <span className="font-mono">{operationId}</span></p>
          <Link className="inline-block min-h-11 content-center underline" href={`/activity?operation=${encodeURIComponent(operationId)}`}>
            View durable activity receipt
          </Link>
          <button disabled={busy} onClick={() => void confirmCashOut()} className="btn-primary min-h-11 disabled:opacity-50">
            {busy ? "Verifying…" : cashOutTxHash ? "Retry saved transfer verification" : "Search for submitted transfer"}
          </button>
        </section>
      )}

      {funds.status !== "ready" || (!moneyEnabled && !cashOut) ? (
        <section className="rounded-lg border border-[var(--color-warning)] bg-[var(--color-bg-surface)] p-5">
          <h2 className="font-semibold">{funds.status === "ready" ? "Money features unavailable on this deployment" : "Money features unavailable"}</h2>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{deploymentMessage}</p>
          {funds.status === "unavailable" && (
            <button type="button" className="btn-secondary mt-3 min-h-11" onClick={funds.refresh}>Retry availability check</button>
          )}
        </section>
      ) : (
        <>
          {notice && <p className="rounded border border-[var(--color-success)] p-3 text-sm">{notice}</p>}
          {failure && <p role="alert" className="rounded border border-[var(--color-danger)] p-3 text-sm">{failure}</p>}
          {operationId && (
            <p className="rounded border border-[var(--color-info)] p-3 text-sm">
              Operation pending. <Link className="underline" href={`/activity?operation=${encodeURIComponent(operationId)}`}>Open durable status</Link>.
            </p>
          )}

          {!wallet ? (
            <p role="status">Loading payment profile…</p>
          ) : !wallet.profile ? (
            <section className="space-y-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
              <h2 className="text-xl font-semibold">Verify your account</h2>
              <p className="text-sm text-[var(--color-text-secondary)]">
                Identity details are encrypted and submitted to Brale for eligibility and payment compliance after consent. Gammon retains the provider status and references required for operations and support. Do not enter this information on a shared device.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {identityFields.map(([field, label, autoComplete]) => {
                  const error = identityErrors[field];
                  return (
                    <label key={field} className="grid gap-1 text-sm">
                      {label}
                      <input
                        ref={(element) => { identityInputs.current[field] = element; }}
                        type={field === "dateOfBirth" ? "date" : field === "email" ? "email" : field === "phoneNumber" ? "tel" : "text"}
                        value={identity[field]}
                        onChange={(event) => updateIdentity(field, event.target.value)}
                        className="input"
                        autoComplete={autoComplete}
                        required
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? `identity-${field}-error` : undefined}
                      />
                      {error && <span id={`identity-${field}-error`} role="alert" className="text-xs text-[var(--color-danger)]">{error}</span>}
                    </label>
                  );
                })}
                <label className="grid gap-1 text-sm">
                  Identity document type
                  <select
                    ref={(element) => { identityInputs.current.documentType = element; }}
                    value={identity.documentType}
                    onChange={(event) => updateIdentity("documentType", event.target.value)}
                    className="input"
                    aria-invalid={Boolean(identityErrors.documentType)}
                    aria-describedby={identityErrors.documentType ? "identity-documentType-error" : undefined}
                  >
                    <option value="drivers_license">Driver&apos;s license</option>
                    <option value="passport">Passport</option>
                  </select>
                  {identityErrors.documentType && <span id="identity-documentType-error" role="alert" className="text-xs text-[var(--color-danger)]">{identityErrors.documentType}</span>}
                </label>
              </div>
              <label className="flex items-start gap-3 text-sm">
                <input className="mt-1 h-5 w-5" type="checkbox" checked={enrollmentAccepted} onChange={(event) => setEnrollmentAccepted(event.target.checked)} />
                <span>I authorize submitting these identity details to Brale for this enrollment and eligibility review after reviewing {legalDocuments ? <ProviderDocumentLinks documents={legalDocuments} /> : "the required provider documents"}. This acceptance applies only to this enrollment submission and resets if these details change.</span>
              </label>
              <button disabled={busy || !enrollmentAccepted} onClick={() => void enroll()} className="btn-primary min-h-11 disabled:opacity-50">
                {busy ? "Submitting…" : "Submit verification enrollment"}
              </button>
            </section>
          ) : wallet.profile.status !== "active" ? (
            <section className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
              <h2 className="font-semibold">Verification in progress</h2>
              <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                Money actions stay disabled until the regulated provider reports an active profile. Refreshing this page resumes the durable server state.
              </p>
              <Link className="mt-3 inline-block underline" href="/activity">View activity or report a problem</Link>
            </section>
          ) : (
            <>
              <section className="space-y-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
                <div>
                  <h2 className="font-semibold">Linked bank accounts</h2>
                  <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                    Plaid collects bank credentials in its secured flow. Gammon receives a provider token and safe account label, not your bank password.
                  </p>
                </div>
                {wallet.paymentMethods.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {wallet.paymentMethods.map((method) => <li key={method.id} className="rounded border border-[var(--color-border-subtle)] p-3">{method.displayLabel} · {method.state === "active" ? "verified" : method.state.replaceAll("_", " ")}</li>)}
                  </ul>
                ) : (
                  <p className="text-sm text-[var(--color-text-secondary)]">No verified bank account.</p>
                )}
                {linkToken ? (
                  <div>
                    <p className="text-sm text-[var(--color-text-secondary)]">The secure provider session is ready. Closing it does not link an account or create a transfer.</p>
                    <button disabled={!plaidReady || busy || !moneyEnabled} onClick={() => plaidHandler.current?.open()} className="btn-primary mt-3 min-h-11 disabled:opacity-50">Open secure bank link</button>
                  </div>
                ) : (
                  <>
                    <fieldset className="grid gap-3 sm:grid-cols-2">
                      <legend className="mb-2 text-sm font-semibold">Details shared with Plaid to create the link session</legend>
                      {(["firstName", "lastName", "dateOfBirth", "email"] as const).map((field) => {
                        const error = identityErrors[field];
                        return (
                          <label key={field} className="grid gap-1 text-sm">
                            {{ firstName: "First name", lastName: "Last name", dateOfBirth: "Date of birth", email: "Email" }[field]}
                            <input
                              ref={(element) => { identityInputs.current[field] = element; }}
                              type={field === "dateOfBirth" ? "date" : field === "email" ? "email" : "text"}
                              value={identity[field]}
                              onChange={(event) => updateIdentity(field, event.target.value)}
                              className="input"
                              autoComplete={{ firstName: "given-name", lastName: "family-name", dateOfBirth: "bday", email: "email" }[field]}
                              aria-invalid={Boolean(error)}
                              aria-describedby={error ? `identity-${field}-error` : undefined}
                            />
                            {error && <span id={`identity-${field}-error`} role="alert" className="text-xs text-[var(--color-danger)]">{error}</span>}
                          </label>
                        );
                      })}
                    </fieldset>
                    <label className="flex items-start gap-3 text-sm">
                      <input className="mt-1 h-5 w-5" type="checkbox" checked={bankLinkAccepted} onChange={(event) => setBankLinkAccepted(event.target.checked)} />
                      <span>I authorize sharing the displayed name, date of birth, and email to open and complete one secure bank-link session after reviewing {legalDocuments ? <ProviderDocumentLinks documents={legalDocuments} /> : "the required provider documents"}. This does not authorize a transfer and resets if these details change.</span>
                    </label>
                    <button disabled={busy || !bankLinkAccepted || !moneyEnabled} onClick={() => void requestBankLink()} className="btn-secondary min-h-11 disabled:opacity-50">Open bank-link session</button>
                  </>
                )}
              </section>

              <section className="space-y-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-5">
                <div>
                  <h2 className="font-semibold">Add money or cash out</h2>
                  <p className="mt-1 text-sm text-[var(--color-text-secondary)]">verUSD is a dollar-denominated token on Xion, not a bank deposit and not represented here as insured cash.</p>
                </div>
                <label className="grid gap-1 text-sm">
                  Verified bank account
                  <select
                    ref={methodInput}
                    value={methodId}
                    onChange={(event) => {
                      setMethodId(event.target.value);
                      setReviewAction(null);
                      setReviewAccepted(false);
                    }}
                    className="input"
                    aria-invalid={!methodId}
                    aria-describedby={!methodId ? "method-error" : undefined}
                  >
                    <option value="">Select an account</option>
                    {wallet.paymentMethods.filter((method) => method.state === "active").map((method) => <option key={method.id} value={method.id}>{method.displayLabel}</option>)}
                  </select>
                  {!methodId && <span id="method-error" role="alert" className="text-xs text-[var(--color-danger)]">Choose a verified bank account.</span>}
                </label>
                <label className="grid gap-1 text-sm">
                  Dollar amount
                  <input
                    ref={amountInput}
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setReviewAction(null);
                      setReviewAccepted(false);
                    }}
                    placeholder="0.00"
                    className="input"
                    aria-invalid={Boolean(amountError)}
                    aria-describedby={amountError ? "amount-help amount-error" : "amount-help"}
                  />
                  <span id="amount-help" className="text-xs text-[var(--color-text-muted)]">Enter a canonical positive dollar amount in whole cents. Deployment and eligibility limits are checked before submission.</span>
                  {amountError && <span id="amount-error" role="alert" className="text-xs text-[var(--color-danger)]">{amountError}</span>}
                </label>
                <div className="flex flex-wrap gap-3">
                  <button disabled={busy || !moneyEnabled || !funds.config.depositEnabled} onClick={() => openReview("deposit")} className="btn-primary min-h-11 disabled:opacity-50">Review add money</button>
                  <button disabled={busy || !moneyEnabled || !funds.config.cashOutEnabled} onClick={() => openReview("cash_out")} className="btn-secondary min-h-11 disabled:opacity-50">Review cash-out</button>
                </div>
              </section>

              {reviewAction && selectedMethod && (
                <section className="space-y-4 rounded-lg border-2 border-[var(--color-gold-primary)] bg-[var(--color-bg-surface)] p-5" aria-labelledby="transfer-review-title">
                  <h2 id="transfer-review-title" className="text-xl font-semibold">{reviewAction === "deposit" ? "Review add money" : "Review cash-out"}</h2>
                  {funds.config.testFunds && <p className="rounded border border-[var(--color-warning)] p-3 text-sm font-semibold text-[var(--color-warning)]">TEST FUNDS ONLY — this review and any resulting balance or receipt have no cash value and do not represent real bank movement.</p>}
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div><dt className="text-[var(--color-text-muted)]">{reviewAction === "deposit" ? "Bank debit" : "Cash-out amount"}</dt><dd className="font-semibold">${amount}</dd><dd className="text-xs text-[var(--color-text-secondary)]">{reviewAction === "deposit" ? "Converted to verUSD after provider and chain confirmation" : "Equivalent verUSD must reach Brale custody before bank settlement"}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">Gammon transfer fee</dt><dd className="font-semibold">$0.00</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">{reviewAction === "deposit" ? "Wallet credit" : "Bank credit requested"}</dt><dd className="font-semibold">${amount}</dd><dd className="text-xs text-[var(--color-text-secondary)]">{reviewAction === "deposit" ? "verUSD remains pending until confirmed" : "Bank settlement follows verified verUSD custody"}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">{reviewAction === "deposit" ? "Debit source" : "Bank credit destination"}</dt><dd>{selectedMethod.displayLabel}</dd></div>
                    {reviewAction === "cash_out" && <div><dt className="text-[var(--color-text-muted)]">verUSD custody destination</dt><dd className="break-all font-mono">{cashOutDestination}</dd></div>}
                    <div><dt className="text-[var(--color-text-muted)]">Rail</dt><dd>{reviewAction === "deposit" ? "ACH debit → Brale → Xion verUSD" : "Xion verUSD → Brale custody address → selected bank"}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">Arrival estimate</dt><dd>No guaranteed ETA supplied; track the durable provider status.</dd></div>
                  </dl>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    {reviewAction === "deposit"
                      ? "The amount is not available for play until Brale and the chain report completion. ACH returns can reverse a previously completed credit."
                      : "Starting creates a durable intent only. You must next send the exact verUSD amount to Brale’s displayed address; the bank transfer begins only after final on-chain verification."}
                  </p>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    No separate provider or bank fee is quoted by this deployment. Cancel if the provider presents a different total. Submission is not promised to be cancelable; failures and returns remain visible in Activity.
                  </p>
                  <BalanceDisclosure
                    available={balance.available}
                    committed={balance.committed}
                    pending={balance.pending}
                    observedAt={balance.observedAt}
                    stale={balance.status === "stale"}
                    custody={reviewAction === "deposit"
                      ? <>Brale handles the ACH debit. verUSD becomes a wallet-token balance on Xion only after provider and chain confirmation.</>
                      : <>You must send the exact verUSD amount from your Xion wallet to Brale&apos;s displayed custody address before Brale can begin bank settlement.</>}
                  />
                  <label className="flex items-start gap-3 text-sm">
                    <input className="mt-1 h-5 w-5" type="checkbox" checked={reviewAccepted} onChange={(event) => setReviewAccepted(event.target.checked)} />
                    <span>I authorize this exact {reviewAction === "deposit" ? `ACH debit of $${amount} from` : `cash-out of $${amount} to`} {selectedMethod.displayLabel}{reviewAction === "cash_out" ? ` after exactly $${amount} verUSD reaches custody address ${cashOutDestination}` : ""} using {fundsLabel(funds.config.testFunds)} after reviewing {legalDocuments ? <ProviderDocumentLinks documents={legalDocuments} /> : "the required provider documents"}. This acceptance is only for this reviewed action and resets if its amount or account changes.</span>
                  </label>
                  <div className="flex gap-3">
                    <button className="btn-secondary min-h-11 flex-1" onClick={() => { setReviewAction(null); setReviewAccepted(false); }}>Back</button>
                    <button
                      className="btn-primary min-h-11 flex-1 disabled:opacity-50"
                      disabled={busy || !moneyEnabled || !reviewAccepted || balance.status !== "fresh"}
                      onClick={() => void (reviewAction === "deposit" ? deposit() : beginCashOut())}
                    >
                      {busy ? "Submitting…" : reviewAction === "deposit" ? `Authorize $${amount} debit` : `Create $${amount} cash-out`}
                    </button>
                  </div>
                  {balance.status !== "fresh" && <p role="alert" className="text-sm text-[var(--color-danger)]">A fresh authoritative balance is required before final authorization.</p>}
                </section>
              )}

              {cashOut && (
                <section className="space-y-3 rounded-lg border-2 border-[var(--color-gold-primary)] bg-[var(--color-bg-surface)] p-5">
                  <h2 className="text-xl font-semibold">Fund the cash-out intent</h2>
                  <p className="font-semibold">Dollar cash-out amount: {formatMicroUsd(BigInt(cashOut.amountMicroUsd))}.</p>
                  <p className="text-sm text-[var(--color-text-secondary)]">Authorize exactly {cashOut.displayAmount} verUSD ({fundsLabel(funds.config.testFunds)}). The restricted router accepts only this server-signed operation, amount, destination, and short expiry.</p>
                  <dl className="grid gap-2 break-all text-sm">
                    <div><dt className="text-[var(--color-text-muted)]">From</dt><dd className="font-mono">{cashOut.from}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">Destination custodian</dt><dd className="font-mono">Brale · {cashOut.to}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">Restricted router</dt><dd className="font-mono">{cashOut.contract}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">Denom</dt><dd className="font-mono">{cashOut.denom}</dd></div>
                    <div><dt className="text-[var(--color-text-muted)]">Exact micro-units</dt><dd className="font-mono">{cashOut.amountMicroUsd}</dd></div>
                  </dl>
                  <BalanceDisclosure
                    available={balance.available}
                    committed={balance.committed}
                    pending={balance.pending}
                    observedAt={balance.observedAt}
                    stale={balance.status === "stale"}
                    custody={<>This transfer sends verUSD from your Xion wallet to Brale&apos;s displayed custody address. Brale begins bank settlement only after final on-chain verification.</>}
                  />
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    Authorization expires at {new Date(cashOut.expiresAt * 1_000).toLocaleString()}. No general bank-send permission is requested.
                  </p>
                  {cashOutRecoveryPending ? (
                    <>
                      <p role="status" className="text-sm text-[var(--color-text-secondary)]">
                        {cashOutTxHash
                          ? <>This transaction was already submitted: <span className="break-all font-mono">{cashOutTxHash}</span>.</>
                          : <>The wallet response was uncertain. Gammon will search the chain for this exact signed operation.</>}
                        {" "}Retrying will not send funds again.
                      </p>
                      {operationId && (
                        <Link className="inline-block min-h-11 content-center underline" href={`/activity?operation=${encodeURIComponent(operationId)}`}>
                          View operation {operationId} in Activity
                        </Link>
                      )}
                    </>
                  ) : (
                    <label className="flex items-start gap-3 text-sm">
                      <input className="mt-1 h-5 w-5" type="checkbox" checked={cashOutTransferAccepted} onChange={(event) => setCashOutTransferAccepted(event.target.checked)} />
                      <span>I confirm sending the dollar-equivalent {formatMicroUsd(BigInt(cashOut.amountMicroUsd))}: exactly {cashOut.displayAmount} {cashOut.denom} from {cashOut.from} to Brale at {cashOut.to} for this cash-out after reviewing {legalDocuments ? <ProviderDocumentLinks documents={legalDocuments} /> : "the required provider documents"}.</span>
                    </label>
                  )}
                  <button
                    disabled={busy || (!cashOutRecoveryPending && (!client || !cashOutTransferAccepted || cashOut.expiresAt <= Math.floor(Date.now() / 1_000)))}
                    onClick={() => void confirmCashOut()}
                    className="btn-primary min-h-11 disabled:opacity-50"
                  >
                    {busy ? (cashOutRecoveryPending ? "Verifying…" : "Authorizing…") : cashOutRecoveryPending ? (cashOutTxHash ? "Retry saved transfer verification" : "Search for submitted transfer") : "Authorize and verify exact transfer"}
                  </button>
                </section>
              )}
            </>
          )}

          <nav className="flex flex-wrap gap-4 text-sm" aria-label="Money support">
            <Link className="underline" href="/activity">Activity and receipts</Link>
            <Link className="underline" href="/responsible-play">Responsible-play controls</Link>
            <Link className="underline" href="/support?category=payment">Report a payment problem</Link>
          </nav>
        </>
      )}
    </main>
  );
}
