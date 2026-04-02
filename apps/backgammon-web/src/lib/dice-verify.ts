/**
 * Client-side dice verification using drand verifiable randomness.
 * Verifies BLS signatures from the League of Entropy and re-derives dice values.
 */

// drand quicknet public key (BLS12-381 G2)
const DRAND_QUICKNET_PUBLIC_KEY_HEX =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";

export const DRAND_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/** Hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Uint8Array to hex string */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Derive dice from drand randomness + game context (mirrors server logic) */
export async function deriveDice(
  drandRandomness: string,
  playerWhite: string,
  playerBlack: string,
  turnNumber: number,
): Promise<[number, number]> {
  const encoder = new TextEncoder();
  const data = encoder.encode(drandRandomness + playerWhite + playerBlack + String(turnNumber));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashBytes = new Uint8Array(hashBuffer);
  const die1 = (hashBytes[0] % 6) + 1;
  const die2 = (hashBytes[1] % 6) + 1;
  return [die1, die2];
}

/** Verify a drand BLS signature (quicknet: G1 signatures on BLS12-381) */
async function verifyBLSSignature(
  round: number,
  signature: string,
): Promise<boolean> {
  try {
    // Dynamic import to keep bundle size small — only loaded when verifying
    const { bls12_381: bls } = await import("@noble/curves/bls12-381");

    const sigBytes = hexToBytes(signature);
    const pubKeyBytes = hexToBytes(DRAND_QUICKNET_PUBLIC_KEY_HEX);

    // quicknet (bls-unchained-g1-rfc9380): message = SHA256(round as big-endian uint64)
    const roundBuf = new ArrayBuffer(8);
    const view = new DataView(roundBuf);
    view.setBigUint64(0, BigInt(round), false); // big-endian
    const msgHash = await crypto.subtle.digest("SHA-256", roundBuf);
    const msg = new Uint8Array(msgHash);

    // G1 signatures, G2 public key — use shortSignatures scheme
    return bls.verifyShortSignature(sigBytes, msg, pubKeyBytes);
  } catch {
    return false;
  }
}

/** Verify a single dice roll against its drand proof */
export async function verifyDiceRoll(params: {
  drandRound: number;
  drandRandomness: string;
  drandSignature: string;
  playerWhite: string;
  playerBlack: string;
  turnNumber: number;
  dice: [number, number];
}): Promise<{ valid: boolean; details: string }> {
  const { drandRound, drandRandomness, drandSignature, playerWhite, playerBlack, turnNumber, dice } = params;

  // 1. Verify BLS signature from drand
  const sigValid = await verifyBLSSignature(drandRound, drandSignature);
  if (!sigValid) {
    return { valid: false, details: `BLS signature verification failed for drand round ${drandRound}` };
  }

  // 2. Verify that the randomness matches the signature
  // drand: randomness = SHA256(signature)
  const sigBytes = hexToBytes(drandSignature);
  const randomnessHash = await crypto.subtle.digest("SHA-256", sigBytes);
  const expectedRandomness = bytesToHex(new Uint8Array(randomnessHash));
  if (expectedRandomness !== drandRandomness) {
    return { valid: false, details: `Randomness mismatch: expected ${expectedRandomness}, got ${drandRandomness}` };
  }

  // 3. Verify dice derivation
  const expectedDice = await deriveDice(drandRandomness, playerWhite, playerBlack, turnNumber);
  if (expectedDice[0] !== dice[0] || expectedDice[1] !== dice[1]) {
    return {
      valid: false,
      details: `Dice mismatch: expected [${expectedDice[0]}, ${expectedDice[1]}], got [${dice[0]}, ${dice[1]}]`,
    };
  }

  return { valid: true, details: "BLS signature verified, randomness derived correctly, dice match" };
}

export interface DiceProof {
  drandRound: number;
  drandRandomness: string;
  drandSignature: string;
  playerWhite: string;
  playerBlack: string;
  turnNumber: number;
  dice: [number, number];
}

export interface DiceProofsResponse {
  gameId: string;
  drandChain: string;
  playerWhite: string;
  playerBlack: string;
  rolls: DiceProof[];
}
