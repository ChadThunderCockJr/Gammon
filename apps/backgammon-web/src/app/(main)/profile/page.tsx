"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Header } from "@/components/layout";
import { Card, SectionLabel } from "@/components/ui";
import { useSocialContext } from "@/contexts/SocialContext";
import { useAuth } from "@/hooks/useAuth";
import { useServerSession } from "@/hooks/useServerSession";
import { authenticatedFetch } from "@/lib/server-session";
import { z } from "zod";
import { fetchStats, fetchMatches, fetchProfile, timeAgo } from "@/lib/api";
import type { MatchResult as MatchResultType, PlayerProfile, PlayerStats } from "@/lib/api";

// ─── Constants ─────────────────────────────────────────────────────
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "stats", label: "Statistics" },
  { id: "history", label: "Match History" },
  { id: "settings", label: "More" },
] as const;
type ProfileTab = (typeof TABS)[number]["id"];

const HISTORY_FILTERS = [
  { id: "all", label: "All" },
  { id: "wins", label: "Wins" },
  { id: "losses", label: "Losses" },
];
function cashStateLabel(state: string | null): string {
  if (!state) return "Cash record";
  return ({
    offered: "Awaiting acceptance",
    accepted: "Accepted",
    reserving: "Funding",
    active: "In play",
    settlement_pending: "Settlement pending",
    settled: "Settled",
    refunded: "Refunded",
    review: "Under review",
    expired: "Expired",
  } as Record<string, string>)[state] ?? "Cash status recorded";
}
const QuoteFundsSchema = z.object({ testFunds: z.boolean(), fundsMode: z.enum(["free", "verusd_testnet", "verusd_production", "legacy_unverified"]) });
type QuoteFunds = z.infer<typeof QuoteFundsSchema>;



// ─── Quick Stat ────────────────────────────────────────────────────
function QuickStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{
        fontSize: "1.25rem", fontWeight: 700, color: "var(--color-text-primary)",
        fontFamily: "var(--font-mono)", letterSpacing: "-0.02em",
      }}>{value}</div>
      <div style={{
        fontSize: "0.625rem", color: "var(--color-text-muted)", textTransform: "uppercase",
        letterSpacing: "0.04em", fontWeight: 600, marginTop: 2,
      }}>{label}</div>
      {sub && (
        <div style={{ fontSize: "0.625rem", color: "var(--color-text-secondary)", marginTop: 1 }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Match Row (profile-specific with PR and Wager columns) ───────
function ProfileMatchRow({ match, testFunds }: { match: MatchResultType; testFunds: boolean }) {
  const hasCashRecord = Boolean(
    match.cashQuoteId
    || match.cashState
    || match.stakeMicroUsd
    || match.reserveMicroUsd
    || match.terminalReceipt
    || match.settlementTxHash,
  );
  const isFree = match.wagerAmount === 0 || match.wagerAmount === "0";
  let cashStake: string | null = null;
  if (match.stakeMicroUsd && /^\d+$/.test(match.stakeMicroUsd)) {
    const value = BigInt(match.stakeMicroUsd);
    cashStake = `$${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0").slice(0, 2)} USD · ${match.assetDenom ?? "verUSD"}`;
  }
  const wagerLabel = hasCashRecord
    ? `${testFunds ? "Test cash" : "Cash"}${cashStake ? ` · ${cashStake}` : match.wagerAmount !== null && match.wagerAmount !== undefined && match.wagerAmount !== "" && !isFree ? ` · Wager ${match.wagerAmount}` : ""}`
    : isFree
      ? "Free"
      : match.wagerAmount === null || match.wagerAmount === undefined || match.wagerAmount === ""
        ? "Wager unconfirmed"
        : `Wager ${match.wagerAmount}`;
  const opponent = match.opponentName || match.opponent.slice(0, 10);
  const receiptHref = match.cashQuoteId ? `/activity?cashQuote=${encodeURIComponent(match.cashQuoteId)}` : null;
  const receiptStatus = match.cashState ? cashStateLabel(match.cashState) : match.terminalReceipt ? "Receipt available" : "Cash record";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 0", borderBottom: "1px solid var(--color-border-subtle)",
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: "50%",
        background: "var(--color-bg-elevated)", border: "2px solid var(--color-border-subtle)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "0.75rem", fontWeight: 700, color: "var(--color-text-secondary)", flexShrink: 0,
      }}>{opponent[0]}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-primary)" }}>{opponent}</div>
        <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)" }}>{timeAgo(match.timestamp)}</div>
      </div>
      <div style={{
        padding: "3px 8px", borderRadius: 4, fontSize: "0.6875rem", fontWeight: 700,
        background: match.result === "W" ? "var(--color-success-muted)" : "var(--color-danger-muted)",
        border: `1px solid ${match.result === "W" ? "var(--color-success)" : "var(--color-danger)"}`,
        color: match.result === "W" ? "var(--color-success)" : "var(--color-danger)",
      }}>{match.result} {match.resultType}</div>
      <div style={{
        fontSize: "0.6875rem", color: "var(--color-text-secondary)", fontWeight: 600,
        fontFamily: "var(--font-mono)", minWidth: 36, textAlign: "right",
      }}>--</div>
      <div style={{
        fontSize: "0.6875rem", color: isFree ? "var(--color-text-muted)" : "var(--color-text-primary)",
        fontWeight: 600, minWidth: 96, textAlign: "right",
      }}>
        <div>{wagerLabel}</div>
        {receiptHref && (
          <Link href={receiptHref} style={{ color: "var(--color-text-secondary)", fontSize: "0.625rem", textDecoration: "underline" }}>
            Receipt · {receiptStatus}
          </Link>
        )}
      </div>
    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════
// MAIN — PROFILE PAGE
// ═══════════════════════════════════════════════════════════════════
export default function ProfilePage() {
  const { address } = useAuth();
  const social = useSocialContext();
  const session = useServerSession();
  const [cashFunds, setCashFunds] = useState<Record<string, QuoteFunds>>({});
  const [displayName, setDisplayName] = useState("");
  const [activeTab, setActiveTab] = useState<ProfileTab>("overview");
  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get("tab");
    const requested = TABS.find((tab) => tab.id === requestedTab);
    if (requested) setActiveTab(requested.id);
  }, []);

  // Live data
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [matches, setMatches] = useState<MatchResultType[]>([]);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [dataStatus, setDataStatus] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!address) {
      setDataStatus("error");
      return;
    }
    let active = true;
    setDataStatus("loading");
    void Promise.allSettled([
      fetchStats(address),
      fetchMatches(address, 20),
      fetchProfile(address),
    ]).then(([statsResult, matchesResult, profileResult]) => {
      if (!active) return;
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      if (matchesResult.status === "fulfilled") setMatches(matchesResult.value);
      if (profileResult.status === "fulfilled") setProfile(profileResult.value);
      setDataStatus(
        [statsResult, matchesResult, profileResult].every((result) => result.status === "fulfilled")
          ? "ready"
          : "error",
      );
    });
    return () => {
      active = false;
    };
  }, [address, reloadKey]);

  // Sync display name from social context
  useEffect(() => {
    if (social.displayName) {
      setDisplayName(social.displayName);
    }
  }, [social.displayName]);

  // Save display name on blur
  const handleDisplayNameBlur = useCallback(() => {
    if (displayName.trim() && displayName !== social.displayName) {
      social.setDisplayName(displayName.trim());
    }
  }, [displayName, social]);
  const [historyFilter, setHistoryFilter] = useState("all");
  useEffect(() => {
    if (session.status !== "ready") return;
    const quoteIds = [...new Set(matches.map((match) => match.cashQuoteId).filter((id): id is string => Boolean(id)))];
    if (quoteIds.length === 0) return;
    let active = true;
    void Promise.all(quoteIds.map(async (id) => {
      const response = await authenticatedFetch(`/api/cash-games/quotes/${id}`);
      if (!response.ok) return null;
      return { id, funds: z.object({ quote: QuoteFundsSchema }).parse(await response.json()).quote };
    })).then((records) => {
      if (!active) return;
      const next: Record<string, QuoteFunds> = {};
      for (const record of records) {
        if (record) next[record.id] = record.funds;
      }
      setCashFunds(next);
    }).catch(() => { /* Unavailable historical records remain safely labeled as unverified test funds. */ });
    return () => { active = false; };
  }, [matches, session.status]);
  const profileName = social.displayName || social.username || "Player";
  const rating = stats?.rating;
  const ratingChange = stats?.ratingChange ?? 0;
  const wins = stats?.wins ?? 0;
  const losses = stats?.losses ?? 0;
  const totalGames = stats?.totalGames ?? 0;
  const streakStr = stats && stats.currentStreak > 0 ? `${stats.currentStreak}${stats.currentStreakType}` : "--";
  const memberSince = profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "--";

  const filteredMatches = matches.filter((m) => {
    if (historyFilter === "wins") return m.result === "W";
    if (historyFilter === "losses") return m.result === "L";
    return true;
  });

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      fontFamily: "var(--font-body)",
      color: "var(--color-text-primary)",
    }}>

      {/* ─── Header ─────────────────────────────────────────── */}
      <Header
        title="Profile"
        backHref="/"
        actions={
          <Link
            href="/wallet"
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 12px", border: "1px solid var(--color-border-subtle)",
              borderRadius: 8, background: "var(--color-bg-surface)",
              color: "var(--color-text-muted)", fontSize: "0.75rem", textDecoration: "none",
            }}
          >
            Wallet status
          </Link>
        }
      />

      {/* ─── Main Content ───────────────────────────────────── */}
      <main className="p-4 md:p-6 lg:px-6 lg:py-7" style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", overflow: "auto",
      }}>
        <div style={{ width: "100%", maxWidth: 700 }}>
          {dataStatus === "loading" && (
            <div role="status" style={{ marginBottom: 12, color: "var(--color-text-muted)", fontSize: "0.8125rem" }}>
              Loading profile data…
            </div>
          )}
          {dataStatus === "error" && (
            <div role="alert" style={{ marginBottom: 12, padding: 12, border: "1px solid var(--color-danger)", borderRadius: 8 }}>
              <strong>Some profile data is unavailable.</strong>{" "}
              <button type="button" onClick={() => setReloadKey((key) => key + 1)} style={{ color: "inherit", textDecoration: "underline" }}>
                Retry
              </button>
            </div>
          )}

          {/* ═══ PROFILE HEADER ══════════════════════════════ */}
          <Card style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
              {/* Avatar */}
              <div style={{ position: "relative" }}>
                <div style={{
                  width: 80, height: 80, borderRadius: "50%",
                  background: "var(--color-bg-elevated)", border: "2px solid var(--color-border-subtle)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "1.875rem", fontWeight: 700, color: "var(--color-text-secondary)", flexShrink: 0,
                }}>{profileName[0]}</div>
              </div>

              {/* Info */}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{
                    fontSize: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em",
                    fontFamily: "var(--font-display)", color: "var(--color-text-primary)",
                  }}>
                    {social.displayName || social.username || profileName}
                  </span>
                  <div style={{
                    display: "flex", alignItems: "baseline", gap: 4,
                    padding: "3px 10px", borderRadius: 6,
                    background: "var(--color-bg-base)", border: "1px solid var(--color-border-subtle)",
                  }}>
                    <span style={{
                      fontSize: "1rem", fontWeight: 700, color: "var(--color-text-primary)",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {stats === null ? "Unavailable" : rating === undefined ? "Unrated" : rating.toLocaleString()}
                    </span>
                    {rating !== undefined && <span style={{
                      fontSize: "0.6875rem", fontWeight: 700,
                      color: ratingChange >= 0 ? "var(--color-success)" : "var(--color-danger)",
                    }}>
                      {ratingChange >= 0 ? "\u2191" : "\u2193"}{Math.abs(ratingChange)}
                    </span>}
                  </div>
                </div>
                <div style={{ fontSize: "0.8125rem", color: "var(--color-text-secondary)", marginBottom: 6 }}>
                  {social.username ? `@${social.username}` : "No bio set"}
                </div>
                <div style={{
                  fontSize: "0.6875rem", color: "var(--color-text-muted)",
                  display: "flex", alignItems: "center", gap: 12,
                }}>
                  {address && (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.625rem" }}>
                      {address.slice(0, 16)}...{address.slice(-6)}
                    </span>
                  )}
                  <span>Member since {memberSince}</span>
                </div>
              </div>
            </div>

            {/* Quick Stats */}
            <div style={{
              display: "flex", gap: 0, marginTop: 20, paddingTop: 16,
              borderTop: "1px solid var(--color-border-subtle)",
            }}>
              <QuickStat label="Games" value={stats ? totalGames.toLocaleString() : "--"} />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <QuickStat label="W / L" value={stats ? `${wins} / ${losses}` : "--"} />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <QuickStat label="Avg PR" value="--" />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <QuickStat label="Streak" value={stats ? streakStr : "--"} />
            </div>
          </Card>

          {/* ═══ TAB BAR ═════════════════════════════════════ */}
          <div
            role="tablist"
            aria-label="Profile sections"
            style={{
              display: "flex", gap: 0, background: "var(--color-bg-surface)",
              borderLeft: "1px solid var(--color-border-subtle)",
              borderRight: "1px solid var(--color-border-subtle)",
              borderBottom: "1px solid var(--color-border-subtle)",
              borderRadius: "0 0 8px 8px",
              marginBottom: 20,
            }}
          >
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  id={`profile-tab-${tab.id}`}
                  role="tab"
                  aria-selected={active}
                  aria-controls={`profile-panel-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => {
                    const index = TABS.findIndex((candidate) => candidate.id === tab.id);
                    const next = event.key === "Home"
                      ? TABS[0]
                      : event.key === "End"
                        ? TABS[TABS.length - 1]
                        : event.key === "ArrowRight"
                          ? TABS[(index + 1) % TABS.length]
                          : event.key === "ArrowLeft"
                            ? TABS[(index - 1 + TABS.length) % TABS.length]
                            : null;
                    if (next) {
                      event.preventDefault();
                      setActiveTab(next.id);
                      document.getElementById(`profile-tab-${next.id}`)?.focus();
                    }
                  }}
                  style={{
                    flex: 1, padding: "14px 0", background: "none", border: "none",
                    borderBottom: `2.5px solid ${active ? "var(--color-gold-primary)" : "transparent"}`,
                    fontSize: "0.8125rem", fontWeight: active ? 700 : 500,
                    color: active ? "var(--color-text-primary)" : "var(--color-text-muted)",
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                    transition: "all 0.1s ease",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* ═══ TAB CONTENT ═════════════════════════════════ */}

          {/* ─── OVERVIEW ──────────────────────────────────── */}
          {activeTab === "overview" && (
            <div role="tabpanel" id="profile-panel-overview" aria-labelledby="profile-tab-overview">
              <Card style={{ marginBottom: 20 }}>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  marginBottom: 12,
                }}>
                  <SectionLabel>Recent Matches</SectionLabel>
                  <button type="button" aria-controls="profile-panel-history" onClick={() => setActiveTab("history")} style={{
                    background: "none", border: "none", fontSize: "0.6875rem",
                    color: "var(--color-text-secondary)", fontWeight: 600, cursor: "pointer",
                    fontFamily: "var(--font-body)",
                  }}>View all &rarr;</button>
                </div>
                {matches.length > 0 ? matches.slice(0, 5).map((match) => (
                  <ProfileMatchRow key={match.gameId} match={match} testFunds={Boolean(match.cashQuoteId) && (cashFunds[match.cashQuoteId ?? ""]?.testFunds ?? true)} />
                )) : (
                  <div role="status" style={{ padding: "20px 0", textAlign: "center", fontSize: "0.8125rem", color: "var(--color-text-muted)" }}>
                    {dataStatus === "loading"
                      ? "Loading match history…"
                      : dataStatus === "error"
                        ? "Match history is temporarily unavailable."
                        : "No matches yet. Play a game to see your history."}
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ─── STATISTICS ────────────────────────────────── */}
          {activeTab === "stats" && (
            <div role="tabpanel" id="profile-panel-stats" aria-labelledby="profile-tab-stats">
              <Card>
                <SectionLabel>Recorded game statistics</SectionLabel>
                {stats ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                    <QuickStat label="Games" value={totalGames.toLocaleString()} />
                    <QuickStat label="Rating" value={rating === undefined ? "Unrated" : rating.toLocaleString()} />
                    <QuickStat label="Wins" value={wins.toLocaleString()} />
                    <QuickStat label="Losses" value={losses.toLocaleString()} />
                    <QuickStat
                      label="Win rate"
                      value={totalGames > 0 ? `${Math.round((wins / totalGames) * 100)}%` : "—"}
                    />
                    <QuickStat label="Current streak" value={streakStr} />
                  </div>
                ) : (
                  <div role="status" style={{ padding: "24px 0", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.8125rem" }}>
                    {dataStatus === "loading" ? "Loading statistics…" : "Statistics are temporarily unavailable."}
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ─── MATCH HISTORY ─────────────────────────────── */}
          {activeTab === "history" && (
            <Card role="tabpanel" id="profile-panel-history" aria-labelledby="profile-tab-history">
              {/* Filters */}
              <div style={{
                display: "flex", gap: 6, marginBottom: 16,
              }}>
                {HISTORY_FILTERS.map(({ id, label }) => {
                  const active = historyFilter === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setHistoryFilter(id)}
                      style={{
                        padding: "6px 14px", borderRadius: 6,
                        border: `1.5px solid ${active ? "var(--color-gold-primary)" : "var(--color-border-subtle)"}`,
                        background: active ? "var(--color-gold-primary)" : "var(--color-bg-surface)",
                        color: active ? "var(--color-accent-fg)" : "var(--color-text-secondary)",
                        fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
                        fontFamily: "var(--font-body)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {/* Table header */}
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 0", borderBottom: "1.5px solid var(--color-border-subtle)",
                marginBottom: 4,
              }}>
                <div style={{ width: 32 }} />
                <div style={{
                  flex: 1, fontSize: "0.625rem", fontWeight: 700, color: "var(--color-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.04em",
                }}>Opponent</div>
                <div style={{
                  fontSize: "0.625rem", fontWeight: 700, color: "var(--color-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 60, textAlign: "center",
                }}>Result</div>
                <div style={{
                  fontSize: "0.625rem", fontWeight: 700, color: "var(--color-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 36, textAlign: "right",
                }}>PR</div>
                <div style={{
                  fontSize: "0.625rem", fontWeight: 700, color: "var(--color-text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 40, textAlign: "right",
                }}>Wager</div>
              </div>

              {/* Rows */}
              <div style={{ maxHeight: 480, overflow: "auto" }}>
                {filteredMatches.length > 0 ? filteredMatches.map((match) => (
                  <ProfileMatchRow key={match.gameId} match={match} testFunds={Boolean(match.cashQuoteId) && (cashFunds[match.cashQuoteId ?? ""]?.testFunds ?? true)} />
                )) : (
                  <div role="status" style={{ padding: "20px 0", textAlign: "center", fontSize: "0.8125rem", color: "var(--color-text-muted)" }}>
                    {dataStatus === "loading" ? "Loading match history…" : dataStatus === "error" ? "Match history is temporarily unavailable." : "No matches found"}
                  </div>
                )}
              </div>

              {/* Pagination */}
              <div style={{
                marginTop: 12, paddingTop: 12,
                borderTop: "1px solid var(--color-border-subtle)",
                fontSize: "0.6875rem", color: "var(--color-text-muted)", textAlign: "center",
              }}>
                Showing {filteredMatches.length} of {stats ? totalGames.toLocaleString() : "—"} matches
              </div>
            </Card>
          )}

          {/* ─── ACCOUNT & HELP ─────────────────────────────── */}
          {activeTab === "settings" && (
            <div role="tabpanel" id="profile-panel-settings" aria-labelledby="profile-tab-settings">
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Public profile</SectionLabel>
                <label
                  htmlFor="profile-display-name"
                  style={{
                    display: "block",
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    color: "var(--color-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    marginBottom: 6,
                  }}
                >
                  Display name
                </label>
                <input
                  id="profile-display-name"
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  onBlur={handleDisplayNameBlur}
                  aria-describedby="profile-display-name-help"
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: 6,
                    border: "1.5px solid var(--color-border-strong)",
                    background: "var(--color-bg-base)",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-body)",
                    boxSizing: "border-box",
                  }}
                />
                <p id="profile-display-name-help" style={{ margin: "6px 0 0", fontSize: "0.6875rem", color: "var(--color-text-muted)" }}>
                  This name is public. Changes save when you leave the field.
                </p>
              </Card>

              <Card>
                <SectionLabel>Settings, records, and help</SectionLabel>
                <nav aria-label="Account and help links" style={{ display: "grid", gap: 8 }}>
                  {[
                    ["/activity", "Activity and cash-game receipts"],
                    ["/support?category=incorrect_settlement", "Cash-game settlement support"],
                    ["/settings", "Application settings"],
                    ["/responsible-play", "Responsible play controls"],
                    ["/leaderboard", "Leaderboard"],
                    ["/verify-rolls", "Dice verification"],
                    ["/support", "Support and complaints"],
                    ["/terms", "Terms of Service"],
                    ["/privacy", "Privacy Policy"],
                  ].map(([href, label]) => (
                    <Link
                      key={href}
                      href={href}
                      style={{
                        minHeight: 44,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0 12px",
                        border: "1px solid var(--color-border-subtle)",
                        borderRadius: 6,
                        color: "var(--color-text-primary)",
                        textDecoration: "none",
                        fontSize: "0.8125rem",
                        fontWeight: 600,
                      }}
                    >
                      {label}
                      <span aria-hidden="true">→</span>
                    </Link>
                  ))}
                </nav>
              </Card>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
