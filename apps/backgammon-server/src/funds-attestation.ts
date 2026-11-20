import { CASH_GAME_RULES_V1 } from "@xion-beginner/backgammon-core";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { z } from "zod";
import { createConfiguredBraleClient } from "./brale.js";
import { checkDatabase } from "./db.js";
import { fundsGate, type FundsAttestationResult } from "./funds-config.js";
import { logger } from "./logger.js";
import { configuredSettlementAuthorizer } from "./settlement-authorizer.js";

const EscrowConfigSchema = z.object({
  admin: z.string(),
  wager_denom: z.string(),
  settlement_authority: z.string(),
  rake_bps: z.number().int().min(0).max(10_000),
  rake_recipient: z.string(),
  min_stake_per_point: z.string().regex(/^(0|[1-9]\d*)$/),
  max_stake_per_point: z.string().regex(/^[1-9]\d*$/),
  funding_timeout_seconds: z.number().int().positive(),
  cube_cap: z.number().int(),
  rules_version: z.string(),
  paused: z.boolean(),
}).strict();
const FinanceRouterConfigSchema = z.object({
  admin: z.string(),
  denom: z.string(),
  max_transfer: z.string().regex(/^[1-9]\d*$/),
  authorization_public_key: z.string().min(1),
}).strict();


const DenomMetadataSchema = z.object({
  metadata: z.object({
    base: z.string(),
    display: z.string(),
    symbol: z.string(),
    denom_units: z.array(z.object({ denom: z.string(), exponent: z.number().int() })),
  }),
});

const RpcBlockSchema = z.object({
  result: z.object({
    block_id: z.object({ hash: z.string() }),
    block: z.object({ header: z.object({ chain_id: z.string() }) }),
  }),
});

const RestNodeInfoSchema = z.object({
  default_node_info: z.object({ network: z.string() }),
});

const RestBlockSchema = z.object({
  block_id: z.object({ hash: z.string() }),
  block: z.object({ header: z.object({ chain_id: z.string() }) }),
});

function chainEndpoint(url: string): string {
  return url.replace(/\/$/, "");
}

export async function attestFundsEnvironment(): Promise<FundsAttestationResult> {
  const result = {
    infrastructure: [] as string[],
    asset: [] as string[],
    escrowIntegrity: [] as string[],
    escrowEntry: [] as string[],
    escrowRecovery: [] as string[],
    provider: [] as string[],
    financeRouter: [] as string[],
  };
  if (fundsGate.config.mode === "free") {
    fundsGate.setAttestation(result);
    return result;
  }
  const asset = fundsGate.config.asset;
  if (!asset) {
    result.asset.push("missing_or_unapproved_asset_manifest");
    result.escrowIntegrity.push("missing_or_unapproved_asset_manifest");
    result.escrowEntry.push("missing_or_unapproved_asset_manifest");
    result.escrowRecovery.push("missing_or_unapproved_asset_manifest");
    result.financeRouter.push("missing_or_unapproved_asset_manifest");
    fundsGate.setAttestation(result);
    return result;
  }

  const database = await checkDatabase();
  if (!database.connected) result.infrastructure.push("database_unreachable");
  else if (!database.migrated) result.infrastructure.push("database_migration_required");

  let chain: CosmWasmClient | null = null;
  try {
    chain = await CosmWasmClient.connect(asset.rpcUrl);
  } catch (error) {
    result.asset.push("chain_connection_failed");
    result.escrowIntegrity.push("chain_connection_failed");
    result.escrowEntry.push("chain_connection_failed");
    result.escrowRecovery.push("chain_connection_failed");
    result.financeRouter.push("chain_connection_failed");
  }
  if (chain) {
    try {
      const [rpcChainId, rpcGenesisResponse, restNodeInfoResponse, restGenesisResponse] = await Promise.all([
        chain.getChainId(),
        fetch(`${chainEndpoint(asset.rpcUrl)}/block?height=1`, { signal: AbortSignal.timeout(10_000) }),
        fetch(`${chainEndpoint(asset.restUrl)}/cosmos/base/tendermint/v1beta1/node_info`, { signal: AbortSignal.timeout(10_000) }),
        fetch(`${chainEndpoint(asset.restUrl)}/cosmos/base/tendermint/v1beta1/blocks/1`, { signal: AbortSignal.timeout(10_000) }),
      ]);
      if (!rpcGenesisResponse.ok || !restNodeInfoResponse.ok || !restGenesisResponse.ok) {
        result.asset.push("chain_identity_attestation_failed");
      } else {
        const rpcGenesis = RpcBlockSchema.parse(await rpcGenesisResponse.json());
        const restNodeInfo = RestNodeInfoSchema.parse(await restNodeInfoResponse.json());
        const restGenesis = RestBlockSchema.parse(await restGenesisResponse.json());
        const expectedGenesisHash = asset.genesisHash;
        if (
          rpcChainId !== asset.chainId ||
          rpcGenesis.result.block.header.chain_id !== asset.chainId ||
          restNodeInfo.default_node_info.network !== asset.chainId ||
          restGenesis.block.header.chain_id !== asset.chainId ||
          rpcGenesis.result.block_id.hash.toLowerCase() !== expectedGenesisHash ||
          restGenesis.block_id.hash.toLowerCase() !== expectedGenesisHash ||
          rpcGenesis.result.block_id.hash.toLowerCase() !== restGenesis.block_id.hash.toLowerCase()
        ) result.asset.push("chain_identity_mismatch");
      }
    } catch {
      result.asset.push("chain_identity_attestation_failed");
    }
    try {
      const contract = await chain.getContract(asset.escrowContract);
      const code = await chain.getCodeDetails(contract.codeId);
      const expectedAdmin = process.env.VERUSD_ESCROW_ADMIN?.trim();
      const expectedAuthority = process.env.SETTLEMENT_AUTHORITY_CONTRACT?.trim();
      const config = EscrowConfigSchema.parse(await chain.queryContractSmart(asset.escrowContract, { config: {} }));
      if (code.checksum.toLowerCase() !== asset.escrowCodeChecksum) result.escrowIntegrity.push("escrow_checksum_mismatch");
      if (!expectedAdmin || contract.admin !== expectedAdmin || config.admin !== expectedAdmin) {
        result.escrowIntegrity.push("escrow_admin_mismatch");
      }
      if (config.wager_denom !== asset.denom) result.escrowIntegrity.push("escrow_denom_mismatch");
      if (!expectedAuthority || config.settlement_authority !== expectedAuthority) {
        result.escrowIntegrity.push("settlement_authority_mismatch");
      }
      if (config.cube_cap !== 8) result.escrowEntry.push("escrow_cube_cap_mismatch");
      if (config.rules_version !== CASH_GAME_RULES_V1.version) result.escrowEntry.push("escrow_rules_version_mismatch");
      if (config.rake_bps !== CASH_GAME_RULES_V1.rakeBps) result.escrowEntry.push("escrow_rake_mismatch");
      if (config.paused) result.escrowEntry.push("escrow_paused");
      if (config.min_stake_per_point !== process.env.VERUSD_MIN_STAKE_MICRO_USD) {
        result.escrowEntry.push("escrow_min_stake_mismatch");
      }
      if (config.max_stake_per_point !== process.env.VERUSD_MAX_STAKE_MICRO_USD) {
        result.escrowEntry.push("escrow_max_stake_mismatch");
      }
      if (String(config.funding_timeout_seconds) !== process.env.VERUSD_FUNDING_TIMEOUT_SECONDS) {
        result.escrowEntry.push("escrow_funding_timeout_mismatch");
      }
      if (config.rake_recipient !== process.env.VERUSD_RAKE_RECIPIENT) result.escrowEntry.push("escrow_rake_recipient_mismatch");
      try {
        const financeContract = process.env.FINANCE_AUTHORIZATION_CONTRACT?.trim() ?? "";
        const finance = await chain.getContract(financeContract);
        const financeCode = await chain.getCodeDetails(finance.codeId);
        const financeConfig = FinanceRouterConfigSchema.parse(
          await chain.queryContractSmart(financeContract, { config: {} }),
        );
        const expectedAdmin = process.env.FINANCE_AUTHORIZATION_ADMIN?.trim() ?? "";
        const expectedChecksum = process.env.FINANCE_AUTHORIZATION_CODE_CHECKSUM?.trim() ?? "";
        const expectedMax = process.env.FINANCE_AUTHORIZATION_MAX_TRANSFER_MICRO_USD?.trim() ?? "";
        const expectedPublicKey = process.env.CASH_OUT_AUTHORIZATION_PUBLIC_KEY?.trim() ?? "";
        const expectedPublicKeyBase64 = /^(02|03)[0-9a-f]{64}$/.test(expectedPublicKey)
          ? Buffer.from(expectedPublicKey, "hex").toString("base64")
          : "";
        if (financeCode.checksum.toLowerCase() !== expectedChecksum) {
          result.financeRouter.push("finance_router_checksum_mismatch");
        }
        if (!expectedAdmin || finance.admin !== expectedAdmin || financeConfig.admin !== expectedAdmin) {
          result.financeRouter.push("finance_router_admin_mismatch");
        }
        if (financeConfig.denom !== asset.denom) result.financeRouter.push("finance_router_denom_mismatch");
        if (financeConfig.max_transfer !== expectedMax) result.financeRouter.push("finance_router_limit_mismatch");
        if (!expectedPublicKeyBase64 || financeConfig.authorization_public_key !== expectedPublicKeyBase64) {
          result.financeRouter.push("finance_router_authorization_key_mismatch");
        }
      } catch (error) {
        result.financeRouter.push("finance_router_attestation_failed");
        logger.warn("Cash-out router attestation failed", {
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      }
    } catch (error) {
      result.escrowIntegrity.push("escrow_integrity_attestation_failed");
      result.escrowEntry.push("escrow_entry_attestation_failed");
      result.escrowRecovery.push("escrow_recovery_attestation_failed");
      result.financeRouter.push("finance_router_attestation_failed");
      logger.warn("Funds escrow attestation failed", { errorCode: error instanceof Error ? error.name : "unknown" });
    } finally {
      chain.disconnect();
    }
  }

  try {
    const response = await fetch(
      `${chainEndpoint(asset.restUrl)}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(asset.denom)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error("ASSET_METADATA_HTTP_ERROR");
    const metadata = DenomMetadataSchema.parse(await response.json()).metadata;
    const displayUnit = metadata.denom_units.find((unit) => unit.denom === metadata.display);
    if (metadata.base !== asset.denom || metadata.symbol !== asset.symbol || displayUnit?.exponent !== asset.decimals) {
      result.asset.push("asset_metadata_mismatch");
    }
  } catch {
    result.asset.push("asset_metadata_unavailable");
  }

  if (!configuredSettlementAuthorizer()) result.escrowEntry.push("settlement_authorizer_unavailable");

  if ((fundsGate.config.providerIdentityBlockers?.length ?? 0) > 0) {
    result.provider.push("provider_identity_unapproved");
  } else {
    try {
      const provider = createConfiguredBraleClient();
      const account = provider ? await provider.getAccount() : null;
      if (!account || account.status !== "complete") {
        result.provider.push("brale_account_not_ready");
      } else if (account.id !== fundsGate.config.accountId) {
        result.provider.push("brale_account_mismatch");
      } else {
        const programId = process.env.BRALE_PROGRAM_ID?.trim();
        const requiredCapability = process.env.BRALE_REQUIRED_ACCOUNT_CAPABILITY?.trim();
        if (!programId || account.programId !== programId) result.provider.push("brale_account_program_mismatch");
        if (!requiredCapability || !account.capabilities.includes(requiredCapability)) {
          result.provider.push("brale_account_capability_missing");
        }
      }
    } catch (error) {
      result.provider.push("brale_attestation_failed");
      logger.warn("Funds provider attestation failed", { errorCode: error instanceof Error ? error.name : "unknown" });
    }
  }

  fundsGate.setAttestation(result);
  return result;
}

