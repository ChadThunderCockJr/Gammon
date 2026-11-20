"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, SectionLabel, SegmentToggle } from "@/components/ui";
import { useSocialContext } from "@/contexts/SocialContext";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";

// ─── Constants ─────────────────────────────────────────────────────
const BOARD_THEMES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "lux", label: "Lux" },
];


// ─── Icons ─────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-success)" strokeWidth="2">
      <path d="M3 8.5l3.5 3.5L13 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 014.5 2H11" strokeLinecap="round" />
    </svg>
  );
}


// ═══════════════════════════════════════════════════════════════════
// MAIN — SETTINGS PAGE
// ═══════════════════════════════════════════════════════════════════
export default function SettingsPage() {
  const router = useRouter();
  const { address, logout } = useAuth();
  const social = useSocialContext();

  const { theme, setTheme } = useTheme();
  const [displayName, setDisplayName] = useState("");
  const [pendingDisplayName, setPendingDisplayName] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const handleReplayTutorial = useCallback(() => {
    try {
      localStorage.removeItem("gammon-tutorial-completed");
    } catch {
      // ignore
    }
    router.push("/");
  }, [router]);

  // Sync display name from social context
  useEffect(() => {
    if (social.displayName) {
      setDisplayName(social.displayName);
    }
  }, [social.displayName]);

  useEffect(() => {
    if (!pendingDisplayName || social.displayName !== pendingDisplayName) return;
    setPendingDisplayName(null);
    setSaved(true);
  }, [pendingDisplayName, social.displayName]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (!pendingDisplayName) return;
    const timer = window.setTimeout(() => {
      setPendingDisplayName(null);
      setSettingsError("The display name was not confirmed. Check your connection and try again.");
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [pendingDisplayName]);

  const handleSaveDisplayName = useCallback(() => {
    const trimmed = displayName.trim();
    setSettingsError(null);
    if (!trimmed || trimmed.length > 50) {
      setSettingsError("Display names must contain 1–50 characters.");
      return;
    }
    if (!social.connected) {
      setSettingsError("Reconnect your wallet session before saving.");
      return;
    }
    if (trimmed === social.displayName) return;
    setPendingDisplayName(trimmed);
    social.setDisplayName(trimmed);
  }, [displayName, social]);

  const handleCopyAddress = useCallback(async () => {
    if (!address) return;
    setSettingsError(null);
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setSettingsError("The wallet address could not be copied. Select it and copy manually.");
    }
  }, [address]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      fontFamily: "var(--font-body)",
      color: "var(--color-text-primary)",
    }}>
      <main className="p-4 md:p-6 lg:px-6 lg:py-7" style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", overflow: "auto",
      }}>
        <div style={{ width: "100%", maxWidth: 640 }}>

          {/* Page Header */}
          <header style={{ marginBottom: 28 }}>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.875rem",
                fontWeight: 700,
                color: "var(--color-text-primary)",
                margin: 0,
              }}
            >
              Settings
            </h1>
            <p
              style={{
                fontSize: "0.875rem",
                color: "var(--color-text-muted)",
                margin: "4px 0 0",
                fontFamily: "var(--font-body)",
              }}
            >
              Manage your account and preferences
            </p>
          </header>

          {/* ═══ ACCOUNT ══════════════════════════════════════ */}
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Account</SectionLabel>

            {/* Address */}
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="settings-wallet-address"
                style={{
                  display: "block", fontSize: "0.6875rem", fontWeight: 600, color: "var(--color-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6,
                }}
              >
                Wallet address
              </label>
              <div id="settings-wallet-address" style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 14px", borderRadius: 6,
                border: "1.5px solid var(--color-border-subtle)", background: "var(--color-bg-base)",
              }}>
                <span style={{
                  flex: 1, fontSize: "0.8125rem", color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)", overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {address || "Not connected"}
                </span>
                <button
                  type="button"
                  disabled={!address}
                  onClick={handleCopyAddress}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: copied ? "var(--color-success)" : "var(--color-text-muted)",
                    display: "flex", alignItems: "center", gap: 4,
                    fontSize: "0.6875rem", fontWeight: 600, fontFamily: "var(--font-body)",
                    padding: "2px 6px", borderRadius: 4,
                    minHeight: 44,
                    transition: "color 0.15s ease",
                  }}
                >
                  {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
                </button>
              </div>
            </div>

            {/* Display Name */}
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="settings-display-name"
                style={{
                  display: "block", fontSize: "0.6875rem", fontWeight: 600, color: "var(--color-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6,
                }}
              >
                Display name
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  id="settings-display-name"
                  type="text"
                  value={displayName}
                  maxLength={50}
                  aria-invalid={Boolean(settingsError)}
                  aria-describedby={settingsError ? "settings-display-name-help settings-display-name-error" : "settings-display-name-help"}
                  placeholder="Enter a display name..."
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveDisplayName()}
                  style={{
                    flex: 1, padding: "10px 14px", borderRadius: 6,
                    border: "1.5px solid var(--color-border-subtle)", background: "var(--color-bg-base)",
                    fontSize: "0.875rem", fontWeight: 600, color: "var(--color-text-primary)", outline: "none",
                    fontFamily: "var(--font-body)",
                    boxSizing: "border-box",
                    minHeight: 44,
                    transition: "border-color 0.2s",
                  }}
                  onFocus={(e) => { e.target.style.borderColor = "var(--color-gold-primary)"; }}
                  onBlur={(e) => { e.target.style.borderColor = "var(--color-border-subtle)"; }}
                />
                <button
                  type="button"
                  onClick={handleSaveDisplayName}
                  disabled={Boolean(pendingDisplayName)}
                  style={{
                    padding: "10px 20px", borderRadius: 6,
                    border: "none",
                    background: saved ? "var(--color-success)" : "var(--color-gold-primary)",
                    color: "var(--color-accent-fg)",
                    fontSize: "0.8125rem", fontWeight: 700, cursor: pendingDisplayName ? "wait" : "pointer",
                    fontFamily: "var(--font-body)",
                    transition: "background 0.15s ease",
                    display: "flex", alignItems: "center", gap: 6,
                    flexShrink: 0,
                    minHeight: 44,
                  }}
                >
                  {saved ? <><CheckIcon /> Saved</> : pendingDisplayName ? "Saving…" : "Save"}
                </button>
              </div>
              <div id="settings-display-name-help" style={{
                fontSize: "0.6875rem", color: "var(--color-text-faint)", marginTop: 6,
              }}>
                This is how other players see you in friend lists and matches. {displayName.length}/50 characters.
                <span aria-live="polite">{saved ? " Display name saved." : pendingDisplayName ? " Saving display name." : ""}</span>
              </div>
              {settingsError && (
                <p id="settings-display-name-error" role="alert" style={{ color: "var(--color-danger)", fontSize: "0.75rem", margin: "8px 0 0" }}>
                  {settingsError}
                </p>
              )}
            </div>

            {/* Logout */}
            <div style={{
              paddingTop: 12, borderTop: "1px solid var(--color-border-subtle)",
            }}>
              <button
                onClick={logout}
                type="button"
                style={{
                  padding: "10px 20px", borderRadius: 6,
                  border: "1.5px solid var(--color-danger)",
                  background: "var(--color-danger-muted)",
                  color: "var(--color-danger)",
                  fontSize: "0.8125rem", fontWeight: 600, cursor: "pointer",
                  fontFamily: "var(--font-body)",
                  minHeight: 44,
                }}
              >
                Sign Out
              </button>
            </div>
          </Card>

          {/* ═══ APPEARANCE ═══════════════════════════════════ */}
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Appearance</SectionLabel>
            <div>
              <div style={{
                fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 8,
              }}>Theme</div>
              <SegmentToggle
                ariaLabel="Color theme"
                segments={BOARD_THEMES}
                activeId={theme}
                onSelect={(id) => setTheme(id as "light" | "dark" | "lux")}
              />
              <div style={{
                fontSize: "0.6875rem", color: "var(--color-text-faint)", marginTop: 8,
              }}>
                Applies to the entire application
              </div>
            </div>
          </Card>

          {/* Unsupported preferences stay hidden until they affect gameplay or delivery. */}

          {/* ═══ HELP ════════════════════════════════════════ */}
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Help</SectionLabel>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div>
                <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-primary)" }}>Game Tutorial</div>
                <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", marginTop: 2 }}>
                  Review the basics of how to play backgammon
                </div>
              </div>
              <button
                onClick={handleReplayTutorial}
                type="button"
                style={{
                  padding: "10px 20px",
                  borderRadius: 6,
                  border: "1px solid var(--color-gold-primary)",
                  background: "var(--color-gold-muted)",
                  color: "var(--color-gold-primary)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "var(--font-body)",
                  transition: "all 0.15s ease",
                  whiteSpace: "nowrap",
                  minHeight: 44,
                }}
              >
                Replay Tutorial
              </button>
            </div>
          </Card>

          {/* Wallet section hidden for now */}

        </div>
      </main>
    </div>
  );
}
