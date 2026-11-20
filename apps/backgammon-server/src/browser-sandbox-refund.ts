import { z } from "zod";
import {
  getCashQuote,
  resolveCashQuoteRefund,
  type CashQuote,
} from "./cash-game-store.js";
import type { FinanceWorker } from "./finance-worker.js";

const RefundRecoveryInput = z.object({
  quoteId: z.string().uuid(),
  participant: z.string().min(1),
}).strict();

const MAX_WORKER_RUNS = 8;

export interface BrowserSandboxRefundRecoveryResult {
  readonly quote: CashQuote;
  readonly workerRuns: number;
}

/** This recovery path exists exclusively for the local browser finance sandbox. */
export function browserSandboxRefundRecoveryEnabled(): boolean {
  return process.env.GAMMON_BROWSER_FINANCE_SANDBOX === "1" && process.env.NODE_ENV !== "production";
}

/**
 * Queues an ordinary operator refund and gives the ordinary finance worker a
 * bounded opportunity to deliver it. Callers must provide the authenticated
 * participant so a sandbox browser cannot recover another player's quote.
 */
export async function recoverBrowserSandboxCashQuoteRefund(input: {
  readonly quoteId: string;
  readonly participant: string;
  readonly worker: FinanceWorker | null;
}): Promise<BrowserSandboxRefundRecoveryResult> {
  if (!browserSandboxRefundRecoveryEnabled()) {
    throw new Error("BROWSER_SANDBOX_REFUND_RECOVERY_DISABLED");
  }
  if (!input.worker) {
    throw new Error("BROWSER_SANDBOX_FINANCE_WORKER_UNAVAILABLE");
  }

  const { quoteId, participant } = RefundRecoveryInput.parse({ quoteId: input.quoteId, participant: input.participant });
  const quote = await getCashQuote(participant, quoteId);
  if (!quote) throw new Error("QUOTE_NOT_FOUND");
  if (!['reserving', 'active', 'review'].includes(quote.state)) {
    throw new Error("QUOTE_STATE_CONFLICT");
  }

  let current = await resolveCashQuoteRefund({ operatorId: participant, quoteId });
  let workerRuns = 0;
  while (current.state !== "refunded" && workerRuns < MAX_WORKER_RUNS) {
    const processed = await input.worker.runOnce();
    if (!processed) break;
    workerRuns++;
    const refreshed = await getCashQuote(participant, quoteId);
    if (!refreshed) throw new Error("QUOTE_NOT_FOUND");
    current = refreshed;
  }

  return { quote: current, workerRuns };
}
