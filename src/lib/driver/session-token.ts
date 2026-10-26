import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "../env";
import { isValidDriverId, type Driver, type DriverStore } from "./store";

export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
  tv: number;
}

/** Required in every environment; too-short secrets are rejected (fail closed). */
export function getSessionSecret(): string {
  const secret = requireEnv("FINN_SESSION_SECRET");
  if (secret.length < MIN_SECRET_LENGTH) throw new Error("FINN_SESSION_SECRET is too short");
  return secret;
}

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error("Invalid session secret");
  }
}

export function signSessionToken(
  input: { driverId: string; tokenVersion: number },
  secret: string,
  nowMs: number = Date.now(),
): string {
  assertSecret(secret);
  if (!isValidDriverId(input.driverId)) throw new Error("Invalid driverId");
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

  const given = Buffer.from(sigB64, "base64url");
  const expected = sign(`v1.${body}`, secret);
  // timingSafeEqual throws on length mismatch, so check size first.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let p: unknown;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p !== "object" || p === null) return null;
  const { sub, iat, exp, tv } = p as Record<string, unknown>;
  if (!isValidDriverId(sub) || !Number.isInteger(iat) || !Number.isInteger(exp) || !Number.isInteger(tv)) return null;
  if ((exp as number) <= Math.floor(nowMs / 1000)) return null;
  return { sub, iat: iat as number, exp: exp as number, tv: tv as number };
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
  if (!driver || driver.status !== "active" || driver.tokenVersion !== payload.tv) return null;
  return driver;
}
