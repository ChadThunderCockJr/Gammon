import { createHash, randomUUID } from "node:crypto";
import { formatMicroUsd } from "@xion-beginner/backgammon-core";
import { BraleApiError, createConfiguredBraleClient, type BraleTransfer, type BraleTransferEndpoint } from "./brale.js";
import { CashEffectPendingError, processCashGameEffect } from "./cash-game-worker.js";
import { quarantineCashEscrowEffect } from "./cash-game-store.js";
import { decryptSensitiveJson, encryptSensitiveJson, type EncryptedPayload } from "./finance-crypto.js";
import {
  authorizeEffectDispatch,
  claimNextEffect,
  completeTransferEffectWithJournal,
  completeEffect,
  confirmReconciliationObservation,
  confirmCashOutRefundChainFinality,
  enqueueDueTransferReconciliations,
  claimProviderTransferReconciliations,
  dispatchProviderTransferReconciliation,
  failEffect,
  getPaymentProfile,
  listProviderResourcesForReconciliation,
  operationForProviderTransfer,
  queueProviderResourceReconciliation,
  claimProviderResourceReconciliations,
  completeProviderResourceReconciliation,
  failProviderResourceReconciliation,
  reconcileProviderResourceState,
  upsertPaymentProfile,
  reviewCashOutRefund,
  reviewLateOriginalCashOutCompletion,
  reviewLateOriginalDepositCompletion,
  reverseCompletedTransfer,
  type ClaimedEffect,
  retryEffect,
  type MoneyOperationState,
} from "./finance-store.js";
import { evaluateFundsAction } from "./action-policy.js";
import { fundsGate } from "./funds-config.js";
import { logger } from "./logger.js";
import { SettlementAuthorizerError } from "./settlement-authorizer.js";

interface EnrollmentEffect {
  readonly providerAccountId: string;
  readonly walletAddress: string;
  readonly transferType: "verona" | "verona_testnet";
}


interface TransferEffect {
  readonly paymentMethodId: string;
  readonly providerAccountId: string;
  readonly providerAddressId: string;
  readonly externalWalletAddressId: string;
  readonly destinationWalletAddress?: string;
  assetDenom: string;
  chainRestUrl: string;
  chainId: string;
  genesisHash: string;
  finalityBlocks: number;
  fundsMode: "verusd_testnet" | "verusd_production";
  transferType: "verona_testnet" | "verona";
  readonly internalAddressId?: string;
  readonly internalWalletAddress?: string;
  readonly originatingWalletAddress?: string;
}

class ProviderPendingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderPendingError";
  }
}

function encryptedPayload<T>(effect: ClaimedEffect): T {
  return decryptSensitiveJson<T>(effect.requestPayload as EncryptedPayload, effect.operationId);
}
function cashEscrowQuoteId(effect: ClaimedEffect): string | null {
  if (!["escrow_create", "escrow_settle", "escrow_refund"].includes(effect.effectType)) return null;
  if (!effect.requestPayload || typeof effect.requestPayload !== "object" || Array.isArray(effect.requestPayload)) return null;
  const quoteId = (effect.requestPayload as Record<string, unknown>).quoteId;
  return typeof quoteId === "string" ? quoteId : null;
}


function transferState(status: string): MoneyOperationState {
  const states: Record<string, MoneyOperationState> = {
    pending: "pending",
    processing: "processing",
    complete: "complete",
    canceled: "canceled",
    failed: "failed",
    refunding: "refunding",
    refunded: "refunded",
  };
  return states[status] ?? "review";
}

async function processEnrollment(effect: ClaimedEffect): Promise<void> {
  const provider = createConfiguredBraleClient();
  if (!provider) throw new Error("FINANCE_NOT_CONFIGURED");
  const payload = encryptedPayload<EnrollmentEffect>(effect);
  if (!payload.providerAccountId || !payload.walletAddress || !payload.transferType) throw new Error("MALFORMED_ENROLLMENT_SNAPSHOT");
  const existingProfile = await getPaymentProfile(effect.principal);
  if (existingProfile && (existingProfile.providerAccountId !== payload.providerAccountId || existingProfile.walletAddress !== payload.walletAddress)) {
    throw new Error("ENROLLMENT_OWNERSHIP_MISMATCH");
  }
  if (
    existingProfile?.status === "active" &&
    existingProfile.externalWalletAddressId &&
    existingProfile.internalAddressId &&
    existingProfile.internalWalletAddress
  ) {
    await completeEffect({
      effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
      operationState: "complete", scrubRequestPayload: true,
    });
    return;
  }
  const account = await provider.getAccount(payload.providerAccountId);
  const expectedProgram = process.env.BRALE_PROGRAM_ID?.trim();
  const requiredCapability = process.env.BRALE_REQUIRED_ACCOUNT_CAPABILITY?.trim();
  if (
    !expectedProgram ||
    !requiredCapability ||
    account.programId !== expectedProgram ||
    !account.capabilities.includes(requiredCapability)
  ) throw new Error("MANAGED_ACCOUNT_ATTESTATION_MISMATCH");
  await reconcileProviderResourceState({
    resourceType: "account",
    resourceId: account.id,
    status: account.status,
  });
  await upsertPaymentProfile({
    principal: effect.principal,
    providerAccountId: account.id,
    walletAddress: payload.walletAddress,
    status: account.status === "rejected" || account.status === "archived" ? "restricted" : "pending",
  });
  if (account.status === "rejected" || account.status === "archived") {
    await completeEffect({
      effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
      operationState: "failed", encryptedResponse: encryptSensitiveJson({ providerAccountId: account.id, status: account.status }, effect.operationId),
      scrubRequestPayload: true,
    });
    return;
  }
  if (account.status !== "complete") {
    await retryEffect(effect.id, effect.operationId, effect.leaseToken, account.status === "documents_required" ? "KYC_DOCUMENTS_REQUIRED" : "KYC_PENDING", false, effect.attemptCount);
    return;
  }
  const enrollmentKey = `gammon:enroll:${createHash("sha256").update(`${effect.principal}:${account.id}`).digest("hex")}`;
  await authorizeEffectDispatch({
    effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
    principal: effect.principal, step: "external_wallet", action: "provider_account_create",
  });
  const externalWallet = await provider.registerExternalWallet({
    accountId: account.id, walletAddress: payload.walletAddress, transferType: payload.transferType,
    idempotencyKey: `${enrollmentKey}:wallet`,
  });
  await authorizeEffectDispatch({
    effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
    principal: effect.principal, step: "internal_address", action: "provider_account_create",
  });
  const internalWallet = await provider.createInternalAddress({
    name: `Gammon cash-out ${effect.principal.slice(0, 12)}`, transferType: payload.transferType,
    idempotencyKey: `${enrollmentKey}:internal`,
  });
  await upsertPaymentProfile({
    principal: effect.principal, providerAccountId: account.id, walletAddress: payload.walletAddress, status: "pending",
    externalWalletAddressId: externalWallet.addressId, internalAddressId: internalWallet.addressId,
    internalWalletAddress: internalWallet.address,
  });
  await Promise.all([
    queueProviderResourceReconciliation({
      resourceType: "address",
      resourceId: externalWallet.addressId,
      parentAccountId: account.id,
    }),
    queueProviderResourceReconciliation({
      resourceType: "address",
      resourceId: internalWallet.addressId,
      parentAccountId: provider.masterAccountId,
    }),
  ]);
  await completeEffect({
    effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
    operationState: "complete", scrubRequestPayload: true,
  });
}


function amountMicroUsd(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new TypeError("Unexpected payment provider amount response");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function assertTransferTuple(
  transfer: BraleTransfer,
  expected: {
    accountId: string;
    amountMicroUsd: string;
    source: { addressId: string; valueType: "USD" | "verUSD"; transferType: string };
    destination: { addressId: string; valueType: "USD" | "verUSD"; transferType: string };
  },
  providerTransferId: string | null,
): void {
  if (
    (providerTransferId !== null && transfer.id !== providerTransferId) ||
    transfer.accountId !== expected.accountId ||
    amountMicroUsd(transfer.amount.value) !== BigInt(expected.amountMicroUsd) ||
    transfer.source.addressId !== expected.source.addressId ||
    transfer.source.valueType !== expected.source.valueType ||
    transfer.source.transferType !== expected.source.transferType ||
    transfer.destination.addressId !== expected.destination.addressId ||
    transfer.destination.valueType !== expected.destination.valueType ||
    transfer.destination.transferType !== expected.destination.transferType
  ) {
    throw new Error("TRANSFER_TUPLE_MISMATCH");
  }
}

async function verifyChainTransfer(input: {
  source?: string;
  destination: string;
  amountMicroUsd: string;
  assetDenom: string;
  chainRestUrl: string;
  chainId: string;
  genesisHash: string;
  finalityBlocks: number;
  txHash: string;
}): Promise<number> {
  const rest = input.chainRestUrl.replace(/\/$/, "");
  const [nodeResponse, genesisResponse, response] = await Promise.all([
    fetch(`${rest}/cosmos/base/tendermint/v1beta1/node_info`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/1`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${rest}/cosmos/tx/v1beta1/txs/${input.txHash}`, { signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!nodeResponse.ok || !genesisResponse.ok) throw new Error("CHAIN_IDENTITY_UNAVAILABLE");
  const node = await nodeResponse.json() as { default_node_info?: { network?: string } };
  const genesis = await genesisResponse.json() as { block_id?: { hash?: string }; block?: { header?: { app_hash?: string } } };
  const observedGenesis = (genesis.block_id?.hash ?? genesis.block?.header?.app_hash)?.toLowerCase();
  if (node.default_node_info?.network !== input.chainId || observedGenesis !== input.genesisHash) {
    throw new Error("CHAIN_IDENTITY_MISMATCH");
  }
  if (!response.ok) throw new Error("CHAIN_TRANSACTION_NOT_FOUND");
  const transaction = await response.json() as {
    tx?: { body?: { messages?: Array<Record<string, unknown>> } };
    tx_response?: { code?: number; height?: string; txhash?: string };
  };
  const matches = (transaction.tx?.body?.messages ?? []).filter((message) => {
    if (message["@type"] !== "/cosmos.bank.v1beta1.MsgSend") return false;
    if ((input.source && message.from_address !== input.source) || message.to_address !== input.destination) return false;
    const amounts = Array.isArray(message.amount) ? message.amount : [];
    return amounts.length === 1 && amounts[0] !== null && typeof amounts[0] === "object"
      && "denom" in amounts[0] && amounts[0].denom === input.assetDenom
      && "amount" in amounts[0] && amounts[0].amount === input.amountMicroUsd;
  });
  if (matches.length !== 1) throw new Error("CHAIN_TRANSACTION_MISMATCH");
  const latestResponse = await fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/latest`, { signal: AbortSignal.timeout(10_000) });
  if (!latestResponse.ok) throw new Error("CHAIN_FINALITY_UNAVAILABLE");
  const latest = await latestResponse.json() as { block?: { header?: { height?: string } } };
  if (
    transaction.tx_response?.code !== 0 ||
    transaction.tx_response.txhash?.toLowerCase() !== input.txHash.toLowerCase()
  ) throw new Error("CHAIN_TRANSACTION_FAILED");
  const transactionHeight = Number(transaction.tx_response.height);
  const latestHeight = Number(latest.block?.header?.height);
  if (!Number.isSafeInteger(transactionHeight) || !Number.isSafeInteger(latestHeight) || latestHeight - transactionHeight < input.finalityBlocks) {
    throw new Error("CHAIN_TRANSACTION_NOT_FINAL");
  }
  return transactionHeight;
}

async function processTransfer(effect: ClaimedEffect, direction: "deposit" | "cash_out"): Promise<void> {
  const provider = createConfiguredBraleClient();
  const amountMicroUsd = effect.amountMicroUsd;
  if (!provider || !amountMicroUsd) throw new Error("FINANCE_NOT_CONFIGURED");
  const payload = encryptedPayload<TransferEffect>(effect);
  if (
    !payload.paymentMethodId || !payload.providerAccountId || !payload.providerAddressId ||
    !payload.externalWalletAddressId || !payload.assetDenom || !payload.chainRestUrl ||
    !payload.chainId || !/^[0-9a-f]{64}$/.test(payload.genesisHash) ||
    !Number.isSafeInteger(payload.finalityBlocks) || payload.finalityBlocks <= 0 ||
    (payload.transferType !== "verona" && payload.transferType !== "verona_testnet")
  ) throw new Error("MALFORMED_TRANSFER_SNAPSHOT");
  const isDeposit = direction === "deposit";
  let chainDestination: string | null = null;
  let expected: {
    accountId: string;
    amountMicroUsd: string;
    source: BraleTransferEndpoint;
    destination: BraleTransferEndpoint;
  };
  if (isDeposit) {
    const destinationWalletAddress = payload.destinationWalletAddress;
    if (!destinationWalletAddress) throw new Error("MALFORMED_DEPOSIT_SNAPSHOT");
    chainDestination = destinationWalletAddress;
    expected = {
      accountId: payload.providerAccountId,
      amountMicroUsd,
      source: { addressId: payload.providerAddressId, valueType: "USD", transferType: "ach_debit" },
      destination: { addressId: payload.externalWalletAddressId, valueType: "verUSD", transferType: payload.transferType },
    };
  } else {
    const internalAddressId = payload.internalAddressId;
    if (!internalAddressId) throw new Error("MALFORMED_CASH_OUT_SNAPSHOT");
    expected = {
      accountId: payload.providerAccountId,
      amountMicroUsd,
      source: { addressId: internalAddressId, valueType: "verUSD", transferType: payload.transferType },
      destination: { addressId: payload.providerAddressId, valueType: "USD", transferType: "ach_credit" },
    };
  }
  const transferInput = {
    amountUsd: formatMicroUsd(BigInt(amountMicroUsd), { symbol: false }),
    source: expected.source,
    destination: expected.destination,
    idempotencyKey: effect.providerIdempotencyKey,
    brandAccountId: expected.accountId,
  };
  await authorizeEffectDispatch({
    effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
    principal: effect.principal, step: "transfer", action: direction, amountMicroUsd,
  });
  const transfer = await provider.createTransfer(transferInput);
  assertTransferTuple(transfer, expected, effect.providerTransferId);
  const state = transferState(transfer.status);
  if (state === "complete") {
    if (isDeposit) {
      if (!transfer.chainTxHash) throw new ProviderPendingError("CHAIN_TRANSACTION_EVIDENCE_MISSING");
      if (!chainDestination) throw new Error("MALFORMED_DEPOSIT_SNAPSHOT");
      try {
        await verifyChainTransfer({ destination: chainDestination, amountMicroUsd, assetDenom: payload.assetDenom, chainRestUrl: payload.chainRestUrl, chainId: payload.chainId, genesisHash: payload.genesisHash, finalityBlocks: payload.finalityBlocks, txHash: transfer.chainTxHash });
      } catch (error) {
        if (error instanceof Error && ["CHAIN_IDENTITY_UNAVAILABLE", "CHAIN_TRANSACTION_NOT_FOUND", "CHAIN_FINALITY_UNAVAILABLE", "CHAIN_TRANSACTION_NOT_FINAL"].includes(error.message)) throw new ProviderPendingError(error.message);
        throw error;
      }
    }
    await completeTransferEffectWithJournal({ effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken, providerReference: transfer.id, assetDenom: payload.assetDenom, principal: effect.principal, debitAccount: "provider_clearing", creditAccount: isDeposit ? "player_chain_observed" : "provider_cash_out_obligation", amountMicroUsd, providerEventId: `effect:${effect.id}` });
    return;
  }
  if (state === "canceled" || state === "failed") {
    await failEffect(effect.id, effect.operationId, effect.leaseToken, `provider_${transfer.status}`, false, transfer.id);
    return;
  }
  await retryEffect(effect.id, effect.operationId, effect.leaseToken, `provider_${transfer.status}`, state === "review", effect.attemptCount, transfer.id);
}

async function processReconciliation(effect: ClaimedEffect): Promise<void> {
  const provider = createConfiguredBraleClient();
  if (!provider) throw new Error("FINANCE_NOT_CONFIGURED");
  const request = effect.requestPayload as { providerTransferId?: unknown };
  if (typeof request.providerTransferId !== "string") throw new Error("MALFORMED_RECONCILIATION_EFFECT");
  const transfer = await provider.getTransfer(request.providerTransferId);
  const operation = await operationForProviderTransfer(transfer.id);
  if (!operation || !operation.amountMicroUsd || (operation.kind !== "deposit" && operation.kind !== "cash_out")) {
    throw new Error("TRANSFER_RECONCILIATION_UNBOUND");
  }
  const s = operation.quoteSnapshot;
  const get = (key: string): string => typeof s[key] === "string" ? s[key] as string : "";
  const rail = get("transferType");
  const finalityBlocks = Number(s.finalityBlocks);
  const isRefundTransfer = operation.providerTransferId !== transfer.id;
  if (isRefundTransfer) {
    if (operation.kind !== "cash_out" || !get("internalAddressId") || !get("externalWalletAddressId") || !get("internalWalletAddress") || !get("originatingWalletAddress")) {
      throw new Error("TRANSFER_RECONCILIATION_UNBOUND");
    }
    assertTransferTuple(transfer, {
      accountId: get("providerAccountId"), amountMicroUsd: operation.amountMicroUsd,
      source: { addressId: get("internalAddressId"), valueType: "verUSD", transferType: rail },
      destination: { addressId: get("externalWalletAddressId"), valueType: "verUSD", transferType: rail },
    }, transfer.id);
    const refundState = transferState(transfer.status);
    if (operation.state === "refunded" && refundState === "complete") {
      await confirmReconciliationObservation({ effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken });
      return;
    }
    if (refundState === "complete") {
      if (!transfer.chainTxHash) throw new ProviderPendingError("CHAIN_TRANSACTION_EVIDENCE_MISSING");
      const height = await verifyChainTransfer({
        source: get("internalWalletAddress"), destination: get("originatingWalletAddress"),
        amountMicroUsd: operation.amountMicroUsd, assetDenom: get("assetDenom"),
        chainRestUrl: get("chainRestUrl"), chainId: get("chainId"), genesisHash: get("genesisHash"),
        finalityBlocks, txHash: transfer.chainTxHash,
      });
      await confirmCashOutRefundChainFinality({
        operationId: operation.id, effectId: effect.id, leaseToken: effect.leaseToken,
        returnedChainTxHash: transfer.chainTxHash, confirmedHeight: String(height),
      });
      return;
    }
    if (refundState === "failed" || refundState === "canceled" || refundState === "refunded") {
      await reviewCashOutRefund({
        effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken,
        providerReference: transfer.id, failureCode: `provider_refund_${transfer.status}`,
      });
      return;
    }
    await retryEffect(effect.id, effect.operationId, effect.leaseToken, `provider_refund_${transfer.status}`, refundState === "review", effect.attemptCount, transfer.id);
    return;
  }
  const isDeposit = operation.kind === "deposit";
  const expected = isDeposit
    ? { accountId: get("providerAccountId"), amountMicroUsd: operation.amountMicroUsd, source: { addressId: get("providerAddressId"), valueType: "USD" as const, transferType: "ach_debit" as const }, destination: { addressId: get("externalWalletAddressId"), valueType: "verUSD" as const, transferType: rail } }
    : { accountId: get("providerAccountId"), amountMicroUsd: operation.amountMicroUsd, source: { addressId: get("internalAddressId"), valueType: "verUSD" as const, transferType: rail }, destination: { addressId: get("providerAddressId"), valueType: "USD" as const, transferType: "ach_credit" as const } };
  if (!expected.accountId || !expected.source.addressId || !expected.destination.addressId || !get("assetDenom") || !get("chainRestUrl") || !get("chainId") || !/^[0-9a-f]{64}$/.test(get("genesisHash")) || !["verona", "verona_testnet"].includes(rail) || !Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0) throw new Error("MALFORMED_TRANSFER_SNAPSHOT");
  assertTransferTuple(transfer, expected, operation.providerTransferId);
  const state = transferState(transfer.status);
  if (operation.state === state) {
    await confirmReconciliationObservation({ effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken });
    return;
  }
  if (operation.kind === "deposit" && operation.state === "refunded" && state === "complete") {
    await reviewLateOriginalDepositCompletion({
      effectId: effect.id,
      operationId: operation.id,
      leaseToken: effect.leaseToken,
      providerReference: transfer.id,
    });
    return;
  }
  if (operation.kind === "deposit" && operation.state === "review" && state === "complete") {
    await confirmReconciliationObservation({ effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken });
    return;
  }
  if (operation.kind === "cash_out" && operation.state === "refunded" && state === "complete") {
    await reviewLateOriginalCashOutCompletion({
      effectId: effect.id,
      operationId: operation.id,
      leaseToken: effect.leaseToken,
      providerReference: transfer.id,
      failureCode: "late_original_cash_out_complete_after_refund",
    });
    return;
  }
  if (operation.kind === "cash_out" && operation.state === "review" && state === "complete") {
    await confirmReconciliationObservation({ effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken });
    return;
  }
  if (["complete", "refunding"].includes(operation.state) && ["canceled", "failed", "refunding", "refunded"].includes(state)) {
    await reverseCompletedTransfer({
      effectId: effect.id,
      operationId: operation.id,
      leaseToken: effect.leaseToken,
      providerReference: transfer.id,
      providerEventId: effect.effectType,
      operationState: state as "canceled" | "failed" | "refunding" | "refunded",
      assetDenom: get("assetDenom"),
      principal: operation.principal,
      originalDebitAccount: "provider_clearing",
      originalCreditAccount: isDeposit ? "player_chain_observed" : "provider_cash_out_obligation",
      amountMicroUsd: operation.amountMicroUsd,
    });
    return;
  }
  if (state === "canceled" || state === "failed" || state === "refunded" || state === "refunding") {
    await completeEffect({
      effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken,
      operationState: state, providerReference: transfer.id, providerEventId: effect.effectType,
    });
    return;
  }
  if (state === "complete") {
    if (isDeposit) {
      if (!transfer.chainTxHash) throw new ProviderPendingError("CHAIN_TRANSACTION_EVIDENCE_MISSING");
      try {
        await verifyChainTransfer({ destination: get("destinationWalletAddress"), amountMicroUsd: operation.amountMicroUsd, assetDenom: get("assetDenom"), chainRestUrl: get("chainRestUrl"), chainId: get("chainId"), genesisHash: get("genesisHash"), finalityBlocks, txHash: transfer.chainTxHash });
      } catch (error) {
        if (error instanceof Error && ["CHAIN_IDENTITY_UNAVAILABLE", "CHAIN_TRANSACTION_NOT_FOUND", "CHAIN_FINALITY_UNAVAILABLE", "CHAIN_TRANSACTION_NOT_FINAL"].includes(error.message)) throw new ProviderPendingError(error.message);
        throw error;
      }
    }
    await completeTransferEffectWithJournal({ effectId: effect.id, operationId: operation.id, leaseToken: effect.leaseToken, providerReference: transfer.id, assetDenom: get("assetDenom"), principal: operation.principal, debitAccount: "provider_clearing", creditAccount: isDeposit ? "player_chain_observed" : "provider_cash_out_obligation", amountMicroUsd: operation.amountMicroUsd, providerEventId: effect.effectType });
    return;
  }
  await retryEffect(effect.id, effect.operationId, effect.leaseToken, `provider_${transfer.status}`, state === "review", effect.attemptCount, transfer.id);
}

async function processCashOutRefund(effect: ClaimedEffect): Promise<void> {
  const provider = createConfiguredBraleClient();
  const amountMicroUsd = effect.amountMicroUsd;
  if (!provider || !amountMicroUsd) throw new Error("FINANCE_NOT_CONFIGURED");
  const payload = encryptedPayload<TransferEffect>(effect);
  const {
    providerAccountId,
    internalAddressId,
    externalWalletAddressId,
    internalWalletAddress,
    originatingWalletAddress,
    assetDenom,
    chainRestUrl,
    finalityBlocks,
    transferType,
  } = payload;
  if (
    !providerAccountId || !internalAddressId || !externalWalletAddressId ||
    !internalWalletAddress || !originatingWalletAddress || !assetDenom ||
    !chainRestUrl || !payload.chainId || !/^[0-9a-f]{64}$/.test(payload.genesisHash) ||
    !Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0 ||
    (transferType !== "verona" && transferType !== "verona_testnet")
  ) throw new Error("MALFORMED_CASH_OUT_SNAPSHOT");
  const transferInput: Parameters<typeof provider.createTransfer>[0] = {
    amountUsd: formatMicroUsd(BigInt(amountMicroUsd), { symbol: false }),
    source: { addressId: internalAddressId, valueType: "verUSD", transferType },
    destination: { addressId: externalWalletAddressId, valueType: "verUSD", transferType },
    idempotencyKey: effect.providerIdempotencyKey,
    brandAccountId: providerAccountId,
  };
  await authorizeEffectDispatch({
    effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
    principal: effect.principal, step: "refund_transfer", action: "refund", amountMicroUsd,
  });
  const transfer = await provider.createTransfer(transferInput);
  assertTransferTuple(transfer, {
    accountId: providerAccountId,
    amountMicroUsd,
    source: { addressId: internalAddressId, valueType: "verUSD", transferType },
    destination: { addressId: externalWalletAddressId, valueType: "verUSD", transferType },
  }, effect.providerTransferId);
  const state = transferState(transfer.status);
  if (state === "complete") {
    if (!transfer.chainTxHash) throw new Error("CHAIN_TRANSACTION_EVIDENCE_MISSING");
    const height = await verifyChainTransfer({
      source: internalWalletAddress,
      destination: originatingWalletAddress,
      amountMicroUsd,
      assetDenom,
      chainRestUrl,
      chainId: payload.chainId,
      genesisHash: payload.genesisHash,
      finalityBlocks,
      txHash: transfer.chainTxHash,
    });
    await confirmCashOutRefundChainFinality({
      operationId: effect.operationId, effectId: effect.id, leaseToken: effect.leaseToken,
      returnedChainTxHash: transfer.chainTxHash, confirmedHeight: String(height),
    });
    return;
  }
  if (state === "failed" || state === "canceled" || state === "refunded") {
    await reviewCashOutRefund({
      effectId: effect.id, operationId: effect.operationId, leaseToken: effect.leaseToken,
      providerReference: transfer.id, failureCode: `provider_refund_${transfer.status}`,
    });
    return;
  }
  await retryEffect(effect.id, effect.operationId, effect.leaseToken, `provider_refund_${transfer.status}`, state === "review", effect.attemptCount, transfer.id);
}

async function processEffect(effect: ClaimedEffect): Promise<void> {
  if (effect.effectType === "enroll") return processEnrollment(effect);
  if (effect.effectType === "create_deposit") return processTransfer(effect, "deposit");
  if (effect.effectType === "create_cash_out") return processTransfer(effect, "cash_out");
  if (effect.effectType === "cash_out_refund") return processCashOutRefund(effect);
  if (effect.effectType.startsWith("reconcile_transfer:")) return processReconciliation(effect);
  if (await processCashGameEffect(effect)) return;
  throw new Error("UNKNOWN_EFFECT_TYPE");
}

export interface FinanceReconciliationScheduler {
  stop(): void;
  runOnce(): Promise<number>;
}

function resourceReconciliationErrorCode(error: unknown): string {
  if (error instanceof BraleApiError) return `provider_http_${error.status}`;
  if (error instanceof TypeError) return "provider_response_invalid";
  return "provider_resource_poll_failed";
}

async function reconcileProviderResource(
  resource: {
    resourceType: "account" | "address";
    resourceId: string;
    parentAccountId: string;
    leaseToken: string;
  },
  poll: () => Promise<{ id: string; status: string }>,
): Promise<void> {
  try {
    const observed = await poll();
    if (observed.id !== resource.resourceId) throw new TypeError("Provider resource identity mismatch");
    await reconcileProviderResourceState({
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      status: observed.status,
    });
    await completeProviderResourceReconciliation(resource);
  } catch (error) {
    const errorCode = resourceReconciliationErrorCode(error);
    try {
      await reconcileProviderResourceState({
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        status: "stale",
      });
      await failProviderResourceReconciliation({
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        leaseToken: resource.leaseToken,
        errorCode,
      });
    } catch (outcomeError) {
      logger.error("Finance resource retry outcome persistence failed", {
        errorCode: resourceReconciliationErrorCode(outcomeError),
        resourceType: resource.resourceType,
      });
    }
    logger.warn("Finance provider resource reconciliation failed", { errorCode, resourceType: resource.resourceType });
  }
}

async function reconcileProviderResources(workerId: string, includeSweep: boolean): Promise<void> {
  const provider = createConfiguredBraleClient();
  if (!provider) throw new Error("FINANCE_NOT_CONFIGURED");
  if (includeSweep) {
    const profiles = await listProviderResourcesForReconciliation();
    for (const profile of profiles) {
      const resources = [
        { resourceType: "account" as const, resourceId: profile.providerAccountId, parentAccountId: profile.providerAccountId },
        ...profile.providerAddressIds.map((resourceId) => ({
          resourceType: "address" as const,
          resourceId,
          parentAccountId: profile.providerAccountId,
        })),
        ...(profile.externalWalletAddressId ? [{
          resourceType: "address" as const,
          resourceId: profile.externalWalletAddressId,
          parentAccountId: profile.providerAccountId,
        }] : []),
        ...(profile.internalAddressId ? [{
          resourceType: "address" as const,
          resourceId: profile.internalAddressId,
          parentAccountId: provider.masterAccountId,
        }] : []),
      ];
      await Promise.all(resources.map((resource) => queueProviderResourceReconciliation(resource)));
    }
  }
  const requests = await claimProviderResourceReconciliations(workerId, 100);
  for (const request of requests) {
    await reconcileProviderResource(
      request,
      () => request.resourceType === "account"
        ? provider.getAccount(request.resourceId)
        : provider.getAddress(request.parentAccountId, request.resourceId),
    );
  }
}

export function startFinanceReconciliationScheduler(): FinanceReconciliationScheduler | null {
  if (fundsGate.config.mode === "free") return null;
  const intervalMs = 30_000;
  const workerId = `${process.env.FLY_ALLOC_ID ?? "local"}:provider-resource:${randomUUID()}`;
  let lastSweepAt = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const runOnce = async (): Promise<number> => {
    if (stopped) return 0;
    const now = Date.now();
    const includeSweep = now - lastSweepAt >= 300_000;
    if (includeSweep) lastSweepAt = now;
    try {
      await reconcileProviderResources(workerId, includeSweep);
    } catch (error) {
      logger.error("Finance provider resource reconciliation failed", { errorCode: error instanceof Error ? error.name : "unknown" });
    }
    try {
      if (includeSweep) await enqueueDueTransferReconciliations();
      const requests = await claimProviderTransferReconciliations(workerId, 100);
      await Promise.all(requests.map((request) => dispatchProviderTransferReconciliation(request)));
      return requests.length;
    } catch (error) {
      logger.error("Finance reconciliation enqueue failed", { errorCode: error instanceof Error ? error.name : "unknown" });
      return 0;
    }
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, intervalMs);
  };
  void runOnce();
  schedule();
  return { runOnce, stop: () => { stopped = true; clearTimeout(timer ?? undefined); } };
}
export interface FinanceWorker {
  stop(): void;
  runOnce(): Promise<boolean>;
}

export function startFinanceWorker(): FinanceWorker | null {
  if (fundsGate.config.mode === "free") return null;
  const workerId = `${process.env.FLY_ALLOC_ID ?? "local"}:${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const runOnce = async (): Promise<boolean> => {
    if (running || stopped) return false;
    running = true;
    try {
      const effect = await claimNextEffect(workerId);
      if (!effect) return false;
      try {
        await processEffect(effect);
      } catch (error) {
        if (error instanceof ProviderPendingError || error instanceof CashEffectPendingError) {
          await retryEffect(effect.id, effect.operationId, effect.leaseToken, error.code, false, effect.attemptCount);
        } else if (error instanceof BraleApiError) {
          const code = error.providerCode ?? `provider_http_${error.status}`;
          if (effect.effectType.startsWith("reconcile_transfer:") || error.retryable) {
            await retryEffect(effect.id, effect.operationId, effect.leaseToken, code, true, effect.attemptCount);
          } else {
            await failEffect(
              effect.id, effect.operationId, effect.leaseToken, code,
              effect.effectType === "enroll",
            );
          }
        } else if (error instanceof SettlementAuthorizerError) {
          const code = `settlement_authorizer_http_${error.status}`;
          if (error.retryable) {
            await retryEffect(effect.id, effect.operationId, effect.leaseToken, code, false, effect.attemptCount);
          } else {
            const quoteId = cashEscrowQuoteId(effect);
            if (quoteId) {
              await quarantineCashEscrowEffect({
                effectId: effect.id,
                operationId: effect.operationId,
                leaseToken: effect.leaseToken,
                quoteId,
                reason: code,
              });
            } else {
              await failEffect(effect.id, effect.operationId, effect.leaseToken, code);
            }
          }
        } else if (
          error instanceof TypeError ||
          (error instanceof Error && ["TRANSFER_TUPLE_MISMATCH", "TRANSFER_RECONCILIATION_UNBOUND"].includes(error.message))
        ) {
          await retryEffect(effect.id, effect.operationId, effect.leaseToken, "provider_result_ambiguous", true, effect.attemptCount);
        } else if (
          error instanceof Error &&
          ["FINANCE_NOT_CONFIGURED", "PAYMENT_PROFILE_NOT_ACTIVE", "PAYMENT_ADDRESSES_NOT_READY", "SETTLEMENT_AUTHORIZER_NOT_CONFIGURED"].includes(error.message)
        ) {
          await retryEffect(effect.id, effect.operationId, effect.leaseToken, error.message, false, effect.attemptCount);
        } else if (error instanceof Error && error.message === "EFFECT_LEASE_LOST") {
          return true;
        } else {
          const code = error instanceof Error ? error.message.slice(0, 80) : "unknown_effect_error";
          const providerEffect = effect.effectType === "enroll" ||
            effect.effectType === "create_deposit" ||
            effect.effectType === "create_cash_out" ||
            effect.effectType === "cash_out_refund" ||
            effect.effectType.startsWith("reconcile_transfer:");
          if (providerEffect) {
            await retryEffect(effect.id, effect.operationId, effect.leaseToken, code, true, effect.attemptCount);
          } else {
            await failEffect(effect.id, effect.operationId, effect.leaseToken, code);
          }
        }
      }
      return true;
    } finally {
      running = false;
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        const processed = await runOnce();
        schedule(processed ? 0 : 1_000);
      } catch (error) {
        logger.error("Finance worker iteration failed", { errorCode: error instanceof Error ? error.name : "unknown" });
        schedule(5_000);
      }
    }, delayMs);
  };
  schedule(0);

  return {
    stop(): void {
      stopped = true;
      clearTimeout(timer ?? undefined);
    },
    runOnce,
  };
}
