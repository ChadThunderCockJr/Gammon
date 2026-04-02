import { logger } from "./logger.js";
import { getRedis } from "./redis.js";
import { CHAIN_ADDRESS_PREFIX, GAS_PRICE, REDEMPTION_POLL_INTERVAL_MS, NFT_QUERY_LIMIT } from "./config.js";

/**
 * Gammon Token Redemption Service
 *
 * Polls the CW721 NFT contract for token packs transferred to the dev address.
 * When a new pack is detected, mints equivalent Gammon tokens to the original sender
 * via Token Factory MsgMint.
 *
 * Flow:
 * 1. User transfers NFT pack to dev address (burn)
 * 2. This service detects the new token owned by dev address
 * 3. Queries token metadata to determine pack amount
 * 4. Mints Gammon tokens to the original sender
 * 5. Marks the token as processed in Redis
 */

const POLL_INTERVAL_MS = REDEMPTION_POLL_INTERVAL_MS;

interface RedemptionConfig {
  rpcUrl: string;
  nftContract: string;
  devAddress: string;
  gammonDenom: string;
  adminMnemonic: string;
}

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let signingClient: any = null;
let adminAddress: string = "";
let initialized = false;

function getConfig(): RedemptionConfig | null {
  const rpcUrl = process.env.XION_RPC_URL;
  const nftContract = process.env.GAMMON_NFT_CONTRACT;
  const devAddress = process.env.GAMMON_DEV_ADDRESS;
  const gammonDenom = process.env.GAMMON_DENOM;
  const adminMnemonic = process.env.GAMMON_ADMIN_MNEMONIC;

  if (!rpcUrl || !nftContract || !devAddress || !gammonDenom || !adminMnemonic) {
    return null;
  }

  return { rpcUrl, nftContract, devAddress, gammonDenom, adminMnemonic };
}

async function initClient(config: RedemptionConfig): Promise<boolean> {
  if (initialized) return !!signingClient;
  initialized = true;

  try {
    const cosmwasmMod: any = await import("@cosmjs/cosmwasm-stargate");
    const signingMod: any = await import("@cosmjs/proto-signing");
    const stargateMod: any = await import("@cosmjs/stargate");

    const SigningCosmWasmClient =
      cosmwasmMod.SigningCosmWasmClient ?? cosmwasmMod.default?.SigningCosmWasmClient;
    const DirectSecp256k1HdWallet =
      signingMod.DirectSecp256k1HdWallet ?? signingMod.default?.DirectSecp256k1HdWallet;
    const GasPrice = stargateMod.GasPrice ?? stargateMod.default?.GasPrice;

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(config.adminMnemonic, {
      prefix: CHAIN_ADDRESS_PREFIX,
    });
    const [account] = await wallet.getAccounts();
    adminAddress = account.address;

    signingClient = await SigningCosmWasmClient.connectWithSigner(
      config.rpcUrl,
      wallet,
      { gasPrice: GasPrice.fromString(GAS_PRICE) }
    );

    logger.info("Gammon redemption client initialized", { admin: adminAddress });
    return true;
  } catch (err) {
    logger.error("Failed to initialize redemption client", { error: String(err) });
    return false;
  }
}

/**
 * Parse pack amount from token ID.
 * Expected format: pack-{amount}-{uuid} (e.g., pack-100-abc123)
 */
function parsePackAmount(tokenId: string): number {
  const match = tokenId.match(/^pack-(\d+)-/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}

/**
 * Check if a token has already been processed.
 */
async function isProcessed(tokenId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const result = await redis.get(`gammon:redeemed:${tokenId}`);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Mark a token as processed.
 */
async function markProcessed(tokenId: string, recipient: string, amount: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(
      `gammon:redeemed:${tokenId}`,
      JSON.stringify({ recipient, amount, processedAt: Date.now() })
    );
  } catch (err) {
    logger.error("Failed to mark token as processed", { tokenId, error: String(err) });
  }
}

/**
 * Query the transfer history for a token to find the original sender.
 * Uses CW721 `all_nft_info` + chain tx query to find who sent the NFT.
 *
 * Fallback: query the contract's transfer events from the chain.
 */
async function findOriginalSender(
  config: RedemptionConfig,
  tokenId: string
): Promise<string | null> {
  try {
    // Query the chain for the transfer event of this token to the dev address.
    // We look for wasm events with action=transfer_nft, recipient=devAddress, token_id=tokenId
    const stargateMod: any = await import("@cosmjs/stargate");
    const StargateClient = stargateMod.StargateClient ?? stargateMod.default?.StargateClient;
    const client = await StargateClient.connect(config.rpcUrl);

    // Search for the transfer tx using the indexer
    const txs = await client.searchTx([
      { key: "wasm.action", value: "transfer_nft" },
      { key: "wasm.recipient", value: config.devAddress },
      { key: "wasm.token_id", value: tokenId },
    ]);

    if (txs.length > 0) {
      // Get the most recent transfer tx
      const tx = txs[txs.length - 1];
      // Parse the sender from the wasm event attributes
      for (const event of tx.events) {
        if (event.type === "wasm") {
          const senderAttr = event.attributes.find(
            (a: { key: string; value: string }) => a.key === "sender"
          );
          if (senderAttr) {
            return senderAttr.value;
          }
        }
      }
    }

    return null;
  } catch (err) {
    logger.error("Failed to find original sender", { tokenId, error: String(err) });
    return null;
  }
}

/**
 * Mint Gammon tokens to a recipient via Token Factory MsgMint.
 */
async function mintGammonTokens(
  config: RedemptionConfig,
  recipient: string,
  packAmount: number
): Promise<boolean> {
  // Convert pack amount to micro units (6 decimals)
  const microAmount = String(packAmount * 1_000_000);

  try {
    const mintMsg = {
      typeUrl: "/osmosis.tokenfactory.v1beta1.MsgMint",
      value: {
        sender: adminAddress,
        amount: { denom: config.gammonDenom, amount: microAmount },
        mintToAddress: recipient,
      },
    };

    const result = await signingClient.signAndBroadcast(
      adminAddress,
      [mintMsg],
      "auto"
    );

    if (result.code !== 0) {
      logger.error("Mint tx failed", { code: result.code, log: result.rawLog });
      return false;
    }

    logger.info("Gammon tokens minted", {
      recipient,
      amount: packAmount,
      microAmount,
      txHash: result.transactionHash,
    });
    return true;
  } catch (err) {
    logger.error("Failed to mint Gammon tokens", { recipient, amount: packAmount, error: String(err) });
    return false;
  }
}

/**
 * Main polling loop: check for new NFT packs sent to dev address.
 */
async function pollForRedemptions(config: RedemptionConfig): Promise<void> {
  try {
    // Query all tokens owned by the dev address
    const result = await signingClient.queryContractSmart(config.nftContract, {
      tokens: { owner: config.devAddress, limit: NFT_QUERY_LIMIT },
    });

    const tokenIds: string[] = result?.tokens || [];
    if (tokenIds.length === 0) return;

    for (const tokenId of tokenIds) {
      // Skip already processed tokens
      if (await isProcessed(tokenId)) continue;

      const packAmount = parsePackAmount(tokenId);
      if (packAmount <= 0) {
        logger.warn("Unknown pack format, skipping", { tokenId });
        await markProcessed(tokenId, "unknown", 0);
        continue;
      }

      // Find who sent this NFT to the dev address
      const sender = await findOriginalSender(config, tokenId);
      if (!sender) {
        logger.warn("Could not determine sender for token, will retry", { tokenId });
        continue;
      }

      logger.info("Processing pack redemption", { tokenId, sender, packAmount });

      // Credit balance: custodial (PostgreSQL) if available, else on-chain mint
      let success = false;
      if (process.env.DATABASE_URL) {
        // Custodial mode: credit the player's balance directly
        try {
          const { CustodialBalanceService } = await import("./custodial-balance-service.js");
          const custodial = new CustodialBalanceService();
          success = await custodial.creditBalance(sender, BigInt(packAmount * 1_000_000), `NFT pack redeemed: ${tokenId}`);
        } catch (err) {
          logger.error("Custodial credit failed, falling back to on-chain mint", { error: String(err) });
          success = await mintGammonTokens(config, sender, packAmount);
        }
      } else {
        // On-chain mode: mint Gammon tokens
        success = await mintGammonTokens(config, sender, packAmount);
      }

      if (success) {
        await markProcessed(tokenId, sender, packAmount);
        logger.info("Pack redeemed successfully", { tokenId, sender, packAmount, mode: process.env.DATABASE_URL ? "custodial" : "on-chain" });
      }
    }
  } catch (err) {
    logger.error("Redemption poll error", { error: String(err) });
  }
}

/**
 * Start the Gammon token redemption polling loop.
 * Call this from the server's startup sequence.
 */
export async function startRedemptionService(): Promise<void> {
  const config = getConfig();
  if (!config) {
    logger.warn(
      "Gammon redemption service not configured — missing GAMMON_NFT_CONTRACT, GAMMON_DEV_ADDRESS, GAMMON_DENOM, or GAMMON_ADMIN_MNEMONIC"
    );
    return;
  }

  const ready = await initClient(config);
  if (!ready) {
    logger.error("Gammon redemption service failed to initialize");
    return;
  }

  logger.info("Starting Gammon redemption service", {
    nftContract: config.nftContract,
    devAddress: config.devAddress,
    gammonDenom: config.gammonDenom,
    pollInterval: POLL_INTERVAL_MS,
  });

  // Initial poll
  await pollForRedemptions(config);

  // Start periodic polling
  pollingTimer = setInterval(() => {
    pollForRedemptions(config);
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the redemption polling loop.
 */
export function stopRedemptionService(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    logger.info("Gammon redemption service stopped");
  }
}
