import { createHash, randomBytes, randomInt } from "node:crypto";
import { isIP } from "node:net";
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
/** Missing/unparseable IPs share one small bucket (own key, never attacker text). */
export const REDEEM_RATE_LIMIT_NO_IP = { max: 3, windowSeconds: 600 } as const;

/** Expands an IPv6 literal into 8 hextets; null if malformed. */
function expandIpv6(ip: string): number[] | null {
  let s = ip;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

/**
 * Normalized rate-limit identity for a client IP.
 * - IPv4: the address. IPv4-mapped IPv6 (::ffff:a.b.c.d): the embedded IPv4.
 * - IPv6: the /64 prefix (the first 4 hextets), since one host controls a whole /64.
 * - Missing, empty or unparseable: the fixed "noip" bucket (never uses raw input in the key).
 * Callers must pass an IP from a trusted platform source, not a client-controlled header.
 */
export function normalizeIpForRateLimit(ip: string | null | undefined): { id: string; known: boolean } {
  const noip = { id: "noip", known: false };
  if (typeof ip !== "string") return noip;
  const raw = ip.trim().split("%")[0];
  const kind = isIP(raw);
  if (kind === 4) return { id: raw, known: true };
  if (kind !== 6) return noip;
  const h = expandIpv6(raw);
  if (!h) return noip;
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) {
    return { id: `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`, known: true };
  }
  return { id: `v6-${h.slice(0, 4).map((n) => n.toString(16)).join("-")}`, known: true };
}

export function redeemRateLimitKey(ip: string | null | undefined): string {
  return `ratelimit:redeem:${normalizeIpForRateLimit(ip).id}`;
}

/** True when the caller is still within the redeem budget. Fail closed: store errors propagate. */
export async function checkRedeemRateLimit(
  store: DriverStore,
  ip: string | null | undefined,
  limit?: { max: number; windowSeconds: number },
): Promise<boolean> {
  const { known } = normalizeIpForRateLimit(ip);
  const l = limit ?? (known ? REDEEM_RATE_LIMIT : REDEEM_RATE_LIMIT_NO_IP);
  const n = await store.incrementRateLimit(redeemRateLimitKey(ip), l.windowSeconds);
  return n <= l.max;
}
