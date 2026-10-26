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
  createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }>;
  /** Atomic. Null when invalid, exhausted, expired, revoked or unknown (indistinguishable). */
  redeemInvite(code: string): Promise<Driver | null>;
  revokeInvite(code: string): Promise<void>;
  /** Increments a counter scoped by `key` and returns the new value; TTL set on first hit of the window. */
  incrementRateLimit(key: string, windowSeconds: number): Promise<number>;
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

export const keys = {
  driver: (prefix: string, driverId: string) => `${prefix}driver:${driverId}`,
  invite: (prefix: string, codeHash: string) => `${prefix}invite:${codeHash}`,
  spotifyIndex: (prefix: string, spotifyUserId: string) => `${prefix}spotify-index:${spotifyUserId}`,
  rateLimit: (prefix: string, key: string) => `${prefix}${key}`,
};

export function validateInviteInput(input: { label: string; maxUses: number; expiresAt: number }): void {
  if (typeof input.label !== "string" || input.label.length === 0 || input.label.length > 80) {
    throw new Error("Invalid invite label");
  }
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1) throw new Error("Invalid maxUses");
  if (!Number.isFinite(input.expiresAt)) throw new Error("Invalid expiresAt");
}

export function validateLabel(label: string): void {
  if (typeof label !== "string" || label.length === 0 || label.length > 80) {
    throw new Error("Invalid driver label");
  }
}
