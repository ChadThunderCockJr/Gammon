import type { ResultType } from "@xion-beginner/backgammon-core";

/**
 * BalanceService abstracts fund management for wagered games.
 *
 * Current implementation: EscrowBalanceService (on-chain CosmWasm escrow)
 * Future implementation: CustodialBalanceService (server-side PostgreSQL ledger)
 *
 * The game-manager calls this interface without knowing whether funds
 * are on-chain or custodial. Swapping implementations requires zero
 * changes to game-manager.ts.
 */
export interface BalanceService {
  /** Check if a player has sufficient funds for a wager */
  checkBalance(address: string, amount: number): Promise<boolean>;

  /** Lock funds for a new game (create escrow or debit custodial balance) */
  lockFunds(gameId: string, playerA: string, playerB: string, wagerAmount: number): Promise<boolean>;

  /** Settle a completed game — pay winner, deduct rake */
  settleFunds(gameId: string, winner: string, resultType: ResultType): Promise<boolean>;

  /** Cancel a game — refund both players */
  cancelFunds(gameId: string): Promise<boolean>;

  /** Initiate a double — lock additional funds from both players */
  offerDouble(gameId: string, doubler: string, newCubeValue: number): Promise<boolean>;

  /** Verify a player's double deposit has been received */
  verifyDoubleDeposit(gameId: string): Promise<{
    doublerDeposited: boolean;
    responderDeposited: boolean;
    bothDeposited: boolean;
  } | null>;

  /** Reject a double — forfeit game, pay pot to doubler */
  rejectDouble(gameId: string, rejecter: string): Promise<boolean>;

  /** Query a player's available balance */
  getBalance(address: string): Promise<string>;
}
