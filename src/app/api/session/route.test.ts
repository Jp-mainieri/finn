import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const PEPPER = "c2b7d95e01f84a36b9d0e7a15c4f8823e6a91b07d3f5c8e24a0b69d1f7c3e5a8";
const IP = { "x-vercel-forwarded-for": "203.0.113.7" };

/** Fresh module registry per test: fresh memory store singleton, fresh route. */
async function boot() {
  vi.resetModules();
  const drv = await import("@/lib/driver");
  const route = await import("./route");
  const store = drv.getDriverStore();
  const counted = ["incrementRateLimit", "redeemInvite", "getDriver", "createDriver"] as const;
  const spies = counted.map((m) => vi.spyOn(store, m));
  const calls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);
  const reset = () => spies.forEach((s) => s.mockClear());
  return { drv, route, store, calls, reset };
}

const post = (body: unknown, headers: Record<string, string> = IP) =>
  new Request("http://x/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (token?: string) =>
  new Request("http://x/api/session", { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function snap(r: Response) {
  return { status: r.status, text: await r.text(), headers: [...r.headers.entries()].sort() };
}

describe("/api/session", () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    vi.stubEnv("FINN_INVITE_PEPPER", PEPPER);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "");
    logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const future = () => Date.now() + 3_600_000;

  it("redeem 200 expires the legacy Spotify cookie; error answers do not", async () => {
    const { route, store } = await boot();
    const { code } = await store.createInvite({ label: "Carro", maxUses: 1, expiresAt: future() });
    const ok = await route.POST(post({ inviteCode: code }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toBe("finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    for (const res of [
      await route.POST(post({ inviteCode: code })), // exhausted: 401
      await route.POST(post("not json")), // 400
      await route.POST(post({ inviteCode: "" })), // 400
      await route.POST(post({}, { ...IP, "content-type": "text/plain" })), // 415
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    vi.stubEnv("FINN_SESSION_SECRET", "");
    const down = await route.POST(post({ inviteCode: code }));
    expect(down.status).toBe(503);
    expect(down.headers.get("set-cookie")).toBeNull();
  });

  it("redeems an invite, returns a token that GET /api/session accepts", async () => {
    const { route, store } = await boot();
    const { code } = await store.createInvite({ label: "Carro", maxUses: 1, expiresAt: future() });
    const res = await route.POST(post({ inviteCode: code.toLowerCase() }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(Object.keys(out).sort()).toEqual(["driverId", "label", "token"]);
    expect(out.label).toBe("Carro");
    expect(out.token.startsWith("v1.")).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const who = await route.GET(get(out.token));
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ driverId: out.driverId, label: "Carro" });
    expect((await route.GET(get())).status).toBe(401);
    expect((await route.GET(get("v1.nope.nope"))).status).toBe(401);
  });

  it("revoked driver and rotateSessions invalidate GET", async () => {
    const { route, store } = await boot();
    const mk = async () => {
      const { code } = await store.createInvite({ label: "X", maxUses: 1, expiresAt: future() });
      return (await (await route.POST(post({ inviteCode: code }))).json()) as { token: string; driverId: string };
    };
    const a = await mk();
    const b = await mk();
    await store.rotateSessions(a.driverId);
    await store.revokeDriver(b.driverId);
    expect((await route.GET(get(a.token))).status).toBe(401);
    expect((await route.GET(get(b.token))).status).toBe(401);
  });

  it("unknown, expired, exhausted and revoked codes: identical response and identical Redis round-trips", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_800_000_000_000));
    const { route, store, calls, reset } = await boot();
    const mkInvite = (ms: number) => store.createInvite({ label: "L", maxUses: 1, expiresAt: Date.now() + ms });

    const expired = await mkInvite(1000);
    const exhausted = await mkInvite(60_000);
    await store.redeemInvite(exhausted.code);
    const revoked = await mkInvite(60_000);
    await store.revokeInvite(revoked.code);
    vi.setSystemTime(new Date(1_800_000_000_000 + 5000));
    const unknown = { code: "FINN-ABCD-EFGH" };

    const outs: Awaited<ReturnType<typeof snap>>[] = [];
    const trips: number[] = [];
    for (const c of [unknown, expired, exhausted, revoked]) {
      reset();
      outs.push(await snap(await route.POST(post({ inviteCode: c.code }, { "x-vercel-forwarded-for": "198.51.100.1" }))));
      trips.push(calls());
    }
    expect(outs[0].status).toBe(401);
    for (const o of outs) expect(o).toEqual(outs[0]);
    expect(trips).toEqual([2, 2, 2, 2]);
    expect(outs[0].text).not.toMatch(/FINN-|drv_|v1\./);
  });

  it("rate limit: 429 with Retry-After after the budget; other IPs unaffected; counted per IP", async () => {
    const { route, drv } = await boot();
    const max = drv.REDEEM_RATE_LIMIT.max;
    for (let i = 0; i < max; i++) {
      expect((await route.POST(post({ inviteCode: "FINN-ABCD-EFGH" }))).status).toBe(401);
    }
    const blocked = await route.POST(post({ inviteCode: "FINN-ABCD-EFGH" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBe(drv.REDEEM_RATE_LIMIT.windowSeconds);
    expect(await blocked.text()).not.toMatch(/FINN-|203\.0\.113/);
    const other = await route.POST(post({ inviteCode: "FINN-ABCD-EFGH" }, { "x-vercel-forwarded-for": "203.0.113.8" }));
    expect(other.status).toBe(401);
  });

  it("a valid code over the rate limit is not redeemed", async () => {
    const { route, store, drv } = await boot();
    const { code } = await store.createInvite({ label: "L", maxUses: 1, expiresAt: future() });
    for (let i = 0; i < drv.REDEEM_RATE_LIMIT.max; i++) await route.POST(post({ inviteCode: "FINN-ABCD-EFGH" }));
    expect((await route.POST(post({ inviteCode: code }))).status).toBe(429);
    expect((await route.POST(post({ inviteCode: code }, { "x-vercel-forwarded-for": "203.0.113.9" }))).status).toBe(200);
  });

  it("missing IP uses the own noip bucket (stricter), never raw header text", async () => {
    const { route, drv } = await boot();
    for (let i = 0; i < drv.REDEEM_RATE_LIMIT_NO_IP.max; i++) {
      expect((await route.POST(post({ inviteCode: "FINN-ABCD-EFGH" }, {}))).status).toBe(401);
    }
    expect((await route.POST(post({ inviteCode: "FINN-ABCD-EFGH" }, { "x-vercel-forwarded-for": "garbage" }))).status).toBe(429);
  });

  it("invalid input: generic 400, no echo, no store access", async () => {
    const { route, calls } = await boot();
    const secretish = "ZZZ-SECRET-ECHO-CHECK";
    const bodies: unknown[] = [
      "{not json " + secretish,
      "",
      "null",
      "[]",
      "42",
      {},
      { inviteCode: 123 },
      { inviteCode: null },
      { inviteCode: [secretish] },
      { inviteCode: { x: secretish } },
      { inviteCode: "" },
      { other: secretish },
    ];
    const outs = [];
    for (const b of bodies) outs.push(await snap(await route.POST(post(b as string))));
    for (const o of outs) {
      expect(o.status).toBe(400);
      expect(o).toEqual(outs[0]);
      expect(o.text).not.toContain(secretish);
    }
    expect(calls()).toBe(0);
  });

  it("wrong or missing Content-Type is 415 and a body over 2 KB is 413, with zero Redis calls", async () => {
    const { route, calls } = await boot();
    const body = JSON.stringify({ inviteCode: "FINN-ABCD-EFGH" });
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx", ""]) {
      const headers: Record<string, string> = { ...IP };
      if (ct) headers["content-type"] = ct;
      const r = await route.POST(new Request("http://x/api/session", { method: "POST", headers, body }));
      expect(r.status).toBe(415);
      expect(await r.text()).not.toContain("FINN-");
    }
    // charset parameter and case are fine
    const okType = await route.POST(new Request("http://x/api/session", { method: "POST", headers: { ...IP, "content-type": "Application/JSON; charset=utf-8" }, body }));
    expect(okType.status).toBe(401);
    const before = calls();

    const big = JSON.stringify({ inviteCode: "FINN-ABCD-EFGH", pad: "x".repeat(3000) });
    const byLength = await route.POST(post(big));
    expect(byLength.status).toBe(413);
    // no (or lying) Content-Length: the limited reader still stops it
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (let i = 0; i < 10; i++) c.enqueue(enc.encode("x".repeat(500)));
        c.close();
      },
    });
    const streamed = await route.POST(
      new Request("http://x/api/session", { method: "POST", headers: { ...IP, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(calls()).toBe(before); // only the earlier valid-type request touched Redis
  });

  it("Redis down: short 503, nothing leaked or logged", async () => {
    const { route, store, drv } = await boot();
    const { code } = await store.createInvite({ label: "L", maxUses: 1, expiresAt: future() });
    vi.spyOn(store, "incrementRateLimit").mockRejectedValue(new drv.DriverStoreUnavailableError());
    const r = await route.POST(post({ inviteCode: code }));
    const text = await r.text();
    expect(r.status).toBe(503);
    expect(text.length).toBeLessThan(120);
    expect(text).not.toContain(code);
    expect((await route.GET(get(undefined))).status).toBe(401);
    // GET with a token while Redis is down
    vi.spyOn(store, "getDriver").mockRejectedValue(new drv.DriverStoreUnavailableError());
    const tok = drv.signSessionToken({ driverId: "drv_" + "A".repeat(22), tokenVersion: 1 }, SECRET);
    expect((await route.GET(get(tok))).status).toBe(503);
  });

  it("missing session secret fails closed BEFORE consuming the invite", async () => {
    const { route, store } = await boot();
    const { code } = await store.createInvite({ label: "L", maxUses: 1, expiresAt: future() });
    vi.stubEnv("FINN_SESSION_SECRET", "");
    expect((await route.POST(post({ inviteCode: code }))).status).toBe(503);
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    expect((await route.POST(post({ inviteCode: code }))).status).toBe(200);
  });

  it("never logs, and responses never carry code, token, pepper, secret or other drivers' ids", async () => {
    const { route, store } = await boot();
    const other = await store.createDriver({ label: "Outro" });
    const { code } = await store.createInvite({ label: "L", maxUses: 1, expiresAt: future() });
    const ok = await route.POST(post({ inviteCode: code }));
    const okBody = await ok.json();
    const dumps: string[] = [];
    for (const r of [
      await route.POST(post({ inviteCode: code })), // exhausted
      await route.POST(post("{bad")),
      await route.GET(get("v1.bad.bad")),
      await route.GET(get()),
    ]) {
      dumps.push(`${r.status} ${[...r.headers]} ${await r.text()}`);
    }
    const all = dumps.join("\n");
    for (const s of [code, okBody.token, okBody.driverId, other.driverId, PEPPER, SECRET]) expect(all).not.toContain(s);
    for (const l of logs) expect(l).not.toHaveBeenCalled();
  });
});
