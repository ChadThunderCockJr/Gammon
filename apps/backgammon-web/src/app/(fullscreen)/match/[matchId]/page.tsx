"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { useGame } from "@/hooks/useGame";
import { useSocialContext } from "@/contexts/SocialContext";
import { GameScreen, type CashGameTerms } from "@/components/GameScreen";
import { useAuth } from "@/hooks/useAuth";
import { WS_URL } from "@/lib/ws-config";
import { authenticatedFetch } from "@/lib/server-session";
import { FUNDS_MODE, VERUSD_ESCROW_CONTRACT } from "@/lib/config";
import { withReturnTo } from "@/lib/return-to";

const CashQuoteSchema = z.object({
  id: z.string().uuid(),
  gameId: z.string().uuid(),
  stakeMicroUsd: z.string().regex(/^\d+$/),
  reservePerPlayerMicroUsd: z.string().regex(/^\d+$/),
  rakeBps: z.number().int().nonnegative(),
  cubeCap: z.number().int().positive(),
  state: z.string(),
  fundsMode: z.enum(["free", "verusd_testnet", "verusd_production"]).optional(),
  testFunds: z.boolean().optional(),
  fundedStartAcknowledged: z.boolean().optional(),
  cashSessionStartedAt: z.string().datetime().nullable().optional(),
  realityCheckDueAt: z.string().datetime().nullable().optional(),
}).passthrough();

type CashQuote = z.infer<typeof CashQuoteSchema>;

function cashTermsFromQuote(
  quote: CashQuote,
  context: { readonly custodyRecipient: string | null },
): CashGameTerms {
  return {
    quoteId: quote.id,
    stakeMicroUsd: quote.stakeMicroUsd,
    reservePerPlayerMicroUsd: quote.reservePerPlayerMicroUsd,
    rakeBps: quote.rakeBps,
    cubeCap: quote.cubeCap,
    state: quote.state,
    testFunds: quote.testFunds ?? (quote.fundsMode === "verusd_testnet" || FUNDS_MODE === "verusd_testnet"),
    custodyRecipient: context.custodyRecipient,
    cashSessionStartedAt: quote.cashSessionStartedAt ?? null,
    realityCheckDueAt: quote.realityCheckDueAt ?? null,
  };
}
function reviewReasonMessage(reason: string | null): string {
  switch (reason) {
    case "disconnect_timeout":
      return "A disconnect could not be resolved automatically.";
    case "proof_unavailable":
    case "dice_proof_unavailable":
      return "The game proof could not be verified automatically.";
    case "platform_recovery":
      return "The game is being recovered after a service interruption.";
    case "settlement_failed":
      return "Settlement needs manual reconciliation.";
    default:
      return "An integrity check requires manual review.";
  }
}

const CASH_CONTEXT = Object.freeze({
  custodyRecipient: VERUSD_ESCROW_CONTRACT,
});

export default function MatchPage() {
  const router = useRouter();
  const params = useParams();
  const matchId = params.matchId as string;
  const searchParams = useSearchParams();
  const cashQuoteParam = searchParams.get("cashQuote");
  const cashQuote = cashQuoteParam && /^[0-9a-f-]{36}$/i.test(cashQuoteParam) ? cashQuoteParam : null;
  const { address, isConnected, isConnecting } = useAuth();
  const [loadedCashTerms, setLoadedCashTerms] = useState<{ quoteId: string; terms: CashGameTerms } | null>(null);
  const [cashTermsFailure, setCashTermsFailure] = useState<{ quoteId: string; message: string } | null>(null);
  const [cashTermsReload, setCashTermsReload] = useState(0);
  const [timedOutMatch, setTimedOutMatch] = useState<string | null>(null);
  const [resumePending, setResumePending] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const requestedCashReviewFor = useRef<string | null>(null);
  const cashTerms = cashQuote && loadedCashTerms?.quoteId === cashQuote ? loadedCashTerms.terms : null;
  const cashTermsError = cashQuote && cashTermsFailure?.quoteId === cashQuote ? cashTermsFailure.message : null;
  const cashTermsVerified = cashQuote === null || (cashTerms !== null && cashTermsError === null);

  useEffect(() => {
    if (!isConnecting && !isConnected) {
      const query = searchParams.toString();
      window.location.replace(withReturnTo(
        "/login",
        `/match/${encodeURIComponent(matchId)}${query ? `?${query}` : ""}`,
      ));
    }
  }, [isConnected, isConnecting, matchId, searchParams]);

  const {
    gameState,
    myColor,
    legalMoves,
    opponent,
    opponentDisconnected,
    winner,
    resultType,
    connected,
    canUndo,
    canDouble,
    doubleOffered,
    doubleOfferedBy,
    doubleOfferDeadlineAt,
    status,
    reviewReason,
    error,
    turnStartedAt,
    lastOpponentMove,
    lastReaction,
    pendingConfirmation,
    forcedMoveNotice,
    disconnectCountdown,
    makeMove,
    rollDice,
    endTurn,
    undoMove,
    resign,
    offerDouble,
    acceptDouble,
    rejectDouble,
    sendReaction,
    reset,
    turnHistory,
    matchTurnHistory,
    matchState,
    matchOver,
    turnTimeLimit,
    authenticated,
    joinGame,
    joinCashGame,
    requestCashReview,
  } = useGame(WS_URL, address, matchId);
  const loadTimedOut = timedOutMatch === matchId && !gameState && status !== "review";
  useEffect(() => {
    if (!cashQuote || !authenticated) return;
    let disposed = false;
    void authenticatedFetch(`/api/cash-games/quotes/${cashQuote}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("The signed cash-game quote could not be loaded.");
        let quote = z.object({ quote: CashQuoteSchema }).parse(await response.json()).quote;
        if (quote.gameId !== matchId) throw new Error("The cash-game quote does not match this game.");
        if (quote.state === "active" && !quote.fundedStartAcknowledged) {
          const acknowledgement = await authenticatedFetch(`/api/cash-games/quotes/${cashQuote}/funded-start-ack`, { method: "POST" });
          if (!acknowledgement.ok) throw new Error("The cash-match start could not be confirmed.");
          quote = z.object({ quote: CashQuoteSchema }).parse(await acknowledgement.json()).quote;
          if (quote.gameId !== matchId || !quote.fundedStartAcknowledged) throw new Error("The cash-match start could not be confirmed.");
        }
        if (!disposed) {
          setLoadedCashTerms({ quoteId: cashQuote, terms: cashTermsFromQuote(quote, CASH_CONTEXT) });
          setCashTermsFailure(null);
        }
      })
      .catch(() => {
        if (!disposed) {
          setCashTermsFailure({
            quoteId: cashQuote,
            message: "The signed cash-game quote could not be confirmed. Cash play remains unavailable; retry terms.",
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [authenticated, cashQuote, cashTermsReload, matchId]);
  useEffect(() => {
    if (!authenticated || !matchId || gameState) return;
    if (cashQuote) {
      if (!cashTerms || cashTerms.quoteId !== cashQuote) return;
      joinCashGame(cashQuote);
      return;
    }
    joinGame(matchId);
  }, [authenticated, cashQuote, cashTerms, gameState, joinCashGame, joinGame, matchId]);
  const acknowledgeRealityCheck = useCallback(async () => {
    if (!cashQuote || !authenticated) throw new Error("Cash-game terms are not ready.");
    const response = await authenticatedFetch(`/api/cash-games/quotes/${cashQuote}/reality-check-ack`, { method: "POST" });
    if (!response.ok) throw new Error("The acknowledgement could not be recorded.");
    const quote = z.object({ quote: CashQuoteSchema }).parse(await response.json()).quote;
    if (quote.gameId !== matchId) throw new Error("The acknowledgement did not match this game.");
    setLoadedCashTerms({ quoteId: cashQuote, terms: cashTermsFromQuote(quote, CASH_CONTEXT) });
    setCashTermsFailure(null);
  }, [authenticated, cashQuote, matchId]);

  const requestCashResume = useCallback(async () => {
    if (!cashQuote || !authenticated || resumePending) return;
    setResumePending(true);
    setResumeNotice(null);
    try {
      const response = await authenticatedFetch(`/api/cash-games/quotes/${cashQuote}/resume`, { method: "POST" });
      if (!response.ok) throw new Error("resume rejected");
      const quote = z.object({ quote: CashQuoteSchema }).parse(await response.json()).quote;
      if (quote.gameId !== matchId) throw new Error("resume mismatch");
      setLoadedCashTerms({ quoteId: cashQuote, terms: cashTermsFromQuote(quote, CASH_CONTEXT) });
      setCashTermsFailure(null);
      if (quote.state === "active") {
        joinCashGame(cashQuote);
        setResumeNotice("Both players resumed. Restoring the server-recorded game state.");
      } else {
        setResumeNotice("Your resume consent is recorded. Waiting for the other player.");
      }
    } catch {
      setResumeNotice("The resume request could not be recorded. The game remains paused.");
    } finally {
      setResumePending(false);
    }
  }, [authenticated, cashQuote, joinCashGame, matchId, resumePending]);
  useEffect(() => {
    if (!cashTermsError || !gameState || requestedCashReviewFor.current === cashQuote) return;
    requestedCashReviewFor.current = cashQuote;
    requestCashReview();
  }, [cashQuote, cashTermsError, gameState, requestCashReview]);

  const { blockUser, reportUser, blockActions, reportActions } = useSocialContext();

  useEffect(() => {
    if (gameState || status === "review") return;
    const timer = window.setTimeout(() => setTimedOutMatch(matchId), 12_000);
    return () => window.clearTimeout(timer);
  }, [gameState, matchId, status]);

  if (status === "review") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-deepest)] p-6 text-[var(--color-text-primary)]">
        <section className="w-full max-w-lg rounded-xl border border-[var(--color-gold-primary)] bg-[var(--color-bg-surface)] p-6 text-center shadow-xl" role="alert">
          <h1 className="font-display text-2xl font-semibold">Game paused for review</h1>
          <p className="mt-3 text-sm text-[var(--color-text-secondary)]">
            Play is locked and reserved funds remain held. No winner or payout was inferred from the interruption.
          </p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {reviewReasonMessage(reviewReason)}
          </p>
          {cashQuote && (
            <button disabled={resumePending} onClick={() => void requestCashResume()} className="btn-secondary mt-4 min-h-11 px-5 disabled:opacity-50">
              {resumePending ? "Recording resume…" : "Resume with both players"}
            </button>
          )}
          {resumeNotice && <p className="mt-3 text-sm text-[var(--color-text-secondary)]" role="status">{resumeNotice}</p>}
          <Link className="btn-primary mt-5 inline-flex min-h-11 items-center justify-center px-5" href={`/activity${cashQuote ? `?cashQuote=${encodeURIComponent(cashQuote)}` : ""}`}>
            View review receipt
          </Link>
        </section>
      </main>
    );
  }


  // Loading state: waiting for server to send game state
  if (!gameState || !myColor) {
    return (
      <div
        style={{
          height: "100vh",
          background: "var(--color-bg-deepest)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-body)",
          color: "var(--color-text-primary)",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            border: "3px solid var(--color-border-subtle)",
            borderTopColor: "var(--color-gold-primary)",
            animation: "spin 1s linear infinite",
          }}
        />
        <p style={{ fontSize: "0.875rem", color: "var(--color-text-secondary)" }}>
          {connected ? "Loading game..." : "Connecting..."}
        </p>
        {(loadTimedOut || error || cashTermsError) && (
          <div className="max-w-md text-center" role="alert">
            <p className="text-sm text-[var(--color-danger)]">
              {cashTermsError ?? error ?? "The game did not load in time."}
            </p>
            <button
              className="btn-secondary mt-3 min-h-11"
              onClick={() => {
                setTimedOutMatch(null);
                if (cashQuote && cashTermsError) {
                  setCashTermsFailure(null);
                  setCashTermsReload((value) => value + 1);
                } else if (cashQuote) joinCashGame(cashQuote);
                else joinGame(matchId);
              }}
            >
              {cashTermsError ? "Retry cash terms" : "Retry"}
            </button>
          </div>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <>
    <GameScreen
      gameState={gameState}
      myColor={myColor}
      legalMoves={legalMoves}
      opponent={opponent}
      opponentDisconnected={opponentDisconnected}
      winner={winner}
      resultType={resultType}
      onMove={makeMove}
      onRollDice={rollDice}
      onEndTurn={endTurn}
      onResign={resign}
      onUndo={undoMove}
      canUndo={canUndo}
      canDouble={canDouble}
      onDouble={offerDouble}
      doubleOffered={doubleOffered}
      doubleOfferedBy={doubleOfferedBy}
      doubleOfferDeadlineAt={doubleOfferDeadlineAt}
      onAcceptDouble={acceptDouble}
      onRejectDouble={rejectDouble}
      cubeValue={gameState.cubeValue}
      cubeOwner={gameState.cubeOwner}
      turnStartedAt={turnStartedAt}
      lastOpponentMove={lastOpponentMove}
      turnHistory={turnHistory}
      pendingConfirmation={pendingConfirmation}
      blockAction={opponent ? blockActions[opponent] : undefined}
      reportAction={opponent ? reportActions[opponent] : undefined}
      forcedMoveNotice={forcedMoveNotice}
      disconnectCountdown={disconnectCountdown}
      onSendReaction={sendReaction}
      lastReaction={lastReaction}
      onBlockPlayer={blockUser}
      onReportPlayer={reportUser}
      opponentAddress={opponent}
      matchState={matchState}
      matchOver={matchOver}
      matchTurnHistory={matchTurnHistory}
      turnTimeLimit={turnTimeLimit}
      cashTerms={cashTerms}
      cashTermsRequired={cashQuote !== null}
      cashTermsVerified={cashTermsVerified}
      onAcknowledgeRealityCheck={acknowledgeRealityCheck}
      onNewGame={() => {
        reset();
        router.push("/matchmaking");
      }}
      onBackToLobby={() => {
        reset();
        router.push("/");
      }}
    />
    {cashQuote && cashTermsError && (
      <aside className="fixed bottom-4 left-1/2 z-[3000] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-bg-surface)] p-4 text-center shadow-lg" role="alert">
        <p>{cashTermsError} Financial actions remain disabled.</p>
        <button
          className="btn-secondary mt-3 min-h-11"
          onClick={() => {
            setCashTermsFailure(null);
            setCashTermsReload((value) => value + 1);
          }}
        >
          Retry terms
        </button>
      </aside>
    )}
    {cashQuote && gameState.gameOver && (
      <aside className="fixed left-1/2 top-4 z-[3000] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg border border-[var(--color-gold-primary)] bg-[var(--color-bg-surface)] p-4 text-center shadow-lg" aria-live="polite">
        <p className="font-semibold">Cash-game settlement is pending chain confirmation.</p>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">The game result is final; do not treat the payout as final until the receipt shows a settlement transaction.</p>
        <Link className="mt-2 inline-block underline" href={`/activity?cashQuote=${encodeURIComponent(cashQuote)}`}>View settlement receipt</Link>
      </aside>
    )}
    </>
  );
}
