/**
 * Driver identity store contract (see docs/contratos/identidade-e-perfil.md).
 * Pure lib: no Next.js imports. Never log tokens, invite codes or secrets.
 * Timestamps in Driver/Invite are epoch milliseconds.
 */

export type DriverStatus = "active" | "revoked";

export interface Driver {
  driverId: string;
  label: string;
  status: DriverStatus;
  tokenVersion: number;
  createdAt: number;
  spotifyUserId?: string;
}

export interface DriverStore {
  createDriver(input: { label: string }): Promise<Driver>;
  getDriver(driverId: string): Promise<Driver | null>;
  revokeDriver(driverId: string): Promise<void>;
  /** Owner-script only: every driver in the `drivers` index (id, label, status, createdAt; no secret), oldest first. */
  listDrivers(): Promise<Driver[]>;
  /** Same as listDrivers plus how many index entries were skipped (invalid id, missing or corrupt hash). */
  listDriversDetailed(): Promise<{ drivers: Driver[]; skipped: number }>;
  /** Atomically increments tokenVersion of an ACTIVE driver (old tokens stop validating). No-op if missing/revoked. */
  rotateSessions(driverId: string): Promise<void>;
  /** `expiresAt` is epoch milliseconds (future, at most 1 year). `maxUses` 1..1000. */
  createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }>;
  /** Atomic. Null when invalid, exhausted, expired, revoked or unknown (indistinguishable). */
  redeemInvite(code: string): Promise<Driver | null>;
  /** True when the invite existed and is now revoked (or already was); false when not found or malformed. Never creates anything. */
  revokeInvite(code: string): Promise<boolean>;
  /** Increments a counter scoped by `key` and returns the new value; TTL set on first hit of the window. */
  incrementRateLimit(key: string, windowSeconds: number): Promise<number>;
  /** Current value of a counter without changing it (0 when absent or expired). Fail closed: errors propagate. */
  peekRateLimit(key: string): Promise<number>;
  /** Encrypted Spotify refresh token blob (opaque `v1.` string, never plaintext) or null. Redis down throws the generic error. */
  getSpotifyBlob(driverId: string): Promise<string | null>;
  /** Stores an already ENCRYPTED blob (validated shape: a plaintext token is rejected). No TTL. */
  setSpotifyBlob(driverId: string, blob: string): Promise<void>;
  /** Stores a rotated blob ONLY if one still exists (SET ... XX). False when it is gone (disconnected, revoked, purged): nothing is created. */
  setSpotifyBlobIfExists(driverId: string, blob: string): Promise<boolean>;
  /** True when the driver still has a blob (no content is returned). */
  hasSpotifyBlob(driverId: string): Promise<boolean>;
  /** Idempotent. Also removes the account link of THIS driver (spotify-index / spotify-account), and only theirs. */
  deleteSpotifyBlob(driverId: string): Promise<void>;
  /**
   * Binds a Spotify account to the driver (`spotify-index:<id>` -> driverId, SET NX). "linked" when new or already
   * the same driver (reconnect; a changed account releases the driver's previous link); "conflict" when another driver owns it
   * (nothing changes). Fail closed: an unreadable owner is a conflict.
   */
  linkSpotifyAccount(driverId: string, spotifyUserId: string): Promise<"linked" | "conflict">;
  /** The driver a Spotify account is linked to, or null. */
  getLinkedDriver(spotifyUserId: string): Promise<string | null>;
  /** Creates a single-use OAuth state bound to `driverId` (TTL 600 s) and returns the raw state (only its sha256 is stored). */
  createOAuthState(driverId: string): Promise<string>;
  /** Atomic and single use (GETDEL). The driverId of the SERVER record, or null when unknown, used, expired or malformed. */
  consumeOAuthState(state: string): Promise<string | null>;
  /** Owner script: deletes the Spotify blob, the account link and the saved addresses of the driver. Idempotent. */
  purgeDriverData(driverId: string): Promise<void>;
}

import { createHash, randomBytes } from "node:crypto";

const DRIVER_ID_RE = /^drv_[A-Za-z0-9_-]{22}$/;
const PREFIX_RE = /^finn:[A-Za-z0-9_-]+:$/;

const SPOTIFY_USER_ID_RE = /^[a-z0-9._-]{1,100}$/;
/** Lowercase only: callers normalize (`toLowerCase`) so one account has one key. */
export function isValidSpotifyUserId(id: unknown): id is string {
  return typeof id === "string" && SPOTIFY_USER_ID_RE.test(id);
}

export function isValidDriverId(id: unknown): id is string {
  return typeof id === "string" && DRIVER_ID_RE.test(id);
}

/** `finn:<env>:`. Dev, preview and prod share one Redis, so the prefix is mandatory. */
export function keyPrefix(env: string): string {
  const prefix = `finn:${env}:`;
  assertPrefix(prefix);
  return prefix;
}

export function assertPrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) throw new Error("Invalid key prefix");
}

const RATE_KEY_RE = /^ratelimit:[A-Za-z0-9:._-]{1,100}$/;

export const keys = {
  driver: (prefix: string, driverId: string) => `${prefix}driver:${driverId}`,
  invite: (prefix: string, codeHash: string) => `${prefix}invite:${codeHash}`,
  /** Set of every driverId (fed by createDriver and, inside the same EVAL, by the invite redeem). */
  driversIndex: (prefix: string) => `${prefix}drivers`,
  spotifyIndex: (prefix: string, spotifyUserId: string) => {
    if (!isValidSpotifyUserId(spotifyUserId)) throw new Error("Invalid spotifyUserId");
    return `${prefix}spotify-index:${spotifyUserId}`;
  },
  /** Reverse pointer driverId -> the spotifyUserId it is linked to (so purge/revoke/DELETE find the index entry). */
  spotifyAccount: (prefix: string, driverId: string) => {
    if (!isValidDriverId(driverId)) throw new Error("Invalid driverId");
    return `${prefix}spotify-account:${driverId}`;
  },
  /** Saved addresses of ONE driver: hash { casa, trabalho }. The id is validated: no free-form key. */
  driverAddr: (prefix: string, driverId: string) => {
    if (!isValidDriverId(driverId)) throw new Error("Invalid driverId");
    return `${prefix}driver-addr:${driverId}`;
  },
  /** Encrypted refresh token of ONE driver. Also the AAD of the cipher: `finn:<env>:spotify:<driverId>`. */
  spotifyToken: (prefix: string, driverId: string) => {
    if (!isValidDriverId(driverId)) throw new Error("Invalid driverId");
    return `${prefix}spotify:${driverId}`;
  },
  /** OAuth state record, keyed by sha256(state): the raw state is never stored. */
  oauthState: (prefix: string, stateHash: string) => {
    if (!/^[0-9a-f]{64}$/.test(stateHash)) throw new Error("Invalid state hash");
    return `${prefix}oauth-state:${stateHash}`;
  },
  /** Only `ratelimit:`-prefixed keys with a restricted charset are accepted. */
  rateLimit: (prefix: string, key: string) => {
    if (typeof key !== "string" || !RATE_KEY_RE.test(key)) throw new Error("Invalid rate limit key");
    return `${prefix}${key}`;
  },
};

/** Generic error for any Redis failure. Never carries SDK message, cause, command, key or token. */
export class DriverStoreUnavailableError extends Error {
  constructor() {
    super("Driver store unavailable");
    this.name = "DriverStoreUnavailableError";
  }
}

export const MAX_INVITE_USES = 1000;
export const MAX_INVITE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** 25 h: the per-day AI counters (src/lib/ai-limits.ts) use 90000 s so the day turnover does not depend on the exact clock. */
export const MAX_RATE_WINDOW_SECONDS = 90_000;

// Control chars (C0, DEL, C1), which also covers NUL, newline and the ESC of ANSI sequences.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Trims and validates a label (1..64 chars, no control characters). Returns the trimmed label. */
export function normalizeLabel(label: string): string {
  if (typeof label !== "string") throw new Error("Invalid label");
  const t = label.trim();
  if (t.length < 1 || t.length > 64 || CONTROL_RE.test(t)) throw new Error("Invalid label");
  return t;
}

/**
 * `expiresAt` is epoch MILLISECONDS, in the future and at most 1 year ahead.
 * `maxUses` is an integer 1..1000.
 */
export function validateInviteInput(
  input: { label: string; maxUses: number; expiresAt: number },
  nowMs: number,
): { label: string; maxUses: number; expiresAt: number } {
  const label = normalizeLabel(input.label);
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > MAX_INVITE_USES) {
    throw new Error("Invalid maxUses");
  }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= nowMs || input.expiresAt > nowMs + MAX_INVITE_LIFETIME_MS) {
    throw new Error("Invalid expiresAt (epoch milliseconds, in the future, at most 1 year)");
  }
  return { label, maxUses: input.maxUses, expiresAt: input.expiresAt };
}

export function validateWindowSeconds(w: number): void {
  if (!Number.isInteger(w) || w < 1 || w > MAX_RATE_WINDOW_SECONDS) throw new Error("Invalid windowSeconds");
}

export const OAUTH_STATE_TTL_SECONDS = 600;
const OAUTH_STATE_RE = /^[A-Za-z0-9_-]{43}$/;
/** v1.<iv 12 bytes>.<ciphertext>.<GCM tag 16 bytes>, base64url. The only shape the store accepts for a token. */
const SPOTIFY_BLOB_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{2,2048}\.[A-Za-z0-9_-]{22}$/;

/** 32 random bytes, base64url (43 chars). */
export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** Null when the shape is wrong (never touches Redis for it). */
export function oauthStateHash(state: unknown): string | null {
  if (typeof state !== "string" || !OAUTH_STATE_RE.test(state)) return null;
  return createHash("sha256").update(state).digest("hex");
}

/** Throws unless `blob` looks like an encrypted v1 blob. Defense in depth: plaintext can never be stored. */
export function assertSpotifyBlob(blob: unknown): asserts blob is string {
  if (typeof blob !== "string" || !SPOTIFY_BLOB_RE.test(blob)) throw new Error("Invalid token blob");
}

/** Parses the state record; null when corrupt or older than the TTL (defense if the key lost its TTL). */
export function parseOAuthStateRecord(raw: unknown, nowMs: number): string | null {
  if (typeof raw !== "string") return null;
  try {
    const rec = JSON.parse(raw) as { driverId?: unknown; createdAt?: unknown };
    if (!rec || typeof rec !== "object" || !isValidDriverId(rec.driverId)) return null;
    if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) return null;
    if (nowMs - rec.createdAt > OAUTH_STATE_TTL_SECONDS * 1000) return null;
    return rec.driverId;
  } catch {
    return null;
  }
}
