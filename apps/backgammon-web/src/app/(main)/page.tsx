"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, Avatar } from "@/components/ui";
import { useSocialContext } from "@/contexts/SocialContext";
import { useAuth } from "@/hooks/useAuth";
import { useBalance } from "@/hooks/useBalance";
import { fetchStats, fetchMatches, fetchOnlineCount, timeAgo } from "@/lib/api";
import type { PlayerStats, MatchResult } from "@/lib/api";
import { getLocalStats, getLocalMatches } from "@/lib/local-stats";
import Tutorial from "@/components/Tutorial";
import { ONLINE_COUNT_POLL_INTERVAL_MS } from "@/lib/constants";
import { preloadGnubg } from "@/lib/gnubg";
import { useIsNativeApp } from "@/hooks/useIsNativeApp";

// ── Icons ──────────────────────────────────────────────────────

const Icons = {
  dice: (c = "var(--color-text-muted)") => (
    <svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <rect x="3" y="3" width="14" height="14" rx="3" />
      <circle cx="7" cy="7" r="1" fill={c} stroke="none" />
      <circle cx="13" cy="7" r="1" fill={c} stroke="none" />
      <circle cx="10" cy="10" r="1" fill={c} stroke="none" />
      <circle cx="7" cy="13" r="1" fill={c} stroke="none" />
      <circle cx="13" cy="13" r="1" fill={c} stroke="none" />
    </svg>
  ),
  brain: (c = "var(--color-text-muted)") => (
    <svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="10" cy="10" r="7" />
      <path d="M7 10c0-1.5 1.3-3 3-3s3 1.5 3 3M8 12.5c.6.5 1.3.8 2 .8s1.4-.3 2-.8" strokeLinecap="round" />
    </svg>
  ),
  users: (c = "var(--color-text-muted)") => (
    <svg width="28" height="28" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="8" cy="7" r="2.5" />
      <path d="M3 16c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <circle cx="14" cy="7" r="2" />
      <path d="M14 12c2.2 0 4 1.8 4 4" strokeLinecap="round" />
    </svg>
  ),
  shield: (c = "var(--color-text-muted)") => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.5">
      <path d="M8 1.5L3 4v3c0 3 2 5.5 5 6.5 3-1 5-3.5 5-6.5V4L8 1.5z" />
      <path d="M6 8l1.5 1.5L10.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  search: (c = "var(--color-text-muted)") => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" strokeLinecap="round" />
    </svg>
  ),
  bell: (c = "var(--color-text-muted)") => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth="1.5">
      <path d="M10 3a5 5 0 015 5c0 4 1.5 5 1.5 5H3.5S5 12 5 8a5 5 0 015-5zM8.5 16a1.5 1.5 0 003 0" strokeLinecap="round" />
    </svg>
  ),
  chevron: (c = "var(--color-text-muted)") => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={c} strokeWidth="1.5">
      <path d="M5 3l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

// ── Inline Stat (wireframe-matching version with sub text) ────

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div
        style={{
          fontSize: "1.375rem",
          fontWeight: 700,
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "0.625rem",
          color: "var(--color-text-muted)",
          marginTop: 2,
          textTransform: "uppercase",
          letterSpacing: 1,
          fontWeight: 600,
          fontFamily: "var(--font-body)",
        }}
      >
        {label}
      </div>
      {sub && (
        <div
          style={{
            fontSize: "0.6875rem",
            color: "var(--color-gold-primary)",
            marginTop: 2,
            fontFamily: "var(--font-mono)",
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Inline MatchRowStyled (wireframe-exact styling) ───────────

function MatchRowStyled({
  opponent,
  result,
  score,
  pr,
  date,
}: {
  opponent: string;
  result: "W" | "L";
  score: string;
  pr: string;
  date: string;
}) {
  const [h, setH] = useState(false);
  return (
    <div
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--color-border-subtle)",
        background: h ? "var(--color-bg-elevated)" : "transparent",
        borderRadius: h ? 6 : 0,
        transition: "all 0.12s ease",
        cursor: "pointer",
        marginLeft: h ? -8 : 0,
        paddingLeft: h ? 8 : 0,
        marginRight: h ? -8 : 0,
        paddingRight: h ? 8 : 0,
      }}
    >
      <Avatar name={opponent} size="xs" online />
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: "0.8125rem",
            fontWeight: 500,
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-body)",
          }}
        >
          vs {opponent}
        </div>
        <div
          style={{
            fontSize: "0.6875rem",
            color: "var(--color-text-faint)",
            fontFamily: "var(--font-body)",
          }}
        >
          {date}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <span
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            color: result === "W" ? "var(--color-success)" : "var(--color-danger)",
            background:
              result === "W" ? "var(--color-success-muted)" : "var(--color-danger-muted)",
            padding: "2px 8px",
            borderRadius: 20,
          }}
        >
          {result} {score}
        </span>
        <div
          style={{
            fontSize: "0.625rem",
            color: "var(--color-text-faint)",
            marginTop: 2,
            fontFamily: "var(--font-mono)",
          }}
        >
          PR {pr}
        </div>
      </div>
    </div>
  );
}

// ── Inline PlayerRowStyled (wireframe-exact styling) ──────────

function PlayerRowStyled({
  name,
  rating,
  status,
}: {
  name: string;
  rating: string;
  status: "online" | "offline";
}) {
  const [h, setH] = useState(false);
  return (
    <div
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <Avatar name={name} size="sm" online={status === "online"} />
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-body)",
          }}
        >
          {name}
        </div>
        <div
          style={{
            fontSize: "0.6875rem",
            color: "var(--color-text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {rating}
        </div>
      </div>
      <button
        aria-label={`Challenge ${name}`}
        style={{
          padding: "12px 16px",
          borderRadius: 6,
          border: h
            ? "1px solid var(--color-gold-primary)"
            : "1px solid var(--color-border-subtle)",
          background: h ? "var(--color-gold-muted)" : "transparent",
          fontSize: "0.6875rem",
          fontWeight: 600,
          color: h ? "var(--color-gold-primary)" : "var(--color-text-muted)",
          cursor: "pointer",
          fontFamily: "var(--font-body)",
          transition: "all 0.15s ease",
          minHeight: 44,
        }}
      >
        Challenge
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN DASHBOARD PAGE
// ═══════════════════════════════════════════════════════════════

export default function DashboardPage() {
  const router = useRouter();
  const { address, logout } = useAuth();
  const { balance, isLoading: balanceLoading } = useBalance();
  const isNativeApp = useIsNativeApp();
  const social = useSocialContext();
  const { displayName, username, incomingRequests, pendingChallenges, acceptFriendRequest, rejectFriendRequest, acceptChallenge, declineChallenge } = social;
  const totalNotifications = (incomingRequests?.length ?? 0) + (pendingChallenges?.length ?? 0);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const playerName = displayName || username || "Player";
  // Live data state
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [onlineCount, setOnlineCount] = useState<number>(0);

  // Start loading GNUBG WASM early so AI games are ready faster
  useEffect(() => { preloadGnubg(); }, []);

  useEffect(() => {
    const local = getLocalStats();

    // Merge server stats with local AI stats
    if (address) {
      fetchStats(address).then((serverStats) => {
        setStats({
          wins: serverStats.wins + local.wins,
          losses: serverStats.losses + local.losses,
          totalGames: serverStats.totalGames + local.totalGames,
          currentStreak: local.totalGames > 0 ? local.currentStreak : serverStats.currentStreak,
          currentStreakType: local.totalGames > 0 ? local.currentStreakType : serverStats.currentStreakType,
          rating: serverStats.rating,
          ratingChange: serverStats.ratingChange,
        });
      }).catch(() => {
        // Server unavailable — show local stats only
        if (local.totalGames > 0) {
          setStats({
            wins: local.wins,
            losses: local.losses,
            totalGames: local.totalGames,
            currentStreak: local.currentStreak,
            currentStreakType: local.currentStreakType,
            rating: 0,
            ratingChange: 0,
          });
        }
      });
      fetchMatches(address, 4).then(setMatches).catch(() => {});
    } else if (local.totalGames > 0) {
      // No address (not logged in) — show local AI stats
      setStats({
        wins: local.wins,
        losses: local.losses,
        totalGames: local.totalGames,
        currentStreak: local.currentStreak,
        currentStreakType: local.currentStreakType,
        rating: 0,
        ratingChange: 0,
      });
    }

    fetchOnlineCount().then(setOnlineCount).catch(() => {});
  }, [address]);

  // Poll online player count every 30s
  useEffect(() => {
    const fetchOnline = async () => {
      try {
        const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "";
        const apiBase = wsUrl.replace("/ws", "").replace("ws://", "http://").replace("wss://", "https://");
        const res = await fetch(`${apiBase}/api/online-count`);
        if (res.ok) {
          const data = await res.json();
          setOnlineCount(data.count ?? null);
        }
      } catch {}
    };
    fetchOnline();
    const interval = setInterval(fetchOnline, ONLINE_COUNT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const onlineFriends = social.friends.filter(f => f.online);

  // Inline search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setSearchFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close notification dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchQuery.length >= 2) {
      const t = setTimeout(() => social.searchPlayers(searchQuery), 300);
      return () => clearTimeout(t);
    }
  }, [searchQuery, social]);

  const searchResults = social.searchResults;
  const showDropdown = searchFocused && searchQuery.length >= 2;

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === "Enter" && selectedIdx >= 0 && searchResults[selectedIdx]) {
        e.preventDefault();
        router.push("/social");
        setSearchFocused(false);
        setSearchQuery("");
      } else if (e.key === "Escape") {
        setSearchFocused(false);
        searchInputRef.current?.blur();
      }
    },
    [showDropdown, searchResults, selectedIdx, router],
  );

  return (
    <div className="p-4 md:px-6 lg:px-8 lg:py-6" style={{ width: "100%" }}>
      <Tutorial />
      {/* Top Bar */}
      <header className="flex flex-wrap items-center justify-between gap-4" style={{ marginBottom: 28 }}>

        <div>
          {onlineCount !== null && onlineCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-success)" }} />
              {onlineCount} online
            </div>
          )}
          <h1
            className="text-xl sm:text-2xl lg:text-[30px]"
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              color: "var(--color-text-primary)",
              margin: 0,
            }}
          >
            Welcome back, {playerName}
          </h1>
          <p
            style={{
              fontSize: "0.875rem",
              color: "var(--color-text-muted)",
              margin: "4px 0 0",
              fontFamily: "var(--font-body)",
            }}
          >
            {onlineCount > 0 ? `${onlineCount.toLocaleString()} players online right now` : "Welcome to Backgammon"}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Search */}
          <div
            ref={searchContainerRef}
            className="hidden md:flex"
            style={{
              position: "relative",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 6,
              background: "var(--color-bg-surface)",
            }}
          >
            {Icons.search("var(--color-text-faint)")}
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search players..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSelectedIdx(-1); }}
              onFocus={() => setSearchFocused(true)}
              onKeyDown={handleSearchKeyDown}
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: "0.8125rem",
                color: "var(--color-text-primary)",
                fontFamily: "var(--font-body)",
                width: 140,
              }}
            />
            {!searchFocused && searchQuery.length === 0 && (
              <span
                style={{
                  fontSize: "0.625rem",
                  color: "var(--color-text-faint)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 4,
                  padding: "1px 6px",
                  fontFamily: "var(--font-mono)",
                }}
              >
                &#8984;K
              </span>
            )}

            {/* Dropdown results */}
            {showDropdown && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  minWidth: 280,
                  background: "var(--color-bg-surface)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 8,
                  boxShadow: "var(--shadow-elevated)",
                  zIndex: 50,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                {searchResults.length > 0 ? (
                  searchResults.map((r, i) => (
                    <div
                      key={r.address}
                      onClick={() => {
                        router.push("/social");
                        setSearchFocused(false);
                        setSearchQuery("");
                      }}
                      onMouseEnter={() => setSelectedIdx(i)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        cursor: "pointer",
                        background: i === selectedIdx ? "var(--color-bg-elevated)" : "transparent",
                        transition: "background 0.1s ease",
                      }}
                    >
                      <Avatar name={r.displayName || r.username || r.address.slice(0, 6)} size="xs" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)" }}>
                          {r.displayName || r.username || r.address.slice(0, 8)}
                        </div>
                        {r.username && (
                          <div style={{ fontSize: "0.625rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                            @{r.username}
                          </div>
                        )}
                      </div>
                      {social.friends.some((f) => f.address === r.address) ? (
                        <span style={{ fontSize: "0.625rem", color: "var(--color-success)", fontWeight: 600 }}>
                          Friends
                        </span>
                      ) : social.outgoingRequests.includes(r.address) ? (
                        <span style={{ fontSize: "0.625rem", color: "var(--color-text-muted)", fontWeight: 600 }}>
                          Sent
                        </span>
                      ) : social.incomingRequests.some((req) => req.address === r.address) ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            social.acceptFriendRequest(r.address);
                          }}
                          style={{
                            padding: "3px 8px",
                            borderRadius: 5,
                            border: "1px solid var(--color-success)",
                            background: "var(--color-success-muted)",
                            fontSize: "0.625rem",
                            fontWeight: 600,
                            color: "var(--color-success)",
                            cursor: "pointer",
                            fontFamily: "var(--font-body)",
                          }}
                        >
                          Accept
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            social.sendFriendRequest(r.address);
                          }}
                          style={{
                            padding: "3px 8px",
                            borderRadius: 5,
                            border: "1px solid var(--color-gold-primary)",
                            background: "var(--color-gold-muted)",
                            fontSize: "0.625rem",
                            fontWeight: 600,
                            color: "var(--color-gold-primary)",
                            cursor: "pointer",
                            fontFamily: "var(--font-body)",
                          }}
                        >
                          Add
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: "16px 12px", textAlign: "center", fontSize: "0.75rem", color: "var(--color-text-faint)" }}>
                    No players found
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Notification Bell + Dropdown */}
          <div ref={notifRef} style={{ position: "relative" }}>
            <button
              aria-label="Notifications"
              onClick={() => setNotifOpen(!notifOpen)}
              style={{
                width: 44,
                height: 44,
                borderRadius: 6,
                border: `1px solid ${notifOpen ? "var(--color-gold-primary)" : "var(--color-border-subtle)"}`,
                background: notifOpen ? "var(--color-bg-elevated)" : "var(--color-bg-surface)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
            >
              {Icons.bell(notifOpen ? "var(--color-gold-primary)" : "var(--color-text-muted)")}
              {totalNotifications > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    minWidth: 16,
                    height: 16,
                    borderRadius: 8,
                    background: "var(--color-gold-primary)",
                    color: "var(--color-gold-text, #000)",
                    fontSize: "0.625rem",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 4px",
                  }}
                >
                  {totalNotifications}
                </div>
              )}
            </button>

            {notifOpen && (
              <div
                style={{
                  position: "absolute",
                  top: 52,
                  right: 0,
                  width: 320,
                  maxHeight: 400,
                  overflowY: "auto",
                  background: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                  zIndex: 100,
                }}
              >
                <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--color-border-subtle)" }}>
                  <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: "var(--color-text-primary)" }}>
                    Notifications
                  </span>
                </div>

                {totalNotifications === 0 ? (
                  <div style={{ padding: "24px 14px", textAlign: "center", fontSize: "0.8125rem", color: "var(--color-text-faint)" }}>
                    No notifications
                  </div>
                ) : (
                  <div>
                    {/* Challenge Requests */}
                    {pendingChallenges?.map((c) => (
                      <div key={c.challengeId} style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border-subtle)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <Avatar name={c.fromName || c.fromAddress} size="xs" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-primary)" }}>
                              {c.fromName || `${c.fromAddress.slice(0, 8)}...`}
                            </div>
                            <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)" }}>
                              Wants to play a match
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={() => { acceptChallenge(c.challengeId); setNotifOpen(false); }}
                            style={{
                              flex: 1, padding: "6px 0", borderRadius: 6, border: "none",
                              background: "var(--color-gold-primary)", color: "var(--color-gold-text, #000)",
                              fontSize: "0.75rem", fontWeight: 700, cursor: "pointer",
                            }}
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => declineChallenge(c.challengeId)}
                            style={{
                              flex: 1, padding: "6px 0", borderRadius: 6,
                              border: "1px solid var(--color-border-subtle)", background: "transparent",
                              color: "var(--color-text-secondary)", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
                            }}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Friend Requests */}
                    {incomingRequests?.map((r) => (
                      <div key={r.address} style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border-subtle)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <Avatar name={r.displayName || r.address} size="xs" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--color-text-primary)" }}>
                              {r.displayName || `${r.address.slice(0, 8)}...`}
                            </div>
                            <div style={{ fontSize: "0.6875rem", color: "var(--color-text-muted)" }}>
                              Friend request
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={() => acceptFriendRequest(r.address)}
                            style={{
                              flex: 1, padding: "6px 0", borderRadius: 6, border: "none",
                              background: "var(--color-gold-primary)", color: "var(--color-gold-text, #000)",
                              fontSize: "0.75rem", fontWeight: 700, cursor: "pointer",
                            }}
                          >
                            Accept
                          </button>
                          <button
                            onClick={() => rejectFriendRequest(r.address)}
                            style={{
                              flex: 1, padding: "6px 0", borderRadius: 6,
                              border: "1px solid var(--color-border-subtle)", background: "transparent",
                              color: "var(--color-text-secondary)", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
                            }}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Footer link to social page */}
                <div
                  onClick={() => { setNotifOpen(false); router.push("/social"); }}
                  style={{
                    padding: "10px 14px", textAlign: "center", cursor: "pointer",
                    fontSize: "0.75rem", fontWeight: 600, color: "var(--color-gold-primary)",
                    borderTop: "1px solid var(--color-border-subtle)",
                  }}
                >
                  View all friends &amp; activity
                </div>
              </div>
            )}
          </div>

          {/* Wallet */}
          {!isNativeApp && (
          <div
            onClick={() => router.push("/wallet")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: 6,
              background: "var(--color-gold-muted)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                fontSize: "0.8125rem",
                fontWeight: 700,
                color: "var(--color-gold-primary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {balanceLoading || balance === null ? "$--" : `$${balance}`}
            </span>
            <span
              style={{
                fontSize: "0.625rem",
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-body)",
              }}
            >
              USDC
            </span>
          </div>
          )}

          {/* Logout */}
          <button
            onClick={() => { logout(); router.push("/login"); }}
            style={{
              width: 44,
              height: 44,
              borderRadius: 6,
              border: "1px solid var(--color-border-subtle)",
              background: "var(--color-bg-surface)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Log out"
            aria-label="Log out"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5">
              <path d="M7 17H4a1 1 0 01-1-1V4a1 1 0 011-1h3M14 14l4-4-4-4M18 10H7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* Play Mode Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5" style={{ marginBottom: 40 }}>

        {/* Play a Friend — spans full width */}
        <Card className="md:col-span-2 hover:shadow-elevated hover:-translate-y-px transition-all cursor-pointer">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {Icons.users("var(--color-gold-light)")}
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.625rem",
                fontWeight: 700,
                margin: 0,
                color: "var(--color-text-primary)",
              }}
            >
              Play a Friend
            </h3>
          </div>
          <p
            style={{
              fontSize: "0.875rem",
              color: "var(--color-text-muted)",
              margin: "0 0 20px",
              lineHeight: 1.5,
            }}
          >
            Create a private game or join one with a code.
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => router.push("/create-match")}
              style={{
                flex: 1,
                padding: "14px 20px",
                borderRadius: 6,
                border: "none",
                background: "var(--color-gold-primary)",
                color: "var(--color-accent-fg)",
                fontSize: "0.875rem",
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Create Game &rarr; Get Code
            </button>
            <button
              onClick={() => router.push("/join")}
              style={{
                flex: 1,
                padding: "14px 20px",
                borderRadius: 6,
                border: "1.5px solid var(--color-border-subtle)",
                background: "transparent",
                color: "var(--color-text-secondary)",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Paste Code &rarr; Join Game
            </button>
          </div>
        </Card>

        {/* Play vs AI */}
        <Card className="hover:shadow-elevated hover:-translate-y-px transition-all cursor-pointer">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {Icons.brain("var(--color-gold-light)")}
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.625rem",
                fontWeight: 700,
                margin: 0,
                color: "var(--color-text-primary)",
              }}
            >
              Play vs AI
            </h3>
          </div>
          <p
            style={{
              fontSize: "0.875rem",
              color: "var(--color-text-muted)",
              margin: "0 0 20px",
              lineHeight: 1.5,
            }}
          >
            Practice against XG-level AI. Choose difficulty from beginner to
            grandmaster.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            {["Beginner", "Club", "Expert", "GM"].map((lvl) => (
              <button
                key={lvl}
                onClick={() =>
                  router.push(
                    `/ai-match?difficulty=${lvl.toLowerCase()}`
                  )
                }
                aria-label={`Play AI ${lvl} difficulty`}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border-subtle)",
                  background: "transparent",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-body)",
                  textAlign: "center",
                  cursor: "pointer",
                  minHeight: 44,
                }}
              >
                {lvl}
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">

        {/* LEFT COLUMN */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {/* Stats */}
          <Card>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 16,
              }}
            >
              <h3
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  margin: 0,
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-body)",
                }}
              >
                Your Stats
              </h3>
              <button
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "0.75rem",
                  color: "var(--color-text-secondary)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--font-body)",
                }}
              >
                View all {Icons.chevron("var(--color-text-secondary)")}
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Stat
                label="Rating"
                value={stats ? stats.rating.toLocaleString() : "--"}
                sub={stats && stats.ratingChange !== 0 ? `${stats.ratingChange > 0 ? "↑" : "↓"} ${Math.abs(stats.ratingChange)}` : undefined}
              />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <Stat label="W / L" value={stats ? `${stats.wins}/${stats.losses}` : "--"} />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <Stat label="Avg PR" value="--" />
              <div style={{ width: 1, background: "var(--color-border-subtle)" }} />
              <Stat
                label="Streak"
                value={stats && stats.currentStreak > 0 ? `${stats.currentStreak}${stats.currentStreakType}` : "--"}
              />
            </div>
          </Card>

          {/* Recent Matches */}
          <Card>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <h3
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  margin: 0,
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-body)",
                }}
              >
                Recent Matches
              </h3>
              <button
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "0.75rem",
                  color: "var(--color-text-secondary)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--font-body)",
                }}
              >
                Full history {Icons.chevron("var(--color-text-secondary)")}
              </button>
            </div>
            {matches.length > 0 ? matches.map((m, i) => (
              <MatchRowStyled
                key={i}
                opponent={m.opponentName || m.opponent.slice(0, 10)}
                result={m.result}
                score={m.resultType}
                pr="--"
                date={timeAgo(m.timestamp)}
              />
            )) : (
              <div style={{ padding: "24px 0", textAlign: "center" }}>
                <div style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)", marginBottom: 12 }}>
                  No recent matches yet. Start your first game!
                </div>
                <button
                  onClick={() => router.push("/ai-match")}
                  style={{
                    padding: "10px 20px",
                    borderRadius: 6,
                    border: "none",
                    background: "var(--color-gold-primary)",
                    color: "var(--color-accent-fg, var(--color-bg-deepest))",
                    fontSize: "0.8125rem",
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                    minHeight: 44,
                  }}
                >
                  Play vs AI
                </button>
              </div>
            )}
          </Card>
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {/* Provably Fair */}
          <Card
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border-subtle)",
              borderLeft: "3px solid var(--color-burgundy-primary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              {Icons.shield("var(--color-gold-primary)")}
              <h3
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.0625rem",
                  fontWeight: 700,
                  margin: 0,
                  color: "var(--color-text-primary)",
                }}
              >
                Provably Fair
              </h3>
            </div>
            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--color-text-muted)",
                margin: "0 0 12px",
                lineHeight: 1.5,
              }}
            >
              Every dice roll is cryptographically verified. Check any roll
              anytime.
            </p>
            <button
              onClick={() => router.push("/verify-rolls")}
              style={{
                background: "transparent",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: "0.6875rem",
                fontWeight: 600,
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Verify past rolls &rarr;
            </button>
          </Card>

          {/* Friends Online */}
          <Card>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <h3
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  margin: 0,
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-body)",
                }}
              >
                Friends Online
              </h3>
              <span
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-text-faint)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {onlineFriends.length}
              </span>
            </div>
            {onlineFriends.length > 0 ? onlineFriends.slice(0, 6).map(f => (
              <PlayerRowStyled
                key={f.address}
                name={f.displayName || f.address.slice(0, 10)}
                rating=""
                status="online"
              />
            )) : (
              <div style={{ padding: "20px 0", textAlign: "center" }}>
                <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: 10 }}>
                  {social.friends.length === 0 ? "No friends added yet. Find players to connect with!" : "No friends online. Find new players!"}
                </div>
                <button
                  onClick={() => router.push("/social")}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 6,
                    background: "transparent",
                    border: "1px solid var(--color-gold-primary)",
                    color: "var(--color-gold-primary)",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                    minHeight: 44,
                  }}
                >
                  {social.friends.length === 0 ? "Find Players" : "Browse Players"}
                </button>
              </div>
            )}
          </Card>


        </div>
      </div>
    </div>
  );
}
