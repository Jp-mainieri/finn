import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "../env";
import { isValidDriverId, type Driver, type DriverStore } from "./store";

export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
/** How far in the future an `iat` may be (clock skew tolerance). */
export const IAT_SKEW_SECONDS = 60;

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  tv: number;
}

/**
 * Secret rule: exactly 64 hex characters (32 bytes, `openssl rand -hex 32`, as the
 * contract says) with at least 8 distinct characters (rejects "aaaa..." / patterns).
 */
export function isAcceptableSecret(secret: unknown): secret is string {
  return typeof secret === "string" && /^[0-9a-fA-F]{64}$/.test(secret) && new Set(secret.toLowerCase()).size >= 8;
}

/** Required in every environment; weak secrets are rejected (fail closed). */
export function getSessionSecret(): string {
  const secret = requireEnv("FINN_SESSION_SECRET");
  if (!isAcceptableSecret(secret)) throw new Error("FINN_SESSION_SECRET is invalid (expected 64 hex characters, random)");
  return secret;
}

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function assertSecret(secret: string): void {
  if (!isAcceptableSecret(secret)) throw new Error("Invalid session secret");
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Decodes only canonical base64url: the re-encoded bytes must equal the input exactly. */
function decodeCanonical(s: string): Buffer | null {
  if (!B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

export function signSessionToken(
  input: { driverId: string; tokenVersion: number },
  secret: string,
  nowMs: number = Date.now(),
): string {
  assertSecret(secret);
  if (!isValidDriverId(input.driverId)) throw new Error("Invalid driverId");
  if (!Number.isSafeInteger(input.tokenVersion) || input.tokenVersion < 0) throw new Error("Invalid tokenVersion");
  if (!Number.isFinite(nowMs)) throw new Error("Invalid clock");
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = { sub: input.driverId, iat, exp: iat + SESSION_TTL_SECONDS, tv: input.tokenVersion };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const head = `v1.${body}`;
  return `${head}.${sign(head, secret).toString("base64url")}`;
}

/** Signature + expiry only. Returns null on any problem; never throws on bad token input. */
export function verifySessionToken(token: string, secret: string, nowMs: number = Date.now()): SessionPayload | null {
  assertSecret(secret);
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sigB64] = parts;

  const given = decodeCanonical(sigB64);
  const bodyBytes = decodeCanonical(body);
  if (!given || !bodyBytes) return null;
  const expected = sign(`v1.${body}`, secret);
  // timingSafeEqual throws on length mismatch, so check size first.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let p: unknown;
  try {
    p = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p !== "object" || p === null) return null;
  const { sub, iat, exp, tv } = p as Record<string, unknown>;
  if (!isValidDriverId(sub)) return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || !Number.isSafeInteger(tv)) return null;
  const iatN = iat as number;
  const expN = exp as number;
  const tvN = tv as number;
  if (tvN < 0 || iatN < 0) return null;
  if (expN > iatN + SESSION_TTL_SECONDS) return null;
  const nowS = Math.floor(nowMs / 1000);
  if (iatN > nowS + IAT_SKEW_SECONDS) return null;
  if (expN <= nowS) return null;
  return { sub, iat: iatN, exp: expN, tv: tvN };
}

/** Full per-request validation: token, then one store read (active and tv match). */
export async function authenticateSession(
  token: string,
  store: DriverStore,
  secret: string,
  nowMs: number = Date.now(),
): Promise<Driver | null> {
  const payload = verifySessionToken(token, secret, nowMs);
  if (!payload) return null;
  const driver = await store.getDriver(payload.sub);
  if (!driver || driver.driverId !== payload.sub || driver.status !== "active" || driver.tokenVersion !== payload.tv) return null;
  return driver;
}
