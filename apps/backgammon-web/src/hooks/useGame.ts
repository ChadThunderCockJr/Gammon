import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { GameState, Player, Move, MatchState } from "@xion-beginner/backgammon-core";
import {
  canDouble as checkCanDouble,
  makeMove as coreMakeMove,
  getLegalFirstMoves,
} from "@xion-beginner/backgammon-core";
import { useAbstraxionSigningClient } from "@burnt-labs/abstraxion";
import { useWebSocket } from "./useWebSocket";
import {
  playDiceRoll,
  playCheckerPlace,
  playCheckerHit,
  playTurnEnd,
  playGameOver,
} from "@/lib/sounds";
import { CLEAR_LAST_MOVE_DELAY_MS, CLEAR_REACTION_DELAY_MS } from "@/lib/constants";
import { USDC_DENOM } from "@/lib/config";
import type { GameContext, GameAction } from "./useGame.types";
export type { GameContext, GameAction };
import { initialGameContext } from "./useGame.types";
export { initialGameContext };
import { gameReducer } from "./useGame.reducer";


// Types, initial state, and reducer extracted to useGame.types.ts and useGame.reducer.ts

export function useGame(wsUrl: string, address: string | null) {
  const { connect, sendMessage, connected, on } = useWebSocket(wsUrl);
  const [state, dispatch] = useReducer(gameReducer, initialGameContext);
  const { signArb, client: abstraxionClient } = useAbstraxionSigningClient();
  const addressRef = useRef(address);
  addressRef.current = address;
  const myColorRef = useRef(state.myColor);
  myColorRef.current = state.myColor;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Track whether we're flushing buffered moves to server
  const flushingRef = useRef(false);

  // Track auth_challenge nonce from server
  const [authNonce, setAuthNonce] = useState<string | null>(null);
  const authSentRef = useRef(false);
  const [authenticated, setAuthenticated] = useState(false);

  // Connect when address is available
  useEffect(() => {
    if (address) {
      connect();
    }
  }, [address, connect]);

  // Listen for auth_challenge from server
  useEffect(() => {
    const unsub = on("auth_challenge", (msg) => {
      setAuthNonce(msg.nonce as string);
      authSentRef.current = false;
    });
    return unsub;
  }, [on]);

  // Listen for auth_ok — marks authentication as complete
  useEffect(() => {
    const unsub = on("auth_ok", () => setAuthenticated(true));
    return unsub;
  }, [on]);

  // Authenticate with wallet signature once nonce + signing are available
  useEffect(() => {
    if (!connected || !address || !authNonce || authSentRef.current) return;

    if (signArb && abstraxionClient) {
      let cancelled = false;
      (async () => {
        try {
          // Get session key account data from the Abstraxion signing client
          const accountData = await abstraxionClient.getGranteeAccountData();
          if (!accountData) throw new Error("No grantee account data available");
          // Sign the nonce with the session key
          const signature = await signArb(accountData.address, authNonce);
          const pubkey = btoa(String.fromCharCode(...accountData.pubkey));
          if (!cancelled) {
            sendMessage({
              type: "auth",
              address,
              signature,
              pubkey,
              nonce: authNonce,
              signer_address: accountData.address,
            });
            authSentRef.current = true;
          }
        } catch (err) {
          console.error("[useGame] Wallet signing failed, sending unsigned auth:", err);
          if (!cancelled) {
            sendMessage({ type: "auth", address });
            authSentRef.current = true;
          }
        }
      })();
      return () => { cancelled = true; };
    }

    // signArb not available — send unsigned auth as fallback
    // (server with SKIP_AUTH_VERIFICATION=true will accept it)
    sendMessage({ type: "auth", address });
    authSentRef.current = true;
  }, [connected, address, authNonce, signArb, abstraxionClient, sendMessage]);

  // Reset auth and queue state on disconnect
  useEffect(() => {
    if (!connected) {
      setAuthenticated(false);
      if (state.status === "queued") {
        dispatch({ type: "QUEUE_LEFT" });
      }
    }
  }, [connected, state.status]);

  // Register message handlers
  useEffect(() => {
    const unsubs = [
      on("game_created", (msg) =>
        dispatch({
          type: "GAME_CREATED",
          gameId: msg.game_id as string,
          color: msg.color as Player,
        })
      ),
      on("game_joined", (msg) =>
        dispatch({
          type: "GAME_JOINED",
          gameId: msg.game_id as string,
          color: msg.color as Player,
          opponent: msg.opponent as string,
          opponentName: msg.opponent_name as string | undefined,
        })
      ),
      on("game_start", (msg) => {
        const gameId = msg.game_id as string;
        const gs = msg.game_state as GameState;
        const legalMoves = (msg.legal_moves || []) as Move[];

        // Register this WebSocket as the game WebSocket for this player
        sendMessage({ type: "rejoin_game", game_id: gameId });

        const needsConfirmation = msg.needs_confirmation as boolean | undefined;

        // If already playing the same game, this is a reconnection — sync state
        // without resetting timer/undo/etc.
        if (stateRef.current.status === "playing" && stateRef.current.gameId === gameId) {
          dispatch({ type: "GAME_SYNC", gameState: gs, legalMoves, needsConfirmation });
          return;
        }

        dispatch({
          type: "GAME_START",
          gameId,
          white: msg.white as string,
          black: msg.black as string,
          whiteName: msg.white_name as string | undefined,
          blackName: msg.black_name as string | undefined,
          gameState: gs,
          legalMoves,
          myAddress: addressRef.current || "",
          matchState: msg.match_state as MatchState | undefined,
          turnTimeLimit: msg.turn_time_limit as number | undefined,
          needsConfirmation,
        });
      }),
      on("dice_rolled", (msg) => {
        // New turn started — clear flushing flag in case it got stuck
        flushingRef.current = false;
        playDiceRoll();
        dispatch({
          type: "DICE_ROLLED",
          gameState: msg.game_state as GameState,
          legalMoves: (msg.legal_moves || []) as Move[],
          player: msg.player as Player,
          needsConfirmation: msg.needs_confirmation as boolean | undefined,
        });
      }),
      on("move_made", (msg) => {
        const player = msg.player as Player;
        const move = msg.move as Move;
        const gs = msg.game_state as GameState;
        // During flush, suppress our own move_made echoes (server state updates silently)
        if (flushingRef.current && player === myColorRef.current) {
          // Still update server state silently for consistency
          dispatch({
            type: "MOVE_MADE",
            gameState: gs,
            legalMoves: (msg.legal_moves || []) as Move[],
            player,
            move,
            needsConfirmation: msg.needs_confirmation as boolean | undefined,
          });
          return;
        }
        const isHit = player !== myColorRef.current;
        if (isHit) {
          playCheckerHit();
        } else {
          playCheckerPlace();
        }
        dispatch({
          type: "MOVE_MADE",
          gameState: gs,
          legalMoves: (msg.legal_moves || []) as Move[],
          player,
          move,
          needsConfirmation: msg.needs_confirmation as boolean | undefined,
        });
      }),
      on("move_undone", (msg) => {
        dispatch({
          type: "MOVE_UNDONE",
          gameState: msg.game_state as GameState,
          legalMoves: (msg.legal_moves || []) as Move[],
        });
      }),
      on("turn_ended", (msg) => {
        flushingRef.current = false;
        playTurnEnd();
        dispatch({
          type: "TURN_ENDED",
          gameState: msg.game_state as GameState,
        });
      }),
      on("game_over", (msg) => {
        flushingRef.current = false;
        const winner = msg.winner as Player;
        playGameOver(winner === myColorRef.current);
        dispatch({
          type: "GAME_OVER",
          winner,
          resultType: msg.result_type as string,
          gameState: msg.game_state as GameState,
          matchState: msg.match_state as MatchState | undefined,
          matchOver: msg.match_over as boolean | undefined,
        });
      }),
      on("next_game", (msg) => {
        dispatch({
          type: "NEXT_GAME",
          gameId: msg.game_id as string,
          gameState: msg.game_state as GameState,
          matchState: msg.match_state as MatchState,
          myAddress: addressRef.current || "",
          white: msg.white as string,
          black: msg.black as string,
        });
      }),
      on("double_offered", (msg) =>
        dispatch({
          type: "DOUBLE_OFFERED",
          player: msg.player as Player,
          cubeValue: msg.cube_value as number,
        })
      ),
      on("double_accepted", (msg) =>
        dispatch({
          type: "DOUBLE_ACCEPTED",
          cubeValue: msg.cube_value as number,
          cubeOwner: msg.cube_owner as Player,
        })
      ),
      on("double_rejected", (msg) =>
        dispatch({
          type: "DOUBLE_REJECTED",
          winner: msg.winner as Player,
        })
      ),
      on("double_awaiting_deposits", (msg) =>
        dispatch({
          type: "DOUBLE_AWAITING_DEPOSITS",
          newCubeValue: msg.new_cube_value as number,
          additionalDeposit: msg.additional_deposit as string,
          doubler: msg.doubler as string,
          responder: msg.responder as string,
        })
      ),
      on("double_deposit_received", (msg) =>
        dispatch({
          type: "DOUBLE_DEPOSIT_RECEIVED",
          player: msg.player as string,
          depositsComplete: msg.deposits_complete as boolean,
        })
      ),
      on("double_deposits_complete", (msg) =>
        dispatch({
          type: "DOUBLE_DEPOSITS_COMPLETE",
          newCubeValue: msg.new_cube_value as number,
          cubeOwner: msg.cube_owner as Player,
        })
      ),
      on("double_deposit_timeout", () =>
        dispatch({ type: "DOUBLE_DEPOSIT_TIMEOUT" })
      ),
      on("opponent_disconnected", () =>
        dispatch({ type: "OPPONENT_DISCONNECTED" })
      ),
      on("opponent_reconnected", () =>
        dispatch({ type: "OPPONENT_RECONNECTED" })
      ),
      on("opponent_disconnecting", (msg) =>
        dispatch({ type: "OPPONENT_DISCONNECTING", countdown: msg.grace_seconds as number })
      ),
      on("disconnect_countdown", (msg) =>
        dispatch({ type: "DISCONNECT_COUNTDOWN", countdown: msg.seconds_remaining as number })
      ),
      on("queue_joined", () => dispatch({ type: "QUEUED" })),
      on("queue_left", () => dispatch({ type: "QUEUE_LEFT" })),
      on("error", (msg) =>
        dispatch({ type: "ERROR", message: msg.message as string })
      ),
      on("reaction", (msg) =>
        dispatch({
          type: "REACTION_RECEIVED",
          emoji: msg.emoji as string,
          from: msg.from as string,
        })
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [on, sendMessage]);

  // Clear last opponent move after 3 seconds
  useEffect(() => {
    if (state.lastOpponentMove) {
      const timer = setTimeout(() => dispatch({ type: "CLEAR_LAST_MOVE" }), CLEAR_LAST_MOVE_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [state.lastOpponentMove]);

  // Clear incoming reaction after 3 seconds
  useEffect(() => {
    if (state.lastReaction) {
      const timer = setTimeout(() => dispatch({ type: "CLEAR_REACTION" }), CLEAR_REACTION_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [state.lastReaction]);

  // No forced move auto-play — player always confirms manually

  const createGame = useCallback(
    (wagerAmount: number, matchLength?: number, timeControl?: number) => {
      sendMessage({
        type: "create_game",
        wager_amount: wagerAmount,
        match_length: matchLength,
        time_control: timeControl,
      });
    },
    [sendMessage]
  );

  const joinGame = useCallback(
    (gameId: string) => {
      sendMessage({ type: "join_game", game_id: gameId });
    },
    [sendMessage]
  );

  const joinQueue = useCallback(
    (wagerAmount: number, matchLength: number = 1) => {
      sendMessage({ type: "join_queue", wager_amount: wagerAmount, match_length: matchLength });
    },
    [sendMessage]
  );

  const leaveQueue = useCallback(() => {
    sendMessage({ type: "leave_queue" });
  }, [sendMessage]);

  const rollDice = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "roll_dice", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const makeMove = useCallback(
    (from: number, to: number) => {
      if (!state.gameId) return;
      // Buffer locally: validate with core lib, don't send to server
      const currentState = stateRef.current.localGameState || stateRef.current.gameState;
      if (!currentState) return;
      const newState = coreMakeMove(currentState, from, to);
      if (!newState) return; // invalid move
      // Determine which die was used by comparing movesRemaining
      const oldMoves = [...currentState.movesRemaining];
      const newMoves = [...newState.movesRemaining];
      let die = oldMoves[0] || 0;
      for (const d of oldMoves) {
        const idx = newMoves.indexOf(d);
        if (idx === -1) { die = d; break; }
        newMoves.splice(idx, 1);
      }
      const legalMoves = newState.movesRemaining.length > 0
        ? getLegalFirstMoves(newState.board, newState.currentPlayer, newState.movesRemaining)
        : [];
      dispatch({ type: "LOCAL_MOVE", from, to, die, newState, legalMoves });
    },
    [state.gameId]
  );

  const endTurn = useCallback(() => {
    if (!state.gameId) return;
    const moves = stateRef.current.bufferedMoves;
    if (moves.length > 0) {
      // Flush all buffered moves to the server, then end turn
      flushingRef.current = true;
      for (const m of moves) {
        sendMessage({ type: "move", game_id: state.gameId!, from: m.from, to: m.to });
      }
      sendMessage({ type: "end_turn", game_id: state.gameId! });
      dispatch({ type: "CLEAR_BUFFER" });
      // flushingRef will be cleared when turn_ended arrives
    } else {
      sendMessage({ type: "end_turn", game_id: state.gameId });
    }
  }, [sendMessage, state.gameId]);

  const undoMove = useCallback(() => {
    if (!state.gameId) return;
    if (stateRef.current.bufferedMoves.length > 0) {
      // Undo locally — no server call needed
      dispatch({ type: "LOCAL_UNDO" });
    } else {
      sendMessage({ type: "undo_move", game_id: state.gameId });
    }
  }, [sendMessage, state.gameId]);

  const resign = useCallback(() => {
    if (state.gameId) sendMessage({ type: "resign", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const offerDouble = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "offer_double", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const acceptDouble = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "accept_double", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  const rejectDouble = useCallback(() => {
    if (state.gameId)
      sendMessage({ type: "reject_double", game_id: state.gameId });
  }, [sendMessage, state.gameId]);

  /** Submit on-chain double deposit, then notify server */
  const submitDoubleDeposit = useCallback(async () => {
    if (!state.gameId || !abstraxionClient || !state.doubleDepositRequired) return;
    const escrowContract = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS;
    const denom = process.env.NEXT_PUBLIC_GAMMON_DENOM || USDC_DENOM;
    if (!escrowContract) {
      console.error("[useGame] NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS not set");
      return;
    }
    try {
      const amount = state.doubleDepositAmount;
      await abstraxionClient.execute(
        addressRef.current!,
        escrowContract,
        { double_deposit: { game_id: state.gameId } },
        "auto",
        undefined,
        [{ denom, amount }],
      );
      // Notify server that deposit was made
      sendMessage({ type: "double_deposit_confirmed", game_id: state.gameId });
    } catch (err) {
      console.error("[useGame] Double deposit failed:", err);
      dispatch({ type: "ERROR", message: "Double deposit transaction failed" });
    }
  }, [state.gameId, state.doubleDepositRequired, state.doubleDepositAmount, abstraxionClient, sendMessage]);

  const sendReaction = useCallback(
    (emoji: string) => {
      if (state.gameId) {
        sendMessage({ type: "reaction", game_id: state.gameId, emoji });
      }
    },
    [sendMessage, state.gameId],
  );

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  // Compute canDouble from game state
  const myCanDouble = state.gameState && state.myColor
    ? checkCanDouble(state.gameState, state.myColor)
    : false;

  // Expose local state when buffer is active
  const hasBuffer = state.bufferedMoves.length > 0;
  const effectiveGameState = hasBuffer ? state.localGameState : state.gameState;
  const effectiveLegalMoves = hasBuffer ? state.localLegalMoves : state.legalMoves;
  const bufferPendingConfirmation = hasBuffer && state.localLegalMoves.length === 0;

  return {
    ...state,
    gameState: effectiveGameState,
    legalMoves: effectiveLegalMoves,
    turnHistory: state.turnHistory,
    matchTurnHistory: state.matchTurnHistory,
    canUndo: hasBuffer || state.undoCount > 0 || state.pendingConfirmation,
    pendingConfirmation: bufferPendingConfirmation || state.pendingConfirmation,
    canDouble: myCanDouble,
    connected,
    authenticated,
    createGame,
    joinGame,
    joinQueue,
    leaveQueue,
    rollDice,
    makeMove,
    endTurn,
    undoMove,
    resign,
    offerDouble,
    acceptDouble,
    rejectDouble,
    submitDoubleDeposit,
    sendReaction,
    reset,
  };
}
