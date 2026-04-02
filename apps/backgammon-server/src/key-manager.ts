/**
 * KeyManager abstracts cryptographic signing for admin operations.
 *
 * Current: EnvKeyManager loads mnemonic from environment variable.
 * Future: KmsKeyManager delegates signing to AWS KMS / GCP KMS (mnemonic
 * never in server memory).
 *
 * Usage:
 *   const km = getKeyManager();
 *   const client = await km.getSigningClient(rpcUrl);
 *   const address = await km.getAddress();
 */

import { logger } from "./logger.js";
import { CHAIN_ADDRESS_PREFIX, GAS_PRICE } from "./config.js";

export interface KeyManager {
  getAddress(): Promise<string>;
  getSigningClient(rpcUrl: string): Promise<any>;
}

/**
 * Loads admin mnemonic from environment variable.
 * Suitable for development and early production (Fly.io secrets).
 */
export class EnvKeyManager implements KeyManager {
  private mnemonic: string;
  private cachedAddress: string | null = null;
  private cachedClient: any = null;

  constructor(envVar: string = "ESCROW_ADMIN_MNEMONIC") {
    const mnemonic = process.env[envVar];
    if (!mnemonic) throw new Error(`${envVar} not set`);
    this.mnemonic = mnemonic;
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;
    await this.init();
    return this.cachedAddress!;
  }

  async getSigningClient(rpcUrl: string): Promise<any> {
    if (this.cachedClient) return this.cachedClient;
    await this.init(rpcUrl);
    return this.cachedClient;
  }

  private async init(rpcUrl?: string): Promise<void> {
    const cosmwasmMod: any = await import("@cosmjs/cosmwasm-stargate");
    const signingMod: any = await import("@cosmjs/proto-signing");
    const stargateMod: any = await import("@cosmjs/stargate");

    const SigningCosmWasmClient = cosmwasmMod.SigningCosmWasmClient ?? cosmwasmMod.default?.SigningCosmWasmClient;
    const DirectSecp256k1HdWallet = signingMod.DirectSecp256k1HdWallet ?? signingMod.default?.DirectSecp256k1HdWallet;
    const GasPrice = stargateMod.GasPrice ?? stargateMod.default?.GasPrice;

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, { prefix: CHAIN_ADDRESS_PREFIX });
    const [account] = await wallet.getAccounts();
    this.cachedAddress = account.address;

    if (rpcUrl) {
      this.cachedClient = await SigningCosmWasmClient.connectWithSigner(
        rpcUrl, wallet, { gasPrice: GasPrice.fromString(GAS_PRICE) },
      );
    }

    logger.info("EnvKeyManager initialized", { address: this.cachedAddress });
  }
}

/**
 * Placeholder for cloud KMS integration.
 * When implemented, signing happens in the HSM — the mnemonic never
 * exists in server memory.
 *
 * To implement:
 * 1. Store the mnemonic as a KMS-encrypted secret
 * 2. Use KMS to sign transaction bytes directly
 * 3. Or use a KMS-backed HD wallet (cosmjs supports custom signers)
 */
export class KmsKeyManager implements KeyManager {
  async getAddress(): Promise<string> {
    throw new Error("KmsKeyManager not implemented — set KMS_KEY_ID and KMS_REGION env vars");
  }
  async getSigningClient(_rpcUrl: string): Promise<any> {
    throw new Error("KmsKeyManager not implemented");
  }
}

/** Factory: returns the appropriate KeyManager based on environment */
export function getKeyManager(envVar: string = "ESCROW_ADMIN_MNEMONIC"): KeyManager | null {
  // Future: check for KMS_KEY_ID to use KmsKeyManager
  if (process.env.KMS_KEY_ID) {
    logger.warn("KMS_KEY_ID is set but KmsKeyManager is not yet implemented. Falling back to EnvKeyManager.");
  }

  try {
    return new EnvKeyManager(envVar);
  } catch {
    return null;
  }
}
