"use client";

import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/layout";
import {
  Card,
  SectionLabel,
  SegmentToggle,
} from "@/components/ui";
import { useSocialContext } from "@/contexts/SocialContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/hooks/useAuth";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";
import { fetchStats, fetchMatches, fetchProfile, timeAgo } from "@/lib/api";
import type { PlayerStats, MatchResult as MatchResultType, PlayerProfile } from "@/lib/api";

// ─── Constants ─────────────────────────────────────────────────────
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "stats", label: "Statistics" },
  { id: "history", label: "Match History" },
  { id: "settings", label: "Settings" },
];

const HISTORY_FILTERS = [
  { id: "all", label: "All" },
  { id: "wins", label: "Wins" },
  { id: "losses", label: "Losses" },
  { id: "wagers", label: "Wagers" },
];

const BOARD_THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const NOTATION_STYLES = [
  { id: "international", label: "International" },
  { id: "american", label: "American" },
];

// ─── Icons ─────────────────────────────────────────────────────────
function ShieldIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="var(--color-text-secondary)" strokeWidth="1.5">
      <path d="M8 1.5L3 4v3c0 3 2 5.5 5 6.5 3-1 5-3.5 5-6.5V4L8 1.5z" />
      <path d="M6 8l1.5 1.5L10.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5">
      <rect x="2" y="5" width="16" height="11" rx="2" />
      <path d="M14 10.5a1 1 0 100 2 1 1 0 000-2z" fill="var(--color-text-muted)" />
      <path d="M2 8h16" />
    </svg>
  );
}

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

// ─── Toggle Switch ─────────────────────────────────────────────────
function ToggleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div onClick={onToggle} style={{
      width: 40, height: 22, borderRadius: 11, cursor: "pointer",
      background: on ? "var(--color-gold-primary)" : "var(--color-bg-subtle)",
      position: "relative", transition: "background 0.15s ease", flexShrink: 0,
    }}>
      <div style={{
        width: 18, height: 18, borderRadius: "50%",
        background: "var(--color-bg-elevated)", position: "absolute", top: 2,
        left: on ? 20 : 2, transition: "left 0.15s ease",
        boxShadow: "var(--shadow-card)",
      }} />
    </div>
  );
}

// ─── Match Row (profile-specific with PR and Wager columns) ───────
function ProfileMatchRow({ opponent, result, score, pr, wager, date }: {
  opponent: string; result: "W" | "L"; score: string; pr: string; wager: string; date: string;
}) {
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
        <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)" }}>{date}</div>
      </div>
      <div style={{
        padding: "3px 8px", borderRadius: 4, fontSize: "0.6875rem", fontWeight: 700,
        background: result === "W" ? "var(--color-success-muted)" : "var(--color-danger-muted)",
        border: `1px solid ${result === "W" ? "var(--color-success)" : "var(--color-danger)"}`,
        color: result === "W" ? "var(--color-success)" : "var(--color-danger)",
      }}>{result} {score}</div>
      <div style={{
        fontSize: "0.6875rem", color: "var(--color-text-secondary)", fontWeight: 600,
        fontFamily: "var(--font-mono)", minWidth: 36, textAlign: "right",
      }}>{pr}</div>
      <div style={{
        fontSize: "0.6875rem", color: wager === "Free" ? "var(--color-text-muted)" : "var(--color-text-primary)",
        fontWeight: 600, minWidth: 40, textAlign: "right",
      }}>{wager}</div>
    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════
// MAIN — PROFILE PAGE
// ═══════════════════════════════════════════════════════════════════
export default function ProfilePage() {
  const { address } = useAuth();
  const social = useSocialContext();
  const { theme, setTheme } = useTheme();
  const isNativeApp = useIsNativeApp();
  const [activeTab, setActiveTab] = useState("overview");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("anthony@example.com");

  // Live data
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [matches, setMatches] = useState<MatchResultType[]>([]);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);

  useEffect(() => {
    if (!address) return;
    fetchStats(address).then(setStats).catch(() => {});
    fetchMatches(address, 20).then(setMatches).catch(() => {});
    fetchProfile(address).then(setProfile).catch(() => {});
  }, [address]);

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
  const [boardTheme, setBoardTheme] = useState("light");
  const [notationStyle, setNotationStyle] = useState("international");
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [notifications, setNotifications] = useState({
    matchInvites: true,
    friendRequests: true,
    tournamentAlerts: false,
  });
  const [historyFilter, setHistoryFilter] = useState("all");

  const profileName = social.displayName || social.username || "Player";
  const rating = stats?.rating ?? 1500;
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
        backHref="/lobby"
        actions={
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 12px", border: "1px solid var(--color-border-subtle)",
            borderRadius: 8, background: "var(--color-bg-surface)",
          }}>
            <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-gold-primary)" }}>--</span>
            <span style={{ fontSize: "0.625rem", color: "var(--color-text-muted)" }}>USDC</span>
          </div>
        }
      />

      {/* ─── Main Content ───────────────────────────────────── */}
      <main className="p-4 md:p-6 lg:px-6 lg:py-7" style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", overflow: "auto",
      }}>
        <div style={{ width: "100%", maxWidth: 700 }}>

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
                <div style={{
                  position: "absolute", bottom: 2, right: 2,
                  width: 14, height: 14, borderRadius: "50%",
                  background: "var(--color-success)", border: "3px solid var(--color-bg-surface)",
                }} />
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
                    }}>{rating.toLocaleString()}</span>
                    <span style={{
                      fontSize: "0.6875rem", fontWeight: 700,
                      color: ratingChange >= 0 ? "var(--color-success)" : "var(--color-danger)",
                    }}>
                      {ratingChange >= 0 ? "\u2191" : "\u2193"}{Math.abs(ratingChange)}
                    </span>
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
                  <span style={{
                    display: "flex", alignItems: "center", gap: 4,
                  }}>
                    <div style={{
                      width: 7, height: 7, borderRadius: "50%", background: "var(--color-success)",
                    }} />
                    Online
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Stats */}
            <div style={{
              display: "flex", gap: 0, marginTop: 20, paddingTop: 16,
              borderTop: "1px solid var(--color-border-subtle)",
            }}>
              <QuickStat label="Games" value={totalGames.toLocaleString()} />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <QuickStat label="W / L" value={`${wins} / ${losses}`} />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <QuickStat label="Avg PR" value="--" />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <QuickStat label="Streak" value={streakStr} />
            </div>
          </Card>

          {/* ═══ TAB BAR ═════════════════════════════════════ */}
          <div style={{
            display: "flex", gap: 0, background: "var(--color-bg-surface)",
            borderLeft: "1px solid var(--color-border-subtle)",
            borderRight: "1px solid var(--color-border-subtle)",
            borderBottom: "1px solid var(--color-border-subtle)",
            borderRadius: "0 0 8px 8px",
            marginBottom: 20,
          }}>
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
                  flex: 1, padding: "14px 0", background: "none", border: "none",
                  borderBottom: `2.5px solid ${active ? "var(--color-gold-primary)" : "transparent"}`,
                  fontSize: "0.8125rem", fontWeight: active ? 700 : 500,
                  color: active ? "var(--color-text-primary)" : "var(--color-text-muted)",
                  cursor: "pointer",
                  fontFamily: "var(--font-body)",
                  transition: "all 0.1s ease",
                }}>{tab.label}</button>
              );
            })}
          </div>

          {/* ═══ TAB CONTENT ═════════════════════════════════ */}

          {/* ─── OVERVIEW ──────────────────────────────────── */}
          {activeTab === "overview" && (
            <>
              {/* Recent Matches */}
              <Card style={{ marginBottom: 20 }}>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  marginBottom: 12,
                }}>
                  <SectionLabel>Recent Matches</SectionLabel>
                  <button onClick={() => setActiveTab("history")} style={{
                    background: "none", border: "none", fontSize: "0.6875rem",
                    color: "var(--color-text-secondary)", fontWeight: 600, cursor: "pointer",
                    fontFamily: "var(--font-body)",
                  }}>View all &rarr;</button>
                </div>
                {matches.length > 0 ? matches.slice(0, 5).map((m, i) => (
                  <ProfileMatchRow key={i} opponent={m.opponentName || m.opponent.slice(0, 10)} result={m.result} score={m.resultType} pr="--" wager="Free" date={timeAgo(m.timestamp)} />
                )) : (
                  <div style={{ padding: "20px 0", textAlign: "center", fontSize: "0.8125rem", color: "var(--color-text-muted)" }}>
                    No matches yet. Play a game to see your history!
                  </div>
                )}
              </Card>
            </>
          )}

          {/* ─── STATISTICS ────────────────────────────────── */}
          {activeTab === "stats" && (
            <>
              {/* Rating Progression */}
              <Card style={{ marginBottom: 20 }}>
                <SectionLabel>Rating Progression</SectionLabel>
                <div style={{ padding: "32px 0", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.8125rem" }}>
                  Play more games to see your rating trend
                </div>
              </Card>

              {/* Win/Loss Breakdown */}
              <Card style={{ marginBottom: 20 }}>
                <SectionLabel>Win / Loss Breakdown</SectionLabel>
                <div style={{ display: "flex", gap: 24 }}>
                  {/* Donut chart */}
                  <div style={{ width: 140, flexShrink: 0 }}>
                    {(() => {
                      const winPct = totalGames > 0 ? wins / totalGames : 0;
                      const lossPct = totalGames > 0 ? losses / totalGames : 0;
                      return (
                        <svg width="140" height="140" viewBox="0 0 140 140">
                          <circle cx="70" cy="70" r="54" fill="none" stroke="var(--color-bg-elevated)" strokeWidth="16" />
                          {totalGames > 0 && (
                            <>
                              <circle cx="70" cy="70" r="54" fill="none" stroke="var(--color-gold-primary)"
                                strokeWidth="16" strokeDasharray={`${winPct * 339.3} ${339.3}`}
                                strokeDashoffset="84.8" strokeLinecap="round" />
                              <circle cx="70" cy="70" r="54" fill="none" stroke="var(--color-bg-subtle)"
                                strokeWidth="16" strokeDasharray={`${lossPct * 339.3} ${339.3}`}
                                strokeDashoffset={`${84.8 - winPct * 339.3}`} strokeLinecap="round" />
                            </>
                          )}
                          <text x="70" y="66" textAnchor="middle" fontSize="20" fontWeight="700"
                            fill="var(--color-text-primary)" fontFamily="var(--font-mono)">{totalGames > 0 ? Math.round(winPct * 100) : 0}%</text>
                          <text x="70" y="82" textAnchor="middle" fontSize="10"
                            fill="var(--color-text-muted)" fontFamily="var(--font-mono)">Win Rate</text>
                        </svg>
                      );
                    })()}
                  </div>

                  {/* Win rate by bucket */}
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: "0.6875rem", fontWeight: 700, color: "var(--color-text-muted)",
                      textTransform: "uppercase", letterSpacing: "0.04em",
                      marginBottom: 12,
                    }}>Win Rate by Opponent Rating</div>
                    <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.75rem" }}>
                      Coming soon
                    </div>
                  </div>
                </div>
              </Card>

              {/* Error Analysis */}
              <Card style={{ marginBottom: 20 }}>
                <SectionLabel>Error Analysis</SectionLabel>
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.8125rem" }}>
                  Coming soon
                </div>
              </Card>

              {/* PR Trend */}
              <Card>
                <SectionLabel>Performance Rating Trend</SectionLabel>
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.8125rem" }}>
                  Coming soon
                </div>
              </Card>
            </>
          )}

          {/* ─── MATCH HISTORY ─────────────────────────────── */}
          {activeTab === "history" && (
            <Card>
              {/* Filters */}
              <div style={{
                display: "flex", gap: 6, marginBottom: 16,
              }}>
                {HISTORY_FILTERS.map(({ id, label }) => {
                  const active = historyFilter === id;
                  return (
                    <button key={id} onClick={() => setHistoryFilter(id)} style={{
                      padding: "6px 14px", borderRadius: 6,
                      border: `1.5px solid ${active ? "var(--color-gold-primary)" : "var(--color-border-subtle)"}`,
                      background: active ? "var(--color-gold-primary)" : "var(--color-bg-surface)",
                      color: active ? "var(--color-accent-fg)" : "var(--color-text-secondary)",
                      fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
                      fontFamily: "var(--font-body)",
                    }}>{label}</button>
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
                {filteredMatches.length > 0 ? filteredMatches.map((m, i) => (
                  <ProfileMatchRow key={i} opponent={m.opponentName || m.opponent.slice(0, 10)} result={m.result} score={m.resultType} pr="--" wager="Free" date={timeAgo(m.timestamp)} />
                )) : (
                  <div style={{ padding: "20px 0", textAlign: "center", fontSize: "0.8125rem", color: "var(--color-text-muted)" }}>
                    No matches found
                  </div>
                )}
              </div>

              {/* Pagination */}
              <div style={{
                marginTop: 12, paddingTop: 12,
                borderTop: "1px solid var(--color-border-subtle)",
                fontSize: "0.6875rem", color: "var(--color-text-muted)", textAlign: "center",
              }}>
                Showing {filteredMatches.length} of {totalGames.toLocaleString()} matches
              </div>
            </Card>
          )}

          {/* ─── SETTINGS ──────────────────────────────────── */}
          {activeTab === "settings" && (
            <>
              {/* Account */}
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Account</SectionLabel>
                <div style={{ marginBottom: 16 }}>
                  <div style={{
                    fontSize: "0.6875rem", fontWeight: 600, color: "var(--color-text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6,
                  }}>Display Name</div>
                  <input
                    type="text" value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    style={{
                      width: "100%", padding: "10px 14px", borderRadius: 6,
                      border: "1.5px solid var(--color-border-subtle)", background: "var(--color-bg-base)",
                      fontSize: "0.875rem", fontWeight: 600, color: "var(--color-text-primary)", outline: "none",
                      fontFamily: "var(--font-body)",
                      boxSizing: "border-box",
                      transition: "border-color 0.2s",
                    }}
                    onFocus={(e) => { e.target.style.borderColor = "var(--color-gold-primary)"; }}
                    onBlur={(e) => { e.target.style.borderColor = "var(--color-border-subtle)"; handleDisplayNameBlur(); }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{
                    fontSize: "0.6875rem", fontWeight: 600, color: "var(--color-text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    Email
                    <span style={{
                      fontSize: "0.5625rem", padding: "1px 6px", borderRadius: 3,
                      background: "var(--color-gold-muted)", color: "var(--color-gold-primary)", fontWeight: 700,
                    }}>Verified</span>
                  </div>
                  <input
                    type="email" value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{
                      width: "100%", padding: "10px 14px", borderRadius: 6,
                      border: "1.5px solid var(--color-border-subtle)", background: "var(--color-bg-base)",
                      fontSize: "0.875rem", color: "var(--color-text-primary)", outline: "none",
                      fontFamily: "var(--font-body)",
                      boxSizing: "border-box",
                      transition: "border-color 0.2s",
                    }}
                    onFocus={(e) => { e.target.style.borderColor = "var(--color-gold-primary)"; }}
                    onBlur={(e) => { e.target.style.borderColor = "var(--color-border-subtle)"; }}
                  />
                </div>
                <div>
                  <div style={{
                    fontSize: "0.6875rem", fontWeight: 600, color: "var(--color-text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6,
                  }}>Avatar</div>
                  <button style={{
                    padding: "8px 16px", borderRadius: 6,
                    border: "1.5px solid var(--color-border-subtle)", background: "var(--color-bg-surface)",
                    fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-secondary)",
                    cursor: "pointer", fontFamily: "var(--font-body)",
                  }}>Change Avatar</button>
                </div>
              </Card>

              {/* Appearance */}
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Appearance</SectionLabel>
                <div style={{
                  fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 8,
                }}>Theme</div>
                <SegmentToggle
                  segments={[{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }]}
                  activeId={theme}
                  onSelect={(id) => setTheme(id as "light" | "dark")}
                />
                <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", marginTop: 6 }}>
                  Applies to the entire application
                </div>
              </Card>

              {/* Game Preferences */}
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Game Preferences</SectionLabel>
                <div style={{ marginBottom: 16 }}>
                  <div style={{
                    fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 8,
                  }}>Board Theme</div>
                  <SegmentToggle
                    segments={BOARD_THEMES}
                    activeId={boardTheme}
                    onSelect={setBoardTheme}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{
                    fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 8,
                  }}>Notation Style</div>
                  <SegmentToggle
                    segments={NOTATION_STYLES}
                    activeId={notationStyle}
                    onSelect={setNotationStyle}
                  />
                </div>
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}>
                  <div>
                    <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)" }}>Auto-Confirm Moves</div>
                    <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", marginTop: 2 }}>
                      Automatically confirm obvious forced moves
                    </div>
                  </div>
                  <ToggleSwitch on={autoConfirm} onToggle={() => setAutoConfirm(!autoConfirm)} />
                </div>
              </Card>

              {/* Notifications */}
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Notifications</SectionLabel>
                {[
                  { key: "matchInvites" as const, label: "Match Invites", desc: "Get notified when friends challenge you" },
                  { key: "friendRequests" as const, label: "Friend Requests", desc: "Alerts for new friend requests" },
                  { key: "tournamentAlerts" as const, label: "Tournament Alerts", desc: "Upcoming tournament reminders" },
                ].map((item, i) => (
                  <div key={item.key} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "12px 0",
                    borderBottom: i < 2 ? "1px solid var(--color-border-subtle)" : "none",
                  }}>
                    <div>
                      <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-primary)" }}>{item.label}</div>
                      <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)", marginTop: 2 }}>{item.desc}</div>
                    </div>
                    <ToggleSwitch
                      on={notifications[item.key]}
                      onToggle={() => setNotifications({
                        ...notifications,
                        [item.key]: !notifications[item.key],
                      })}
                    />
                  </div>
                ))}
              </Card>

              {/* Wallet — web-only. Hidden in the native iOS shell per App Store policy. */}
              {!isNativeApp && (
                <Card>
                  <SectionLabel>Wallet</SectionLabel>

                  {/* Balance */}
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "14px 16px", borderRadius: 6,
                    background: "var(--color-bg-base)", border: "1px solid var(--color-border-subtle)",
                    marginBottom: 16,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <WalletIcon />
                      <span style={{
                        fontSize: "1.375rem", fontWeight: 700, color: "var(--color-gold-primary)",
                        fontFamily: "var(--font-mono)",
                      }}>--</span>
                      <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", fontWeight: 600 }}>USDC</span>
                    </div>
                    <div style={{
                      display: "flex", alignItems: "center", gap: 4,
                      fontSize: "0.625rem", color: "var(--color-gold-primary)", fontWeight: 600,
                    }}>
                      <ShieldIcon size={12} />
                      On-chain escrow
                    </div>
                  </div>

                  {/* Transaction History */}
                  <div style={{
                    fontSize: "0.6875rem", fontWeight: 700, color: "var(--color-text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.04em",
                    marginBottom: 8,
                  }}>Recent Transactions</div>
                  <div style={{ padding: "20px 0", textAlign: "center", fontSize: "0.8125rem", color: "var(--color-text-muted)" }}>
                    Coming soon
                  </div>
                </Card>
              )}
            </>
          )}

        </div>
      </main>
    </div>
  );
}
