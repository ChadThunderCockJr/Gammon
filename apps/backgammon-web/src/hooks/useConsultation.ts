import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardState, Move, Player } from "@xion-beginner/backgammon-core";
import { getGnubgMoves, isGnubgReady, preloadGnubg } from "@/lib/gnubg";
import {
  buildGnubgTurnAnalysis,
  type ErrorClass,
  type CandidateMove,
} from "@/lib/analysis";

// ── Types ────────────────────────────────────────────────

export interface MoveAnalysis {
  errorClass: ErrorClass;
  equityLoss: number;
  bestMoves: Move[];
  candidates: CandidateMove[];
}

export interface ConsultationState {
  enabled: boolean;
  lastMoveAnalysis: MoveAnalysis | null;
  hintMoves: Move[] | null;
  hintLoading: boolean;
  analysisLoading: boolean;
  gnubgReady: boolean;
}

// ── Constants ────────────────────────────────────────────

const STORAGE_KEY = "gammon-consultation-enabled";
const GNUBG_POLL_MS = 500;

// ── Hook ─────────────────────────────────────────────────

export function useConsultation() {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  });
  const [lastMoveAnalysis, setLastMoveAnalysis] = useState<MoveAnalysis | null>(null);
  const [hintMoves, setHintMoves] = useState<Move[] | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [gnubgReady, setGnubgReady] = useState(isGnubgReady());

  // Staleness counters to discard results from superseded requests
  const hintSeqRef = useRef(0);
  const analysisSeqRef = useRef(0);

  // Preload GNUBG when consultation is enabled
  useEffect(() => {
    if (enabled) preloadGnubg();
  }, [enabled]);

  // Poll for GNUBG readiness until ready
  useEffect(() => {
    if (gnubgReady) return;
    const interval = setInterval(() => {
      if (isGnubgReady()) {
        setGnubgReady(true);
        clearInterval(interval);
      }
    }, GNUBG_POLL_MS);
    return () => clearInterval(interval);
  }, [gnubgReady]);

  // ── Toggle ──────────────────────────────────────────────

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch {}
      if (!next) {
        setLastMoveAnalysis(null);
        setHintMoves(null);
        setHintLoading(false);
        setAnalysisLoading(false);
      }
      return next;
    });
  }, []);

  // ── Hint ────────────────────────────────────────────────

  const requestHint = useCallback(
    async (board: BoardState, player: Player, movesRemaining: number[]) => {
      if (!isGnubgReady() || movesRemaining.length === 0) return;

      const seq = ++hintSeqRef.current;
      setHintLoading(true);
      setHintMoves(null);

      try {
        const dice: [number, number] = [
          movesRemaining[0],
          movesRemaining[movesRemaining.length > 1 ? 1 : 0],
        ];
        const results = await getGnubgMoves(board, player, dice, {
          maxMoves: 1,
          scoreMoves: true,
          plies: 0,
        });

        if (seq !== hintSeqRef.current) return; // stale

        if (results.length > 0 && results[0].moves.length > 0) {
          setHintMoves(results[0].moves);
        }
      } catch (err) {
        console.error("[Consultation] Hint failed:", err);
      } finally {
        if (seq === hintSeqRef.current) setHintLoading(false);
      }
    },
    [],
  );

  const clearHint = useCallback(() => {
    hintSeqRef.current++;
    setHintMoves(null);
    setHintLoading(false);
  }, []);

  // ── Move Analysis ───────────────────────────────────────

  const analyzeMove = useCallback(
    async (
      boardBefore: BoardState,
      player: Player,
      dice: [number, number],
      playedMoves: Move[],
    ) => {
      if (!isGnubgReady()) return;

      const seq = ++analysisSeqRef.current;
      setAnalysisLoading(true);

      try {
        const results = await getGnubgMoves(boardBefore, player, dice, {
          maxMoves: 0,
          scoreMoves: true,
          plies: 0,
        });

        if (seq !== analysisSeqRef.current) return; // stale

        const analysis = buildGnubgTurnAnalysis(
          0, // turnNumber doesn't matter for live analysis
          player,
          dice,
          playedMoves,
          boardBefore,
          results,
        );

        setLastMoveAnalysis({
          errorClass: analysis.errorClass,
          equityLoss: analysis.equityLoss,
          bestMoves: analysis.candidates.length > 0 ? analysis.candidates[0].moves : [],
          candidates: analysis.candidates,
        });
      } catch (err) {
        console.error("[Consultation] Analysis failed:", err);
      } finally {
        if (seq === analysisSeqRef.current) setAnalysisLoading(false);
      }
    },
    [],
  );

  const clearAnalysis = useCallback(() => {
    analysisSeqRef.current++;
    setLastMoveAnalysis(null);
    setAnalysisLoading(false);
  }, []);

  return {
    enabled,
    lastMoveAnalysis,
    hintMoves,
    hintLoading,
    analysisLoading,
    gnubgReady,
    toggle,
    requestHint,
    clearHint,
    analyzeMove,
    clearAnalysis,
  };
}
