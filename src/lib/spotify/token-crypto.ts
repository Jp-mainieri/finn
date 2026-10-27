/**
 * Encryption of the Spotify refresh token at rest (docs/contratos/custodia-token-spotify.md).
 * AES-256-GCM, random 12-byte IV per write, AAD = `finn:<env>:spotify:<driverId>` (a blob copied to
 * another driver or environment does not decrypt). Blob: `v1.<iv>.<ct>.<tag>` in base64url.
 * Nothing here logs, and no error carries the plaintext, the key or the blob.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isAcceptableSecret } from "../driver/session-token";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Env vars the encryption key must differ from (case-insensitive). */
const OTHER_SECRETS = ["FINN_SESSION_SECRET", "FINN_INVITE_PEPPER", "FINN_A2A_TOKEN", "FINN_A2A_TOKEN_NEXT", "FINN_API_TOKEN"];

/**
 * The key from FINN_TOKEN_ENC_KEY (64 hex, >= 8 distinct chars, different from the other secrets),
 * or null. Null means the feature is OFF: callers must neither write nor read tokens (fail closed).
 */
export function getTokenEncKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.FINN_TOKEN_ENC_KEY?.trim();
  if (!raw || !isAcceptableSecret(raw)) return null;
  const lower = raw.toLowerCase();
  for (const name of OTHER_SECRETS) {
    const other = env[name]?.trim();
    if (other && other.toLowerCase() === lower) return null;
  }
  return Buffer.from(raw, "hex");
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Invalid token key");
}

export function encryptToken(plaintext: string, key: Buffer, aad: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

function decodeCanonical(s: string): Buffer | null {
  if (!B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

/** The plaintext, or null for ANY problem (shape, tag, AAD, key). Never throws, never says why. */
export function decryptToken(blob: unknown, key: Buffer, aad: string): string | null {
  try {
    assertKey(key);
    if (typeof blob !== "string" || blob.length > 4200) return null;
    const parts = blob.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const iv = decodeCanonical(parts[1]);
    const ct = decodeCanonical(parts[2]);
    const tag = decodeCanonical(parts[3]);
    if (!iv || !ct || !tag || iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ct.length < 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag); // the tag is verified by GCM in final(), not compared by hand
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return out || null;
  } catch {
    return null;
  }
}
