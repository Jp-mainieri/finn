/**
 * M3: per-driver limits on the four paid AI routes (docs/contratos/limites-por-motorista.md).
 * Real routes + real auth + real limiter. Fake in-memory store (with a switch to "Redis down"), injected clock,
 * stubbed fetch and stubbed orchestrate: no network, no paid service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestOwner, TEST_OWNER_ID } from "../helpers/owner";
import {
  AI_LIMITS,
  aiDayKey,
  burstEntryCountForTests,
  BURST_MAX_ENTRIES,
  enforceAiLimit,
  resetAiLimitsForTests,
  saoPauloDay,
  type AiClass,
} from "@/lib/ai-limits";
import {
  DriverStoreUnavailableError,
  keyPrefix,
  keys,
  MemoryDriverStore,
  setDriverStoreForTests,
  signSessionToken,
} from "@/lib/driver";

const orchestrateMock = vi.hoisted(() => vi.fn());
vi.mock("@/orchestrator/orchestrate", () => ({ orchestrate: orchestrateMock }));

const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const LEGACY = "legacy-s3cret-for-ai-limits";
/** 12:00 in Sao Paulo (UTC-3), 2026-10-28. */
const T0 = Date.UTC(2026, 9, 28, 15, 0, 0);

class SpyStore extends MemoryDriverStore {
  incs: string[] = [];
  windows: number[] = [];
  down: Error | null = null;
  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    this.incs.push(key);
    this.windows.push(windowSeconds);
    if (this.down) throw this.down;
    return super.incrementRateLimit(key, windowSeconds);
  }
}

const routes = {
  orchestrator: () => import("@/app/api/orchestrator/route"),
  stt: () => import("@/app/api/realtime/transcribe/route"),
  tts: () => import("@/app/api/realtime/tts/route"),
  live: () => import("@/app/api/realtime/session/route"),
};
type Name = keyof typeof routes;
const NAMES = Object.keys(routes) as Name[];
const PATH: Record<Name, string> = {
  orchestrator: "/api/orchestrator",
  stt: "/api/realtime/transcribe",
  tts: "/api/realtime/tts",
  live: "/api/realtime/session",
};
const VALID: Record<Name, unknown> = {
  orchestrator: { transcript: "toca rock" },
  stt: { audio: Buffer.from("abc").toString("base64"), mimeType: "audio/webm" },
  tts: { text: "oi" },
  live: { sdp: "v=0" },
};

let t = T0;
let store: SpyStore;
let fetchMock: ReturnType<typeof vi.fn>;
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

const serviceCalls = () => orchestrateMock.mock.calls.length + fetchMock.mock.calls.length;

async function newDriver(label = "m") {
  const d = await store.createDriver({ label });
  return { id: d.driverId, token: signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SECRET) };
}

interface CallOpts {
  token?: string | null;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}
async function call(name: Name, token: string | null, opts: CallOpts = {}) {
  const { POST } = await routes[name]();
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  return POST(
    new Request(`http://x${PATH[name]}`, {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(opts.body ?? VALID[name]),
    }),
  );
}
const bad400 = (name: Name, token: string) => call(name, token, { raw: "{" });

function expand(v: unknown, seen = new Set<unknown>()): string {
  if (v instanceof Error) {
    if (seen.has(v)) return "";
    seen.add(v);
    return [v.name, v.message, v.stack ?? "", expand(v.cause, seen)].join("\n");
  }
  if (v && typeof v === "object") return Object.values(v).map((x) => expand(x, seen)).join("\n");
  return String(v);
}
const loggedText = () => consoleSpies.flatMap((s) => s.mock.calls.flat()).map((v) => expand(v)).join("\n");

beforeEach(() => {
  t = T0;
  store = registerTestOwner(new SpyStore(keyPrefix("development"), () => t));
  setDriverStoreForTests(store);
  resetAiLimitsForTests(() => t);
  orchestrateMock.mockReset();
  orchestrateMock.mockResolvedValue({ contextId: "c", status: "completed", speech: "ok", clientActions: [] });
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/live/sessions")) {
      return Response.json({ session: { id: "s1" }, transport: { sdp: "answer" } });
    }
    if (String(url).includes("transcriptions")) return Response.json({ text: "oi" });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FINN_SESSION_SECRET", SECRET);
  vi.stubEnv("FINN_API_TOKEN", LEGACY);
  vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
  vi.stubEnv("ENABLE_GPT_LIVE", "1");
  vi.stubEnv("GROQ_API_KEY", "fake-groq");
  vi.stubEnv("OPENAI_API_KEY", "fake-openai");
  vi.stubEnv("STT_PROVIDER", "");
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  }
});
afterEach(() => {
  consoleSpies.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAiLimitsForTests();
  setDriverStoreForTests(undefined);
});

const dayKeyNow = (cls: AiClass, id: string, at = t) => aiDayKey(cls, saoPauloDay(at).day, id);
async function seedDay(cls: AiClass, id: string, n: number, at = t) {
  const k = dayKeyNow(cls, id, at);
  for (let i = 0; i < n; i++) await store.incrementRateLimit(k, 90000);
  store.incs.length = 0;
}

describe.each(NAMES)("%s", (name) => {
  const cls = name;
  const { burst, day } = AI_LIMITS[cls];

  it("no session: 401 and the counter is never touched", async () => {
    expect((await call(name, null)).status).toBe(401);
    expect((await call(name, "v1.wrong.wrong.wrong")).status).toBe(401);
    expect((await call(name, "nope")).status).toBe(401);
    expect(store.incs).toEqual([]);
    expect(burstEntryCountForTests()).toBe(0);
    expect(serviceCalls()).toBe(0);
  });

  it("the day counter lives 90000 s (25 h)", async () => {
    const a = await newDriver();
    await call(name, a.token);
    expect(store.windows).toEqual([90000]);
  });

  it("legacy token maps to the owner and is counted as the owner", async () => {
    const res = await call(name, LEGACY);
    expect(res.status).not.toBe(401);
    expect(store.incs).toEqual([dayKeyNow(cls, TEST_OWNER_ID)]);
  });

  it("within the ceiling it reaches the service; ceiling + 1 is 429 with scope and Retry-After, no service call", async () => {
    const a = await newDriver();
    for (let i = 0; i < burst; i++) expect((await call(name, a.token)).status).toBeLessThan(400);
    expect(serviceCalls()).toBeGreaterThanOrEqual(burst);
    const before = serviceCalls();
    t += 15_000;
    const res = await call(name, a.token);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("45");
    expect(await res.json()).toEqual({ error: "Too many requests", scope: "burst" });
    expect(serviceCalls()).toBe(before);
  });

  it("day ceiling: the last allowed passes, the next is 429 scope day with Retry-After to local midnight", async () => {
    const a = await newDriver();
    await seedDay(cls, a.id, day - 1);
    expect((await call(name, a.token)).status).toBeLessThan(400);
    const before = serviceCalls();
    const res = await call(name, a.token);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests", scope: "day" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe(String(12 * 3600)); // 12:00 -> 24:00 in Sao Paulo
    expect(serviceCalls()).toBe(before);
  });

  it("burst and day are independent; scope says which; day only appears after the burst let the request through", async () => {
    const a = await newDriver();
    for (let i = 0; i < burst; i++) await call(name, a.token);
    expect((await (await call(name, a.token)).json()).scope).toBe("burst");
    // a new burst window: passes again while the day counter keeps counting (not reset)
    t += 61_000;
    expect((await call(name, a.token)).status).toBeLessThan(400);
    expect(await store.peekRateLimit(dayKeyNow(cls, a.id))).toBe(burst + 1);
    // day only: another driver, burst window fresh
    const b = await newDriver();
    await seedDay(cls, b.id, day);
    expect((await (await call(name, b.token)).json()).scope).toBe("day");
    t += 61_000; // burst window gone, day still over: the day does not reset because the burst did
    expect((await (await call(name, b.token)).json()).scope).toBe("day");
  });

  it("a request stopped by the burst never touches the store: no increment, no day quota", async () => {
    const a = await newDriver();
    for (let i = 0; i < 30; i++) await call(name, a.token);
    expect(store.incs.length).toBe(burst);
    expect(await store.peekRateLimit(dayKeyNow(cls, a.id))).toBe(burst);
    // even when the day is already over, the burst answer wins and Redis is not asked
    const c = await newDriver();
    await seedDay(cls, c.id, day);
    for (let i = 0; i < burst; i++) await call(name, c.token); // all day (429), but they passed the burst
    store.incs.length = 0;
    const res = await call(name, c.token);
    expect((await res.json()).scope).toBe("burst");
    expect(store.incs).toEqual([]);
    // with Redis down a burst-stopped driver still gets 429, not 503
    store.down = new DriverStoreUnavailableError();
    expect((await call(name, c.token)).status).toBe(429);
  });

  it("drivers A and B have separate counters; forged driverId, contextId and headers never pick the key", async () => {
    const a = await newDriver("a");
    const b = await newDriver("b");
    await seedDay(cls, a.id, day);
    expect((await call(name, a.token)).status).toBe(429);
    expect((await call(name, b.token)).status).toBeLessThan(400);
    store.incs.length = 0;
    const forged = { ...(VALID[name] as object), driverId: b.id, contextId: b.id, driverContext: { driverId: b.id } };
    await call(name, a.token, {
      body: forged,
      headers: { "x-driver-id": b.id, "x-finn-driver": b.id, cookie: `driverId=${b.id}` },
    });
    expect(store.incs).toEqual([dayKeyNow(cls, a.id)]);
    expect(store.incs.join()).not.toContain(b.id);
  });

  it("malformed requests count: 400 loop hits the ceiling", async () => {
    const a = await newDriver();
    for (let i = 0; i < burst; i++) expect((await bad400(name, a.token)).status).toBe(400);
    expect((await bad400(name, a.token)).status).toBe(429);
    expect(await store.peekRateLimit(dayKeyNow(cls, a.id))).toBe(burst);
    expect(serviceCalls()).toBe(0);
  });

  it("day turnover: the key changes at local midnight and Retry-After matches it", async () => {
    const a = await newDriver();
    t = Date.UTC(2026, 9, 29, 2, 59, 29); // 23:59:29 on the 28th in Sao Paulo
    await call(name, a.token);
    t = Date.UTC(2026, 9, 29, 3, 0, 1); // 00:00:01 on the 29th
    await call(name, a.token);
    expect(store.incs).toEqual([aiDayKey(cls, "20261028", a.id), aiDayKey(cls, "20261029", a.id)]);
    expect(saoPauloDay(Date.UTC(2026, 9, 29, 2, 59, 30)).secondsToMidnight).toBe(30);
    // over the day at 23:30 local: wait until midnight
    const b = await newDriver();
    t = Date.UTC(2026, 9, 29, 2, 30, 0);
    await seedDay(cls, b.id, day);
    const res = await call(name, b.token);
    expect(res.headers.get("retry-after")).toBe("1800");
    // and after midnight the same driver starts a new day
    t = Date.UTC(2026, 9, 29, 3, 0, 0);
    resetAiLimitsForTests(() => t);
    expect((await call(name, b.token)).status).toBeLessThan(400);
  });

  it("Redis down: a driver gets 503 without the service; the owner passes; logs carry no id, key or count", async () => {
    const a = await newDriver();
    const key = dayKeyNow(cls, a.id);
    store.down = new Error(`redis boom ${key}`, { cause: new Error(`inner ${a.id} ${key} 599`) });
    const res = await call(name, a.token);
    expect(res.status).toBe(503);
    expect(serviceCalls()).toBe(0);

    const owner = await call(name, LEGACY);
    expect(owner.status).not.toBe(503);
    expect(owner.status).not.toBe(429);
    expect(serviceCalls()).toBeGreaterThan(0);

    const text = loggedText();
    expect(text).not.toContain(a.id);
    expect(text).not.toContain(TEST_OWNER_ID);
    expect(text).not.toContain("ratelimit:");
    expect(text).not.toContain("boom");
    expect(text).not.toContain("inner");
  });

  it("owner with Redis down still has the burst ceiling", async () => {
    store.down = new DriverStoreUnavailableError();
    for (let i = 0; i < burst; i++) expect((await call(name, LEGACY)).status).not.toBe(429);
    const res = await call(name, LEGACY);
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBe("burst");
  });

  it("owner is limited by the same ceilings", async () => {
    await seedDay(cls, TEST_OWNER_ID, day);
    const res = await call(name, LEGACY);
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBe("day");
  });

  it("an overflow logs one warning with route class and scope only, and the 429 body has no count or ceiling", async () => {
    const a = await newDriver();
    await seedDay(cls, a.id, day);
    const res = await call(name, a.token);
    const raw = await res.text();
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["error", "scope"]);
    expect(raw).not.toMatch(/\d/);
    const warns = vi.mocked(console.warn).mock.calls.map((c) => c.join(" "));
    expect(warns).toEqual([`[ai-limit] ${cls} over day limit`]);
    expect(loggedText()).not.toContain(a.id);
  });
});

describe("transcribe and tts: oversized requests count too (413)", () => {
  it.each([
    ["stt", { "content-length": String(20 * 1024 * 1024) }],
    ["tts", { "content-length": String(70 * 1024) }],
  ] as const)("%s", async (name, headers) => {
    const a = await newDriver();
    const burst = AI_LIMITS[name].burst;
    for (let i = 0; i < burst; i++) expect((await call(name, a.token, { headers })).status).toBe(413);
    expect((await call(name, a.token, { headers })).status).toBe(429);
    expect(await store.peekRateLimit(dayKeyNow(name, a.id))).toBe(burst);
    expect(serviceCalls()).toBe(0);
  });
});

describe("live: disabled route", () => {
  it.each([undefined, "0", "true", ""])("ENABLE_GPT_LIVE=%s answers 403 without touching the counter", async (flag) => {
    vi.stubEnv("ENABLE_GPT_LIVE", flag);
    const a = await newDriver();
    for (let i = 0; i < 10; i++) expect((await call("live", a.token)).status).toBe(403);
    expect(store.incs).toEqual([]);
    expect(burstEntryCountForTests()).toBe(0);
    expect(serviceCalls()).toBe(0);
    expect((await call("live", null)).status).toBe(401);
  });
});

describe("keys", () => {
  it("fit the store regex with the longest driverId and the longest class", () => {
    const id = "drv_" + "A".repeat(22);
    for (const cls of Object.keys(AI_LIMITS)) {
      const k = aiDayKey(cls, "20261028", id);
      expect(k).toBe(`ratelimit:ai:${cls}:20261028:${id}`);
      expect(() => keys.rateLimit("finn:development:", k)).not.toThrow();
      expect(k.length - "ratelimit:".length).toBeLessThanOrEqual(100);
    }
  });

  it("an invalid driverId, class or day never becomes a key", async () => {
    const bad = ["", "drv_short", "drv_" + "A".repeat(23), "drv_" + "A".repeat(21) + "!", "drv_" + "A".repeat(21) + ":", "../x", "x\n" + "drv_" + "A".repeat(22)];
    for (const id of bad) {
      expect(() => aiDayKey("stt", "20261028", id)).toThrow();
      const res = await enforceAiLimit("stt", id);
      expect(res?.status).toBe(503);
    }
    expect(() => aiDayKey("st:t", "20261028", "drv_" + "A".repeat(22))).toThrow();
    expect(() => aiDayKey("bogus", "20261028", "drv_" + "A".repeat(22))).toThrow();
    expect(() => aiDayKey("stt", "2026-10-28", "drv_" + "A".repeat(22))).toThrow();
    // @ts-expect-error runtime-only: a class that is not one of the four
    expect((await enforceAiLimit("../../x", "drv_" + "A".repeat(22)))?.status).toBe(503);
    expect(store.incs).toEqual([]);
    expect(burstEntryCountForTests()).toBe(0);
  });

  it("the day follows America/Sao_Paulo, not UTC", () => {
    expect(saoPauloDay(Date.UTC(2026, 9, 28, 2, 59, 59)).day).toBe("20261027");
    expect(saoPauloDay(Date.UTC(2026, 9, 28, 3, 0, 0)).day).toBe("20261028");
    expect(saoPauloDay(Date.UTC(2026, 9, 28, 3, 0, 0)).secondsToMidnight).toBe(86400);
    expect(saoPauloDay(Date.UTC(2026, 11, 31, 14, 0, 0)).day).toBe("20261231");
  });
});

describe("burst map", () => {
  const id = (n: number) => "drv_" + n.toString(36).padStart(22, "0");

  it("never passes the cap and drops the oldest when full", async () => {
    for (let i = 0; i < BURST_MAX_ENTRIES + 500; i++) {
      await enforceAiLimit("stt", id(i), { store });
      expect(burstEntryCountForTests()).toBeLessThanOrEqual(BURST_MAX_ENTRIES);
    }
    expect(burstEntryCountForTests()).toBe(BURST_MAX_ENTRIES);
  });

  it("expired entries disappear (swept when the map is full)", async () => {
    for (let i = 0; i < BURST_MAX_ENTRIES; i++) await enforceAiLimit("stt", id(i), { store });
    expect(burstEntryCountForTests()).toBe(BURST_MAX_ENTRIES);
    t += 61_000;
    await enforceAiLimit("stt", id(5000), { store });
    expect(burstEntryCountForTests()).toBe(1);
  });

  it("a fresh entry survives the sweep while only old ones are removed", async () => {
    for (let i = 0; i < BURST_MAX_ENTRIES - 1; i++) await enforceAiLimit("stt", id(i), { store });
    t += 30_000;
    await enforceAiLimit("stt", id(9000), { store }); // fills the map; window ends at +90 s
    t += 40_000; // the first 999 expired, id(9000) is alive
    await enforceAiLimit("stt", id(9001), { store });
    expect(burstEntryCountForTests()).toBe(2);
  });
});
