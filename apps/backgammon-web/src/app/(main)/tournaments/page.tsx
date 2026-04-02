"use client";

import { useEffect, useState, useCallback } from "react";
import { API_BASE } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

interface Tournament {
  id: string;
  name: string;
  entryFee: number;
  maxPlayers: number;
  playerCount: number;
  startAt: number;
}

export default function TournamentsPage() {
  const { address, isConnected } = useAuth();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);

  const fetchTournaments = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tournaments`);
      if (res.ok) {
        const data = await res.json();
        setTournaments(data.tournaments || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTournaments();
  }, [fetchTournaments]);

  const register = useCallback(async (tournamentId: string) => {
    if (!address) return;
    setRegistering(tournamentId);
    try {
      const res = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (res.ok) {
        fetchTournaments(); // Refresh to update player count
      } else {
        const err = await res.json();
        alert(err.error || "Registration failed");
      }
    } catch {
      alert("Registration failed");
    }
    setRegistering(null);
  }, [address, fetchTournaments]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{
        fontFamily: "var(--font-display)",
        fontSize: "1.5rem",
        color: "var(--color-text-primary)",
        marginBottom: 8,
      }}>
        Tournaments
      </h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem", marginBottom: 24 }}>
        Compete in bracket-style tournaments with prize pools. Entry fees are locked from your balance.
      </p>

      {loading ? (
        <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem" }}>Loading tournaments...</p>
      ) : tournaments.length === 0 ? (
        <div style={{
          background: "var(--color-bg-surface)",
          borderRadius: "var(--radius-card)",
          padding: "48px 24px",
          textAlign: "center",
          boxShadow: "var(--shadow-card)",
        }}>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.9375rem", marginBottom: 8 }}>
            No upcoming tournaments
          </p>
          <p style={{ color: "var(--color-text-faint)", fontSize: "0.8125rem" }}>
            Check back soon. Tournaments will be scheduled here.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tournaments.map((t) => (
            <div
              key={t.id}
              style={{
                background: "var(--color-bg-surface)",
                borderRadius: "var(--radius-card)",
                padding: "16px 20px",
                boxShadow: "var(--shadow-card)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1rem",
                  color: "var(--color-text-primary)",
                  marginBottom: 4,
                }}>
                  {t.name}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                  {formatTime(t.startAt)} · {t.playerCount}/{t.maxPlayers} players
                  {t.entryFee > 0 && ` · ${t.entryFee} USDC entry`}
                </div>
              </div>

              <button
                onClick={() => register(t.id)}
                disabled={!isConnected || registering === t.id || t.playerCount >= t.maxPlayers}
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                  padding: "8px 20px",
                  borderRadius: "var(--radius-button)",
                  background: t.playerCount >= t.maxPlayers ? "var(--color-bg-elevated)" : "var(--color-gold-primary)",
                  color: t.playerCount >= t.maxPlayers ? "var(--color-text-muted)" : "var(--color-accent-fg)",
                  border: "none",
                  cursor: t.playerCount >= t.maxPlayers ? "default" : "pointer",
                  opacity: registering === t.id ? 0.6 : 1,
                }}
              >
                {t.playerCount >= t.maxPlayers ? "Full" : registering === t.id ? "Registering..." : "Register"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
