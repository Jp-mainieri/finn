import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  A2A_RATE_LIMIT,
  A2A_RATE_LIMIT_NO_IP,
  authorizeA2A,
  guardA2A,
  resetA2ADisabledLogForTests,
} from "./auth";
import {
  DriverStoreUnavailableError,
  MemoryDriverStore,
  UpstashDriverStore,
  createRedisClient,
  keyPrefix,
  type DriverStore,
} from "./driver";
import { RATELIMIT_SCRIPT } from "./driver/upstash-store";

const A2A = "9c1e47d2b86a30f5e7d4c2a91b68f03e5d7a24c9e1b0836f4a5d2c7e91f0b3a8";
const NEXT = "5d2b8f1a7c3e904d6b1a8e5f2c7d03a94b6e1f8c5a2d7039e4b1c6f8a5d20e73";
const API = "x-api-token-0123456789abcdefghijklmnopqrstuv";

const T0 = 1_800_000_000_000;
function setup() {
  const clock = { t: T0 };
  const store = new MemoryDriverStore(keyPrefix("test"), () => clock.t);
  return { clock, store };
}
const req = (auth?: string, ip?: string, extra: Record<string, string> = {}) =>
  new Request("http://x/api/agents/waze", {
    method: "POST",
    headers: { ...(auth ? { authorization: auth } : {}), ...(ip ? { "x-vercel-forwarded-for": ip } : {}), ...extra },
  });

beforeEach(() => {
  resetA2ADisabledLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("FINN_A2A_TOKEN", A2A);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("guardA2A failure rate limit", () => {
  it("allows 10 failures per IP, then 429 + Retry-After, even for the right secret afterwards", async () => {
    const { store } = setup();
    for (let i = 0; i < A2A_RATE_LIMIT.max; i++) {
      expect((await guardA2A(req("Bearer wrong", "1.2.3.4"), { store }))?.status).toBe(401);
    }
    const blocked = (await guardA2A(req("Bearer wrong", "1.2.3.4"), { store }))!;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe(String(A2A_RATE_LIMIT.windowSeconds));
    // the lock-out also covers the right secret (the limiter runs before the comparison)
    expect((await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store }))?.status).toBe(429);
    // another IP is unaffected
    expect(await guardA2A(req(`Bearer ${A2A}`, "5.6.7.8"), { store })).toBeNull();
  });

  it("successful calls never count: a legitimate client is not throttled", async () => {
    const { store } = setup();
    for (let i = 0; i < 50; i++) expect(await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store })).toBeNull();
    expect(await store.peekRateLimit("ratelimit:a2a:1.2.3.4")).toBe(0);
  });

  it("the window expires and the counter starts again", async () => {
    const { store, clock } = setup();
    for (let i = 0; i < A2A_RATE_LIMIT.max; i++) await guardA2A(req("Bearer wrong", "1.2.3.4"), { store });
    expect((await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store }))?.status).toBe(429);
    clock.t += (A2A_RATE_LIMIT.windowSeconds + 1) * 1000;
    expect(await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store })).toBeNull();
  });

  it("missing, empty or invalid IP share the 'noip' bucket with a lower limit (3)", async () => {
    const { store } = setup();
    const noIp = [req("Bearer wrong"), req("Bearer wrong", "not-an-ip"), req("Bearer wrong", "", { "x-forwarded-for": "garbage" })];
    for (let i = 0; i < A2A_RATE_LIMIT_NO_IP.max; i++) {
      expect((await guardA2A(noIp[i % 3], { store }))?.status).toBe(401);
    }
    for (const r of noIp) expect((await guardA2A(r, { store }))?.status).toBe(429);
    expect(await store.peekRateLimit("ratelimit:a2a:noip")).toBe(A2A_RATE_LIMIT_NO_IP.max);
    // a valid IP is in its own bucket
    expect(await guardA2A(req(`Bearer ${A2A}`, "9.9.9.9"), { store })).toBeNull();
  });

  it("limits are adjustable through deps", async () => {
    const { store } = setup();
    const limit = { max: 2, windowSeconds: 30 };
    await guardA2A(req("Bearer wrong", "1.1.1.1"), { store, limit });
    await guardA2A(req("Bearer wrong", "1.1.1.1"), { store, limit });
    const res = (await guardA2A(req("Bearer wrong", "1.1.1.1"), { store, limit }))!;
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("counters use only the ratelimit:a2a: key under the env prefix", async () => {
    const { store } = setup();
    await guardA2A(req("Bearer wrong", "1.2.3.4"), { store });
    await guardA2A(req("Bearer wrong", "2001:db8:1:2:3:4:5:6"), { store });
    expect(store.allKeys().sort()).toEqual([
      "finn:test:ratelimit:a2a:1.2.3.4",
      "finn:test:ratelimit:a2a:v6-2001-db8-1-2",
    ]);
  });

  it("Redis down: 503 (never lets the request through, never 401/429 by guess), nothing leaked or logged", async () => {
    const down: DriverStore = new Proxy({} as DriverStore, {
      get: () => async () => {
        throw new DriverStoreUnavailableError();
      },
    });
    for (const auth of [`Bearer ${A2A}`, "Bearer wrong"]) {
      const res = (await guardA2A(req(auth, "1.2.3.4"), { store: down }))!;
      expect(res.status).toBe(503);
      expect(await res.text()).not.toMatch(/Redis|upstash|secret/i);
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it("increment failing after a wrong secret is also 503, not 401", async () => {
    const { store } = setup();
    const flaky: DriverStore = Object.create(store);
    flaky.incrementRateLimit = async () => {
      throw new DriverStoreUnavailableError();
    };
    expect((await guardA2A(req("Bearer wrong", "1.2.3.4"), { store: flaky }))?.status).toBe(503);
  });

  it("disabled configuration answers 503 first, without touching the store", async () => {
    vi.stubEnv("FINN_A2A_TOKEN", "");
    const store = { peekRateLimit: vi.fn(), incrementRateLimit: vi.fn() } as unknown as DriverStore;
    expect((await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store }))?.status).toBe(503);
    expect(store.peekRateLimit).not.toHaveBeenCalled();
  });
});

describe("A2A secret rotation (FINN_A2A_TOKEN_NEXT)", () => {
  it("accepts both secrets during the rotation, and rejects others", async () => {
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", NEXT);
    const { store } = setup();
    expect(await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store })).toBeNull();
    expect(await guardA2A(req(`Bearer ${NEXT}`, "1.2.3.4"), { store })).toBeNull();
    expect((await guardA2A(req(`Bearer ${A2A.slice(0, -1)}0`, "1.2.3.4"), { store }))?.status).toBe(401);
    expect(authorizeA2A(req(`Bearer ${NEXT}`))).toBeNull();
    expect(authorizeA2A(req(`Bearer ${A2A}`))).toBeNull();
  });

  it("without NEXT only the current one works; an empty NEXT counts as absent", async () => {
    const { store } = setup();
    expect((await guardA2A(req(`Bearer ${NEXT}`, "1.2.3.4"), { store }))?.status).toBe(401);
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", "   ");
    expect(await guardA2A(req(`Bearer ${A2A}`, "1.2.3.4"), { store })).toBeNull();
  });

  it("equal values are rejected: NEXT = TOKEN, NEXT = API token, TOKEN = API token (all fail closed, 503)", () => {
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", A2A);
    expect(authorizeA2A(req(`Bearer ${A2A}`))?.status).toBe(503);
    resetA2ADisabledLogForTests();
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", NEXT);
    vi.stubEnv("FINN_API_TOKEN", NEXT);
    expect(authorizeA2A(req(`Bearer ${NEXT}`))?.status).toBe(503);
    expect(authorizeA2A(req(`Bearer ${A2A}`))?.status).toBe(503);
    vi.stubEnv("FINN_API_TOKEN", API);
    expect(authorizeA2A(req(`Bearer ${NEXT}`))).toBeNull();
    vi.stubEnv("FINN_API_TOKEN", ` ${A2A} `);
    expect(authorizeA2A(req(`Bearer ${A2A}`))?.status).toBe(503);
  });

  it("an invalid NEXT turns the endpoint off (never 'ignore the bad one')", () => {
    for (const bad of ["short", "ab".repeat(32), `${NEXT.slice(0, 63)}g`, `${NEXT}a`]) {
      vi.stubEnv("FINN_A2A_TOKEN_NEXT", bad);
      expect(authorizeA2A(req(`Bearer ${A2A}`))?.status).toBe(503);
      expect(authorizeA2A(req(`Bearer ${bad}`))?.status).toBe(503);
    }
  });

  it("NEXT alone, without TOKEN, is off", () => {
    vi.stubEnv("FINN_A2A_TOKEN", "");
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", NEXT);
    expect(authorizeA2A(req(`Bearer ${NEXT}`))?.status).toBe(503);
  });

  it("revocation = removing the variable: the old secret stops working", () => {
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", NEXT);
    expect(authorizeA2A(req(`Bearer ${A2A}`))).toBeNull();
    vi.stubEnv("FINN_A2A_TOKEN", NEXT); // promote
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", "");
    expect(authorizeA2A(req(`Bearer ${A2A}`))?.status).toBe(401);
    expect(authorizeA2A(req(`Bearer ${NEXT}`))).toBeNull();
  });

  it("no secret ever reaches the log or the response body", async () => {
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", A2A);
    const res = authorizeA2A(req(`Bearer ${A2A}`))!;
    const text = await res.text();
    expect(text + JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(A2A);
  });
});

describe("peekRateLimit and the Upstash store (real SDK, fake fetch)", () => {
  function fakeUpstash(getReply: unknown | ((key: string) => unknown)) {
    const commands: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init: RequestInit) => {
        const cmd = JSON.parse(init.body as string) as string[];
        commands.push(cmd);
        const result = cmd[0].toLowerCase() === "get" ? (typeof getReply === "function" ? getReply(cmd[1]) : getReply) : cmd[0].toLowerCase() === "eval" ? 1 : null;
        return new Response(JSON.stringify({ result }), { status: 200 });
      }),
    );
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "fake-token"), "finn:production:");
    return { store, commands };
  }

  it("reads the counter with the prefixed key; absent is 0", async () => {
    const { store, commands } = fakeUpstash(null);
    expect(await store.peekRateLimit("ratelimit:a2a:1.2.3.4")).toBe(0);
    expect(commands).toEqual([["get", "finn:production:ratelimit:a2a:1.2.3.4"]]);
    expect(RATELIMIT_SCRIPT).toContain("INCR");
  });

  it("parses a numeric string; anything else is the generic error (never '0 hits')", async () => {
    expect(await fakeUpstash("7").store.peekRateLimit("ratelimit:a2a:x")).toBe(7);
    for (const bad of ["abc", "-1", "1.5", { a: 1 }, [1]]) {
      await expect(fakeUpstash(bad).store.peekRateLimit("ratelimit:a2a:x")).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    }
  });

  it("a failing endpoint is the generic error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "ERR secret-detail" }), { status: 500 })));
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "fake-token"), "finn:production:");
    const err = await store.peekRateLimit("ratelimit:a2a:x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverStoreUnavailableError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain("secret-detail");
  });

  it("rejects keys outside the ratelimit: charset", async () => {
    const { store, commands } = fakeUpstash(null);
    await expect(store.peekRateLimit("driver:x")).rejects.toThrow();
    await expect(store.peekRateLimit("ratelimit:a b")).rejects.toThrow();
    expect(commands).toHaveLength(0);
  });
});
