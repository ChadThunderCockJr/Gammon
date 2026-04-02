"use client";

import { useState, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useBalance } from "@/hooks/useBalance";
import { API_BASE } from "@/lib/api";

type Tab = "deposit" | "withdraw";
type FlowStep = "idle" | "linking" | "amount" | "processing" | "done" | "error";

export default function WalletPage() {
  const { address, isConnected } = useAuth();
  const { balance, refetch } = useBalance();
  const [tab, setTab] = useState<Tab>("deposit");
  const [step, setStep] = useState<FlowStep>("idle");
  const [amount, setAmount] = useState("");
  const [bankAddressId, setBankAddressId] = useState<string | null>(null);
  const [transferId, setTransferId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startPlaidLink = useCallback(async () => {
    setStep("linking");
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/brale/plaid-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uri: window.location.href }),
      });
      if (!res.ok) throw new Error("Failed to create Plaid link");
      const { linkToken } = await res.json();

      // Load Plaid Link SDK dynamically
      const Plaid = await import("react-plaid-link").catch(() => null);
      if (!Plaid) {
        // Fallback: open Plaid in a new window (for environments without the SDK)
        window.open(`https://cdn.plaid.com/link/v2/stable/link.html?token=${linkToken}`, "_blank");
        setStep("amount");
        return;
      }

      // The Plaid Link component will be handled by the UI below
      // For now, store the link token and move to amount step
      setStep("amount");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect bank");
      setStep("error");
    }
  }, []);

  const submitDeposit = useCallback(async () => {
    if (!address || !amount) return;
    setStep("processing");
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/brale/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankAddressId,
          walletAddress: address,
          amount,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Deposit failed");
      }
      const transfer = await res.json();
      setTransferId(transfer.id);
      setStep("done");
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deposit failed");
      setStep("error");
    }
  }, [address, amount, bankAddressId, refetch]);

  const submitWithdraw = useCallback(async () => {
    if (!amount || !bankAddressId) return;
    setStep("processing");
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/brale/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankAddressId, amount, sameDay: false }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Withdrawal failed");
      }
      const transfer = await res.json();
      setTransferId(transfer.id);
      setStep("done");
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdrawal failed");
      setStep("error");
    }
  }, [amount, bankAddressId, refetch]);

  const reset = () => {
    setStep("idle");
    setAmount("");
    setError(null);
    setTransferId(null);
  };

  if (!isConnected) {
    return (
      <div style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "1.5rem", color: "var(--color-text-primary)" }}>
          Wallet
        </h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: 12 }}>Connect your wallet to manage funds.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 600, margin: "0 auto" }}>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "1.5rem", color: "var(--color-text-primary)", marginBottom: 8 }}>
        Wallet
      </h1>

      {/* Balance display */}
      <div style={{
        background: "var(--color-bg-surface)",
        borderRadius: "var(--radius-card)",
        padding: "20px 24px",
        boxShadow: "var(--shadow-card)",
        marginBottom: 24,
        textAlign: "center",
      }}>
        <div style={{ fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-muted)", marginBottom: 4 }}>
          Available Balance
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "2rem", color: "var(--color-text-primary)" }}>
          ${balance || "0.00"}
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--color-text-faint)", marginTop: 4 }}>USDC</div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderRadius: "var(--radius-button)", overflow: "hidden", border: "1px solid var(--color-border-subtle)" }}>
        {(["deposit", "withdraw"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); reset(); }}
            style={{
              flex: 1,
              padding: "10px 0",
              fontFamily: "var(--font-body)",
              fontSize: "0.8125rem",
              fontWeight: 500,
              textTransform: "capitalize",
              border: "none",
              cursor: "pointer",
              background: tab === t ? "var(--color-gold-primary)" : "var(--color-bg-surface)",
              color: tab === t ? "var(--color-accent-fg)" : "var(--color-text-secondary)",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Flow content */}
      <div style={{
        background: "var(--color-bg-surface)",
        borderRadius: "var(--radius-card)",
        padding: 24,
        boxShadow: "var(--shadow-card)",
      }}>
        {step === "idle" && (
          <>
            <p style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem", marginBottom: 16 }}>
              {tab === "deposit"
                ? "Connect your bank account to deposit USD. Funds are converted to USDC on XION."
                : "Withdraw USDC to your linked bank account via ACH."}
            </p>
            <button
              onClick={startPlaidLink}
              style={{
                width: "100%",
                padding: "12px 0",
                fontFamily: "var(--font-body)",
                fontSize: "0.875rem",
                fontWeight: 500,
                borderRadius: "var(--radius-button)",
                background: "var(--color-gold-primary)",
                color: "var(--color-accent-fg)",
                border: "none",
                cursor: "pointer",
              }}
            >
              Connect Bank Account
            </button>
          </>
        )}

        {step === "linking" && (
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", textAlign: "center", padding: "24px 0" }}>
            Opening bank connection...
          </p>
        )}

        {step === "amount" && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: 4 }}>
                Amount (USD)
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  fontFamily: "var(--font-body)",
                  fontSize: "1.25rem",
                  borderRadius: "var(--radius-button)",
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border-subtle)",
                  color: "var(--color-text-primary)",
                  outline: "none",
                  textAlign: "center",
                }}
              />
              {tab === "deposit" && (
                <p style={{ fontSize: "0.6875rem", color: "var(--color-text-faint)", marginTop: 4, textAlign: "center" }}>
                  ACH limit: $50,000 per transaction
                </p>
              )}
            </div>
            <button
              onClick={tab === "deposit" ? submitDeposit : submitWithdraw}
              disabled={!amount || parseFloat(amount) <= 0}
              style={{
                width: "100%",
                padding: "12px 0",
                fontFamily: "var(--font-body)",
                fontSize: "0.875rem",
                fontWeight: 500,
                borderRadius: "var(--radius-button)",
                background: amount && parseFloat(amount) > 0 ? "var(--color-gold-primary)" : "var(--color-bg-elevated)",
                color: amount && parseFloat(amount) > 0 ? "var(--color-accent-fg)" : "var(--color-text-muted)",
                border: "none",
                cursor: amount && parseFloat(amount) > 0 ? "pointer" : "default",
              }}
            >
              {tab === "deposit" ? "Deposit" : "Withdraw"} ${amount || "0.00"}
            </button>
          </>
        )}

        {step === "processing" && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <p style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem" }}>
              {tab === "deposit" ? "Processing deposit..." : "Processing withdrawal..."}
            </p>
            <p style={{ color: "var(--color-text-faint)", fontSize: "0.75rem", marginTop: 8 }}>
              ACH transfers typically take 1-3 business days.
            </p>
          </div>
        )}

        {step === "done" && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ color: "var(--color-analysis-gold)", fontSize: "2rem", marginBottom: 8 }}>✓</div>
            <p style={{ color: "var(--color-text-primary)", fontSize: "0.9375rem", fontWeight: 500 }}>
              {tab === "deposit" ? "Deposit initiated" : "Withdrawal initiated"}
            </p>
            <p style={{ color: "var(--color-text-muted)", fontSize: "0.8125rem", marginTop: 8 }}>
              ${amount} USD · ACH transfer pending
            </p>
            {transferId && (
              <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.6875rem", color: "var(--color-text-faint)", marginTop: 8 }}>
                Transfer ID: {transferId}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                marginTop: 16,
                padding: "8px 24px",
                fontFamily: "var(--font-body)",
                fontSize: "0.8125rem",
                borderRadius: "var(--radius-button)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-text-primary)",
                border: "1px solid var(--color-border-subtle)",
                cursor: "pointer",
              }}
            >
              Done
            </button>
          </div>
        )}

        {step === "error" && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ color: "var(--color-danger)", fontSize: "2rem", marginBottom: 8 }}>✕</div>
            <p style={{ color: "var(--color-text-primary)", fontSize: "0.875rem" }}>{error}</p>
            <button
              onClick={reset}
              style={{
                marginTop: 16,
                padding: "8px 24px",
                fontFamily: "var(--font-body)",
                fontSize: "0.8125rem",
                borderRadius: "var(--radius-button)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-text-primary)",
                border: "1px solid var(--color-border-subtle)",
                cursor: "pointer",
              }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
