import type { ResultType } from "@xion-beginner/backgammon-core";
import type { BalanceService } from "./balance-service.js";
import { getEscrowClient } from "./escrow.js";
import { logger } from "./logger.js";

/**
 * BalanceService implementation backed by the on-chain wager-escrow contract.
 * Delegates all fund operations to EscrowClient.
 */
export class EscrowBalanceService implements BalanceService {
  async checkBalance(address: string, amount: number): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    const balance = await escrow.queryBalance(address);
    return BigInt(balance) >= BigInt(amount);
  }

  async lockFunds(gameId: string, playerA: string, playerB: string, wagerAmount: number): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    return escrow.createEscrow(gameId, playerA, playerB, String(wagerAmount));
  }

  async settleFunds(gameId: string, winner: string, _resultType: ResultType): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    return escrow.settle(gameId, winner);
  }

  async cancelFunds(gameId: string): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    return escrow.cancel(gameId);
  }

  async offerDouble(gameId: string, doubler: string, newCubeValue: number): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    return escrow.offerDouble(gameId, doubler, newCubeValue);
  }

  async verifyDoubleDeposit(gameId: string): Promise<{
    doublerDeposited: boolean;
    responderDeposited: boolean;
    bothDeposited: boolean;
  } | null> {
    const escrow = getEscrowClient();
    if (!escrow) return null;

    const info = await escrow.queryEscrowStatus(gameId);
    if (!info || !info.pendingDouble) return null;

    return {
      doublerDeposited: info.pendingDouble.doublerDeposited,
      responderDeposited: info.pendingDouble.responderDeposited,
      bothDeposited: info.pendingDouble.doublerDeposited && info.pendingDouble.responderDeposited,
    };
  }

  async rejectDouble(gameId: string, rejecter: string): Promise<boolean> {
    const escrow = getEscrowClient();
    if (!escrow) return false;
    return escrow.rejectDouble(gameId, rejecter);
  }

  async getBalance(address: string): Promise<string> {
    const escrow = getEscrowClient();
    if (!escrow) return "0";
    return escrow.queryBalance(address);
  }
}
