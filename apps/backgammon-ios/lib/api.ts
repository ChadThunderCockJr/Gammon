import { API_BASE } from "./config";

export async function fetchGameHistory(gameId: string) {
  const res = await fetch(`${API_BASE}/api/game/${gameId}/history`);
  if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchDiceProofs(gameId: string) {
  const res = await fetch(`${API_BASE}/api/game/${gameId}/dice-proofs`);
  if (!res.ok) throw new Error(`Dice proofs fetch failed: ${res.status}`);
  return res.json();
}
