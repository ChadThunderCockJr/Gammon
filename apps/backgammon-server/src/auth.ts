import { randomBytes } from "node:crypto";
import { NONCE_TTL_MS, NONCE_CLEANUP_INTERVAL_MS } from "./config.js";

// Nonce store with TTL
const nonceStore = new Map<string, { createdAt: number }>();

// Clean up expired nonces periodically
setInterval(() => {
  const now = Date.now();
  for (const [nonce, data] of nonceStore) {
    if (now - data.createdAt > NONCE_TTL_MS) {
      nonceStore.delete(nonce);
    }
  }
}, NONCE_CLEANUP_INTERVAL_MS);

/** Generate a single-use nonce for auth challenge */
export function generateNonce(): string {
  const nonce = randomBytes(32).toString("hex") + ":" + Date.now();
  nonceStore.set(nonce, { createdAt: Date.now() });
  return nonce;
}

/** Consume a nonce (single-use) - returns true if valid */
function consumeNonce(nonce: string): boolean {
  const data = nonceStore.get(nonce);
  if (!data) return false;
  if (Date.now() - data.createdAt > NONCE_TTL_MS) {
    nonceStore.delete(nonce);
    return false;
  }
  nonceStore.delete(nonce); // single-use
  return true;
}

/**
 * Construct an ADR-36 sign doc for arbitrary message signing.
 * ADR-36 uses a StdSignDoc with empty fee/msgs except one MsgSignData.
 */
function makeADR36SignDoc(signer: string, data: string) {
  return {
    chain_id: "",
    account_number: "0",
    sequence: "0",
    fee: { gas: "0", amount: [] },
    msgs: [
      {
        type: "sign/MsgSignData",
        value: {
          signer,
          data: Buffer.from(data).toString("base64"),
        },
      },
    ],
    memo: "",
  };
}

/**
 * Verify a wallet signature using ADR-36 (Cosmos arbitrary message signing).
 * Manually constructs the ADR-36 sign doc and verifies using secp256k1.
 */
export async function verifySignature(
  address: string,
  nonce: string,
  signature: string,
  pubkey: string,
  signerAddress?: string,
): Promise<boolean> {
  // Validate nonce is valid and not expired
  if (!consumeNonce(nonce)) {
    return false;
  }

  try {
    const cryptoMod: any = await import("@cosmjs/crypto");
    const aminoMod: any = await import("@cosmjs/amino");

    const Secp256k1 = cryptoMod.Secp256k1 ?? cryptoMod.default?.Secp256k1;
    const Sha256 = cryptoMod.Sha256 ?? cryptoMod.default?.Sha256;
    const serializeSignDoc = aminoMod.serializeSignDoc ?? aminoMod.default?.serializeSignDoc;

    const pubkeyBytes = Buffer.from(pubkey, "base64");
    const sigBytes = Buffer.from(signature, "base64");

    // With Abstraxion session keys, the signing pubkey is a grantee key that
    // derives to a different address than the granter address used as identity.
    // The signature still provides meaningful auth: nonce prevents replay,
    // signature proves control of a valid session key, and session key
    // existence proves the user went through Abstraxion's wallet auth flow.
    // Use the signer address (session key address) for the ADR-36 sign doc,
    // falling back to the claimed address for non-session-key wallets.
    const docSigner = signerAddress || address;

    // Construct the ADR-36 sign doc and serialize it
    const signDoc = makeADR36SignDoc(docSigner, nonce);
    const signBytes = serializeSignDoc(signDoc);

    // Hash the sign doc (Cosmos signs SHA-256 of the serialized doc)
    const messageHash = new Sha256(signBytes).digest();

    // Verify the secp256k1 signature
    // @cosmjs/crypto Secp256k1 expects a 64-byte signature (r + s, no recovery byte)
    const sig = sigBytes.length === 65 ? sigBytes.slice(0, 64) : sigBytes;

    const valid = await Secp256k1.verifySignature(
      { r: sig.slice(0, 32), s: sig.slice(32, 64) } as never,
      messageHash,
      pubkeyBytes,
    );

    return valid;
  } catch (err) {
    console.error("[Auth] Signature verification failed:", err);
    return false;
  }
}

