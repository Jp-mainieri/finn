import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DriverStore } from "./store";

// No 0/O/1/I/L to avoid ambiguity when read aloud or typed.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^FINN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

function chunk(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function generateInviteCode(): string {
  return `FINN-${chunk()}-${chunk()}`;
}

export function generateDriverId(): string {
  return `drv_${randomBytes(16).toString("base64url")}`;
}

/** Uppercases/trims; returns null if the shape is not a valid invite code. */
export function normalizeInviteCode(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function hashInviteCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode).digest("hex");
}

export const REDEEM_RATE_LIMIT = { max: 10, windowSeconds: 600 } as const;

export function redeemRateLimitKey(ip: string): string {
  return `ratelimit:redeem:${String(ip).slice(0, 64)}`;
}

/** True when the caller is still within the redeem budget. Fail closed: store errors propagate. */
export async function checkRedeemRateLimit(
  store: DriverStore,
  ip: string,
  limit: { max: number; windowSeconds: number } = REDEEM_RATE_LIMIT,
): Promise<boolean> {
  const n = await store.incrementRateLimit(redeemRateLimitKey(ip), limit.windowSeconds);
  return n <= limit.max;
}
