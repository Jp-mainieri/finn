import { createHash, timingSafeEqual } from "node:crypto";
import { authenticateSession, getDriverStore, isAcceptableSecret, getSessionSecret, type DriverStore } from "@/lib/driver";

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
 * Auth for the A2A endpoint /api/agents/[agent] (POST): `Authorization: Bearer <FINN_A2A_TOKEN>`.
 * A secret of its own: FINN_API_TOKEN is never accepted here. Returns an error Response, or null when authorized.
 * Secret format: same rule as FINN_SESSION_SECRET (isAcceptableSecret: 64 hex, >= 8 distinct chars), and it must
 * differ from FINN_API_TOKEN. Off (503, fail closed) when FINN_A2A_TOKEN is absent, empty, whitespace-only, invalid
 * or equal to FINN_API_TOKEN; 503 and not 401 because
 * it is a server state, not a client credential error. Missing or wrong Bearer: 401 + WWW-Authenticate.
 * Never logs values.
 */
export function authorizeA2A(request: Request): Response | null {
  const expected = process.env.FINN_A2A_TOKEN?.trim();
  if (!expected || !isAcceptableSecret(expected)) return a2aDisabled();
  const api = process.env.FINN_API_TOKEN?.trim();
  if (api && digestEquals(api, expected)) return a2aDisabled();
  const token = extractBearer(request);
  if (!token || !digestEquals(token, expected)) return UNAUTHORIZED();
  return null;
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
