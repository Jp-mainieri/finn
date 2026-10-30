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
}

const DRIVER_ID_RE = /^drv_[A-Za-z0-9_-]{22}$/;
const PREFIX_RE = /^finn:[A-Za-z0-9_-]+:$/;

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
  spotifyIndex: (prefix: string, spotifyUserId: string) => `${prefix}spotify-index:${spotifyUserId}`,
  /** Saved addresses of ONE driver: hash { casa, trabalho }. The id is validated: no free-form key. */
  driverAddr: (prefix: string, driverId: string) => {
    if (!isValidDriverId(driverId)) throw new Error("Invalid driverId");
    return `${prefix}driver-addr:${driverId}`;
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
export const MAX_RATE_WINDOW_SECONDS = 86_400;

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
