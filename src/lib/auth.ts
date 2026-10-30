import { createHash, timingSafeEqual } from "node:crypto";
import { getClientIp } from "@/lib/client-ip";
import {
  authenticateSession,
  getDriverStore,
  getSessionSecret,
  isAcceptableSecret,
  normalizeIpForRateLimit,
  type DriverStore,
} from "@/lib/driver";

/** Fixed-size digest compare: neither content nor length of the secret leaks through timing. */
function digestEquals(given: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

let a2aDisabledLogged = false;

/** One value-free diagnostic line per process; does not distinguish the exact reason. */
function a2aDisabled(): Response {
  if (!a2aDisabledLogged) {
    a2aDisabledLogged = true;
    console.error("[a2a] disabled: FINN_A2A_TOKEN missing or invalid");
  }
  return Response.json({ error: "A2A endpoint disabled" }, { status: 503 });
}

/** Test hook: re-arms the once-per-process log line. */
export function resetA2ADisabledLogForTests(): void {
  a2aDisabledLogged = false;
}

/**
 * Valid A2A secrets in effect, or null when the endpoint is OFF (fail closed).
 * FINN_A2A_TOKEN is required; FINN_A2A_TOKEN_NEXT is optional and only exists during a rotation.
 * Each present value must be acceptable (isAcceptableSecret: 64 hex, >= 8 distinct chars), they must
 * differ from each other and from FINN_API_TOKEN. Any invalid or equal value turns the whole endpoint
 * off (503), never "ignore the bad one". Empty or whitespace-only NEXT counts as absent.
 */
function a2aSecrets(): string[] | null {
  const current = process.env.FINN_A2A_TOKEN?.trim();
  if (!current || !isAcceptableSecret(current)) return null;
  const secrets = [current];
  const next = process.env.FINN_A2A_TOKEN_NEXT?.trim();
  if (next) {
    // Hex is case-insensitive in intent: "AB.." and "ab.." are the same secret.
    if (!isAcceptableSecret(next) || digestEquals(next.toLowerCase(), current.toLowerCase())) return null;
    secrets.push(next);
  }
  const api = process.env.FINN_API_TOKEN?.trim();
  if (api && secrets.some((secret) => digestEquals(api.toLowerCase(), secret.toLowerCase()))) return null;
  return secrets;
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function a2aBearerMatches(request: Request, secrets: string[]): boolean {
  const token = extractBearer(request);
  if (!token) return false;
  // Compare against every secret (no early exit) so the number of matches does not show in timing.
  let ok = false;
  for (const secret of secrets) ok = digestEquals(token, secret) || ok;
  return ok;
}

/**
 * Secret check only (no rate limit) for the A2A endpoint /api/agents/[agent] (POST):
 * `Authorization: Bearer <FINN_A2A_TOKEN>` or, during a rotation, `<FINN_A2A_TOKEN_NEXT>`.
 * A secret of its own: FINN_API_TOKEN is never accepted here. FINN_A2A_TOKEN is the OWNER's credential.
 * Returns an error Response, or null when authorized. Off (503, fail closed) when the configuration is
 * missing or invalid (see a2aSecrets); 503 and not 401 because it is a server state, not a client
 * credential error. Missing or wrong Bearer: 401 + WWW-Authenticate. Never logs values.
 * The route uses `guardA2A`, which adds the failure rate limit around this check.
 */
export function authorizeA2A(request: Request): Response | null {
  const secrets = a2aSecrets();
  if (!secrets) return a2aDisabled();
  return a2aBearerMatches(request, secrets) ? null : UNAUTHORIZED();
}

/** Failed A2A attempts allowed per window, per client IP (and per bucket when the IP is unknown). */
export const A2A_RATE_LIMIT = { max: 10, windowSeconds: 600 } as const;
export const A2A_RATE_LIMIT_NO_IP = { max: 3, windowSeconds: 600 } as const;

const tooManyA2A = (windowSeconds: number) =>
  Response.json(
    { error: "Too many attempts" },
    { status: 429, headers: { "Retry-After": String(windowSeconds), "Cache-Control": "no-store" } },
  );

/**
 * A2A gate: failure rate limit in Redis BEFORE the Bearer is compared, then the same secret rules as `authorizeA2A`.
 * Key `ratelimit:a2a:<ip>` (unknown or invalid IP shares the `noip` bucket, with a lower limit).
 * Only FAILED attempts count, but the lock-out is per IP and applies to everyone behind it: once an IP has
 * used up its failures, even the right secret gets 429 until the window ends. A missing Bearer, or one that is
 * not 64 hex, is a plain 401 that never touches Redis (and is not counted: it cannot be a guess). Disabled configuration answers 503 first, without touching Redis.
 * Redis down is 503 (A2A is external, there is no voice to speak to). Parallel requests can overshoot the
 * limit by their own concurrency (peek then increment is not atomic). Never logs values.
 */
export async function guardA2A(
  request: Request,
  deps: { store?: DriverStore; limit?: { max: number; windowSeconds: number }; limitNoIp?: { max: number; windowSeconds: number } } = {},
): Promise<Response | null> {
  const secrets = a2aSecrets();
  if (!secrets) return a2aDisabled();

  const bearer = extractBearer(request);
  if (!bearer || !HEX64_RE.test(bearer)) return UNAUTHORIZED();

  const { id, known } = normalizeIpForRateLimit(getClientIp(request));
  const limit = known ? (deps.limit ?? A2A_RATE_LIMIT) : (deps.limitNoIp ?? A2A_RATE_LIMIT_NO_IP);
  const key = `ratelimit:a2a:${id}`;

  let store: DriverStore;
  try {
    store = deps.store ?? getDriverStore();
    if ((await store.peekRateLimit(key)) >= limit.max) return tooManyA2A(limit.windowSeconds);
  } catch {
    return unavailableResponse();
  }

  if (a2aBearerMatches(request, secrets)) return null;
  try {
    await store.incrementRateLimit(key, limit.windowSeconds);
  } catch {
    return unavailableResponse();
  }
  return UNAUTHORIZED();
}

/**
 * driverId of the owner for the legacy shared token (FINN_API_TOKEN) while
 * FINN_LEGACY_TOKEN_ENABLED=1. Format: `drv_` + 22 base64url chars (same as isValidDriverId).
 * Fixed, not a real store entry: it has no record in the DriverStore.
 */
export const LEGACY_OWNER_DRIVER_ID = "drv_legacy_owner_000000000";

const UNAUTHORIZED = () =>
  Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/** Short, speakable, no technical detail. */
export const unavailableResponse = () =>
  Response.json({ error: "O Finn está indisponível agora. Tente de novo em instantes." }, { status: 503, headers: { "Retry-After": "5" } });

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function legacyMatches(token: string): boolean {
  // Only the exact value "1" enables it; absent, empty, "true", "0", " 1" stay off.
  if (process.env.FINN_LEGACY_TOKEN_ENABLED !== "1") return false;
  const expected = process.env.FINN_API_TOKEN?.trim();
  if (!expected) return false;
  return digestEquals(token, expected);
}

/**
 * Per-driver auth for /api/orchestrator and /api/realtime/*. Returns `{ driverId }` or an
 * error Response. Session tokens (`v1.`) are verified (signature, exp) and checked against
 * the store (active, tv). Anything else is tried only as the legacy token, and only when
 * FINN_LEGACY_TOKEN_ENABLED === "1". All token failures give the same 401; store or
 * configuration failures give a short 503. Nothing is logged.
 */
export async function authorizeDriver(
  request: Request,
  deps: { store?: DriverStore; now?: () => number } = {},
): Promise<{ driverId: string } | Response> {
  const token = extractBearer(request);
  if (!token) return UNAUTHORIZED();

  if (!token.startsWith("v1.")) {
    return legacyMatches(token) ? { driverId: LEGACY_OWNER_DRIVER_ID } : UNAUTHORIZED();
  }

  try {
    const store = deps.store ?? getDriverStore();
    const driver = await authenticateSession(token, store, getSessionSecret(), (deps.now ?? Date.now)());
    return driver ? { driverId: driver.driverId } : UNAUTHORIZED();
  } catch {
    // DriverStoreUnavailableError, missing/invalid secret, store misconfiguration: fail closed.
    return unavailableResponse();
  }
}
