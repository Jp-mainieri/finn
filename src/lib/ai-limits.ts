/**
 * Per-driver limits for the paid AI routes (docs/contratos/limites-por-motorista.md, M3).
 *
 * Two ceilings per route and per driver, both server side, both keyed by the driverId PROVEN by
 * `authorizeDriver` (never body, header, cookie or contextId):
 * - burst: in-memory fixed 60 s window per instance (best-effort anti-loop, no Redis, no timers);
 * - day: Redis counter (`incrementRateLimit`), one window per calendar day in America/Sao_Paulo (the cost guarantee).
 *
 * To change a ceiling, edit AI_LIMITS below (a PR; there are no environment variables on purpose).
 * Nothing here logs a driverId, a key or a count: a stalled request only logs the route class and the scope.
 */
import { isOwner } from "@/lib/auth";
import { DriverStoreUnavailableError, getDriverStore, isValidDriverId, type DriverStore } from "@/lib/driver";

export type AiClass = "stt" | "orchestrator" | "tts" | "live" | "a2a";

/** burst = requests per BURST_WINDOW_SECONDS (per instance); day = requests per calendar day (Redis). */
export const AI_LIMITS: Readonly<Record<AiClass, { readonly burst: number; readonly day: number }>> = {
  stt: { burst: 20, day: 600 },
  orchestrator: { burst: 20, day: 600 },
  tts: { burst: 20, day: 600 },
  live: { burst: 5, day: 30 },
  /** POST /api/agents/[agent]: runs as the owner, same ceilings as the orchestrator it mirrors. */
  a2a: { burst: 20, day: 600 },
};

export const BURST_WINDOW_SECONDS = 60;
/** 25 h: covers the day turnover without depending on the exact clock. */
export const DAY_KEY_TTL_SECONDS = 90000;
export const BURST_MAX_ENTRIES = 1000;
export const AI_LIMIT_TIME_ZONE = "America/Sao_Paulo";

type Scope = "burst" | "day";
type Clock = () => number;

let clock: Clock = Date.now;
const burst = new Map<string, { count: number; resetAt: number }>();

/** Test hook: replaces the clock (undefined restores Date.now) and empties the burst map. */
export function resetAiLimitsForTests(now?: Clock): void {
  clock = now ?? Date.now;
  burst.clear();
  lastWarn.clear();
}

/** Test hook: size of the in-memory burst map. */
export function burstEntryCountForTests(): number {
  return burst.size;
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: AI_LIMIT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Local calendar day (AAAAMMDD) and seconds left until the next local midnight, at `nowMs`. */
export function saoPauloDay(nowMs: number): { day: string; secondsToMidnight: number } {
  const parts: Record<string, string> = {};
  for (const p of dayFormat.formatToParts(new Date(nowMs))) parts[p.type] = p.value;
  const elapsed = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const msIntoSecond = ((nowMs % 1000) + 1000) % 1000;
  const remaining = Math.ceil(86400 - elapsed - msIntoSecond / 1000);
  return { day: `${parts.year}${parts.month}${parts.day}`, secondsToMidnight: Math.min(86400, Math.max(1, remaining)) };
}

const CLASS_RE = /^[a-z0-9]{1,20}$/;

/** `ratelimit:ai:<class>:<AAAAMMDD>:<driverId>`; throws on anything that would not be a clean key. */
export function aiDayKey(cls: string, day: string, driverId: string): string {
  if (!CLASS_RE.test(cls) || !Object.hasOwn(AI_LIMITS, cls) || !/^\d{8}$/.test(day) || !isValidDriverId(driverId)) {
    throw new Error("Invalid rate limit key part");
  }
  return `ratelimit:ai:${cls}:${day}:${driverId}`;
}

function sweepExpired(now: number): void {
  for (const [key, entry] of burst) if (entry.resetAt <= now) burst.delete(key);
}

/** Counts this request in the burst window; true when it is over the burst ceiling. */
function burstHit(cls: AiClass, driverId: string, now: number): { over: boolean; retryAfter: number } {
  const key = `${driverId}:${cls}`;
  let entry = burst.get(key);
  if (!entry || entry.resetAt <= now) {
    burst.delete(key); // a renewed window goes to the end: the Map iterates oldest first
    if (burst.size >= BURST_MAX_ENTRIES) {
      sweepExpired(now);
      while (burst.size >= BURST_MAX_ENTRIES) {
        const oldest = burst.keys().next();
        if (oldest.done) break;
        burst.delete(oldest.value);
      }
    }
    entry = { count: 0, resetAt: now + BURST_WINDOW_SECONDS * 1000 };
    burst.set(key, entry);
  }
  entry.count += 1;
  return {
    over: entry.count > AI_LIMITS[cls].burst,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

/** Last warning per class+scope (at most 5 x 3 entries), so a client in a loop writes one log line a minute, not one per request. */
const lastWarn = new Map<string, number>();
const WARN_EVERY_MS = 60_000;

function warnOnce(cls: string, what: string): void {
  const now = clock();
  const key = `${cls}:${what}`;
  const last = lastWarn.get(key);
  if (last !== undefined && now - last >= 0 && now - last < WARN_EVERY_MS) return;
  lastWarn.set(key, now);
  console.warn(`[ai-limit] ${cls} ${what}`);
}

function tooMany(cls: AiClass, scope: Scope, retryAfter: number): Response {
  warnOnce(cls, `over ${scope} limit`);
  return Response.json(
    { error: "Too many requests", scope },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
  );
}

const unavailable = () =>
  Response.json(
    { error: "O Finn está indisponível agora. Tente de novo em instantes." },
    { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } },
  );

/**
 * The single gate of the four AI routes. Burst is checked first and, when over, answers 429 without touching Redis; only requests it lets through count for the day. Call it right after `authorizeDriver` (and, for `live`, after the
 * ENABLE_GPT_LIVE check), BEFORE reading the body or calling any paid service. Returns an error Response
 * (429 or 503) or null when the request may proceed. Every call counts, including requests that turn out malformed.
 * `ownerFailsOpen: false` (the A2A route) turns the owner's fail-open off. Day counter down: a driver gets 503 (fail closed), the owner passes (fail open, day ceiling only; burst still applies).
 */
export async function enforceAiLimit(cls: AiClass, driverId: string, deps: { store?: DriverStore; ownerFailsOpen?: boolean } = {}): Promise<Response | null> {
  const now = clock();
  const { day, secondsToMidnight } = saoPauloDay(now);

  let key: string;
  try {
    key = aiDayKey(cls, day, driverId);
  } catch {
    return unavailable(); // never turn a bad id or class into a key: nothing is counted, nothing is called
  }

  // Burst first: a request it stops never reaches Redis (no command spent, no day quota used).
  const b = burstHit(cls, driverId, now);
  if (b.over) return tooMany(cls, "burst", b.retryAfter);

  let dayCount: number | null;
  try {
    dayCount = await (deps.store ?? getDriverStore()).incrementRateLimit(key, DAY_KEY_TTL_SECONDS);
  } catch (err) {
    // Fail open only for the owner AND only when the store itself reported "unavailable"; any other error
    // (misconfiguration, a bug) is a 503 for everyone.
    if (deps.ownerFailsOpen === false || !(err instanceof DriverStoreUnavailableError) || !isOwner(driverId)) return unavailable();
    warnOnce(cls, "day counter unavailable");
    dayCount = null;
  }

  if (dayCount !== null && dayCount > AI_LIMITS[cls].day) return tooMany(cls, "day", secondsToMidnight);
  return null;
}
