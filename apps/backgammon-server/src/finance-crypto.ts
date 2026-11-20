import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export interface EncryptedPayload {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

function keyMaterial(keyId?: string): Buffer {
  const configuredKeyId = keyId ?? process.env.FINANCE_DATA_KEY_ID ?? "primary";
  const encodedKeyRing = process.env.FINANCE_DATA_KEYS;
  let encoded: string | undefined;
  if (encodedKeyRing) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedKeyRing);
    } catch {
      throw new Error("FINANCE_DATA_KEYS must be a JSON object");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FINANCE_DATA_KEYS must be a JSON object");
    }
    const candidate = (parsed as Record<string, unknown>)[configuredKeyId];
    if (typeof candidate === "string") encoded = candidate;
  } else if (process.env.NODE_ENV !== "production" && configuredKeyId === (process.env.FINANCE_DATA_KEY_ID ?? "primary")) {
    encoded = process.env.FINANCE_DATA_KEY;
  }
  if (!encoded) throw new Error(`Finance data key is unavailable for key id ${configuredKeyId}`);
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error(`Finance data key ${configuredKeyId} must be a Base64-encoded 32-byte key`);
  return key;
}
function hashKeyMaterial(): Buffer {
  const encoded = process.env.FINANCE_HASH_KEY;
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("FINANCE_HASH_KEY must be a Base64-encoded 32-byte key");
    return key;
  }
  if (process.env.NODE_ENV === "production") throw new Error("FINANCE_HASH_KEY is required");
  return keyMaterial();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Keyed hash for idempotency comparisons without exposing low-entropy PII. */
export function sensitivePayloadHash(value: unknown): string {
  return createHmac("sha256", hashKeyMaterial()).update(canonicalJson(value)).digest("hex");
}

export function encryptSensitiveJson(value: unknown, associatedId: string): EncryptedPayload {
  const keyId = process.env.FINANCE_DATA_KEY_ID ?? "primary";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(keyId), iv);
  cipher.setAAD(Buffer.from(associatedId));
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(value), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSensitiveJson<T>(payload: EncryptedPayload, associatedId: string): T {
  if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted payload version");
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial(payload.keyId), Buffer.from(payload.iv, "base64"));
  decipher.setAAD(Buffer.from(associatedId));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
