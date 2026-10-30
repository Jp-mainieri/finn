import { createHash, timingSafeEqual } from "node:crypto";
import { authenticateSession, getDriverStore, getSessionSecret, type DriverStore } from "@/lib/driver";

/**
 * Simple shared-secret auth for personal use: `Authorization: Bearer <FINN_API_TOKEN>`.
 * Returns an error Response when the request is not authorized, null otherwise.
 * Fails closed when the token is not configured.
 */
export function authorize(request: Request): Response | null {
  const expected = process.env.FINN_API_TOKEN?.trim();
  if (!expected) {
    console.error("[auth] FINN_API_TOKEN is not set; rejecting request");
    return Response.json({ error: "Server auth not configured" }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const token = (header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "").trim();
  const given = Buffer.from(token);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
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
  // Compare fixed-size digests so neither content nor length of FINN_API_TOKEN leaks through timing.
  const given = createHash("sha256").update(token).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(given, wanted);
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
