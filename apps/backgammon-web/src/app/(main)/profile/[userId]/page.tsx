"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { cn } from "@xion-beginner/ui";
import { Header } from "@/components/layout";
import {
  Card,
  StatCell,
  TabBar,
  MatchRow,
} from "@/components/ui";
import { ApiResponseError, fetchStats, fetchMatches, fetchProfile, timeAgo } from "@/lib/api";
import type { PlayerStats, MatchResult as MatchResultType, PlayerProfile } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

const TABS = [
  { id: "history", label: "Match History" },
  { id: "h2h", label: "Head to Head" },
];

/* ── Quick Stat ── */
function QuickStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="text-center flex-1">
      <div className="text-xl font-bold text-text-primary font-mono tracking-tight">{value}</div>
      <div className="text-[10px] text-text-muted uppercase tracking-[0.04em] font-semibold mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-text-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

export default function UserProfilePage() {
  const params = useParams<{ userId: string }>();
  const [activeTab, setActiveTab] = useState("history");
  const { address: myAddress } = useAuth();

  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [matches, setMatches] = useState<MatchResultType[]>([]);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "partial" | "failed" | "not_found">("loading");
  const [matchesAvailable, setMatchesAvailable] = useState<boolean | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    setProfile(null);
    setStats(null);
    setMatches([]);
    setMatchesAvailable(null);
    void Promise.allSettled([
      fetchProfile(params.userId),
      fetchStats(params.userId),
      fetchMatches(params.userId, 20),
    ]).then(([profileResult, statsResult, matchesResult]) => {
      if (!active) return;
      if (
        profileResult.status === "rejected"
        && profileResult.reason instanceof ApiResponseError
        && profileResult.reason.status === 404
      ) {
        setLoadState("not_found");
        return;
      }
      if (profileResult.status === "fulfilled") setProfile(profileResult.value);
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      if (matchesResult.status === "fulfilled") {
        setMatches(matchesResult.value);
        setMatchesAvailable(true);
      } else {
        setMatchesAvailable(false);
      }
      const failures = [profileResult, statsResult, matchesResult].filter((result) => result.status === "rejected").length;
      setLoadState(failures === 3 ? "failed" : failures > 0 ? "partial" : "ready");
    });
    return () => { active = false; };
  }, [params.userId, reloadVersion]);

  if (loadState === "not_found" || loadState === "failed") {
    const notFound = loadState === "not_found";
    return (
      <div>
        <Header title={notFound ? "Player not found" : "Profile unavailable"} backHref="/leaderboard" actions={null} />
        <main className="max-w-[700px] p-6">
          <section className="rounded border border-border-subtle p-5">
            <h1 className="font-display text-2xl font-bold">
              {notFound ? "No player profile exists" : "Player profile is temporarily unavailable"}
            </h1>
            <p className="mt-2 text-sm text-text-secondary">
              {notFound
                ? "This address has no public Gammon profile."
                : "No rating, record, or match history has been estimated."}
            </p>
            {!notFound && (
              <button type="button" className="btn-secondary mt-4 min-h-11" onClick={() => setReloadVersion((value) => value + 1)}>
                Retry
              </button>
            )}
          </section>
        </main>
      </div>
    );
  }

  const playerName = profile?.displayName || params.userId.slice(0, 12);
  const rating = stats?.rating;
  const ratingChange = stats?.ratingChange;
  const wins = stats?.wins;
  const losses = stats?.losses;
  const totalGames = stats?.totalGames;
  const streakStr = stats && stats.currentStreak > 0 ? `${stats.currentStreak}${stats.currentStreakType}` : stats ? "—" : "Unavailable";
  const memberSince = profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "Unavailable";

  const h2hMatches = matches.filter(m => m.opponent === myAddress);
  const h2hWins = h2hMatches.filter(m => m.result === "L").length;
  const h2hLosses = h2hMatches.filter(m => m.result === "W").length;
  const h2hTotal = h2hMatches.length;
  const h2hWinRate = h2hTotal > 0 ? Math.round((h2hWins / h2hTotal) * 100) : 0;

  return (
    <div>
      <Header
        title={playerName}
        backHref="/leaderboard"
        actions={null}
      />

      <div className="p-6 space-y-0 max-w-[700px]">
        {loadState === "loading" && <p role="status" className="mb-4 rounded border border-border-subtle p-3 text-sm text-text-secondary">Loading player profile…</p>}
        {loadState === "partial" && <p role="status" className="mb-4 rounded border border-border-subtle p-3 text-sm text-text-secondary">Some player records are temporarily unavailable. Unavailable values are not estimated.</p>}
        
        {/* Profile Header */}
        <Card>
          <div className="flex gap-5 items-start">
            <div className="relative">
              <div className="w-20 h-20 rounded-full bg-bg-elevated border-2 border-border-subtle flex items-center justify-center text-[30px] font-bold text-text-secondary">
                {playerName[0]}
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2.5 mb-1">
                <span className="font-display text-2xl sm:text-[36px] font-bold text-text-primary tracking-tight">{playerName}</span>
                <div className="flex items-baseline gap-1 px-2.5 py-0.5 rounded-[6px] bg-bg-base border border-border-subtle">
                  <span className="text-base font-bold text-text-primary font-mono">{rating === undefined ? "—" : rating.toLocaleString()}</span>
                  {ratingChange !== undefined && <span className={cn("text-[11px] font-bold", ratingChange >= 0 ? "text-success" : "text-danger")}>
                    {ratingChange >= 0 ? "↑" : "↓"}{Math.abs(ratingChange)}
                  </span>}
                </div>
              </div>
              <div className="text-[13px] text-text-secondary mb-1.5">{profile?.username ? `@${profile.username}` : "Backgammon player"}</div>
              <div className="text-[11px] text-text-muted">Member since {memberSince}</div>
            </div>
          </div>

          <div className="flex gap-0 mt-5 pt-4 border-t border-border-subtle">
            <QuickStat label="Games" value={totalGames === undefined ? "Unavailable" : totalGames.toLocaleString()} />
            <div className="w-px bg-bg-subtle" />
            <QuickStat label="W / L" value={wins === undefined || losses === undefined ? "Unavailable" : `${wins} / ${losses}`} />
            <div className="w-px bg-bg-subtle" />
            <QuickStat label="Avg PR" value="Unavailable" />
            <div className="w-px bg-bg-subtle" />
            <QuickStat label="Streak" value={streakStr} />
          </div>
        </Card>

        {/* Tab Bar */}
        <Card padding="none" className="!rounded-t-none !border-t-0 mb-5">
          <TabBar tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} className="px-4" />
        </Card>

        {/* Match History Tab */}
        {activeTab === "history" && (
          <Card>
            {matchesAvailable === false ? (
              <div className="text-center text-text-muted text-sm py-5">Match history is temporarily unavailable.</div>
            ) : matches.length > 0 ? matches.map((m, i) => (
              <MatchRow
                key={i}
                opponent={m.opponentName || m.opponent.slice(0, 10)}
                result={m.result === "W" ? "win" : "loss"}
                score={m.resultType}
                matchLength={0}
                date={timeAgo(m.timestamp)}
              />
            )) : (
              <div className="text-center text-text-muted text-sm py-5">No matches yet.</div>
            )}
          </Card>
        )}

        {/* Head to Head Tab */}
        {activeTab === "h2h" && (
          <Card>
            {h2hTotal > 0 ? (
              <>
                <p className="text-sm text-text-secondary mb-4">
                  You&apos;ve played <span className="font-semibold text-text-primary">{h2hTotal} {h2hTotal === 1 ? "match" : "matches"}</span> against {playerName}
                </p>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <StatCell label="Your Wins" value={String(h2hWins)} />
                  <StatCell label="Their Wins" value={String(h2hLosses)} />
                  <StatCell label="Win Rate" value={`${h2hWinRate}%`} />
                </div>
                <div className="border-t border-border-subtle pt-2">
                  {h2hMatches.map((m, i) => (
                    <MatchRow
                      key={i}
                      opponent={playerName}
                      result={m.result === "W" ? "loss" : "win"}
                      score={m.resultType}
                      matchLength={0}
                      date={timeAgo(m.timestamp)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="text-center text-text-muted text-sm py-5">No head-to-head matches yet</div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
