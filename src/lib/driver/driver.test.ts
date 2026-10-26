import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MemoryDriverStore,
  UpstashDriverStore,
  authenticateSession,
  checkRedeemRateLimit,
  createDriverStore,
  generateInviteCode,
  hashInviteCode,
  keyPrefix,
  signSessionToken,
  verifySessionToken,
  SESSION_TTL_SECONDS,
  getSessionSecret,
} from "./index";
import { REDEEM_SCRIPT, RATELIMIT_SCRIPT, REVOKE_SCRIPT, type RedisLike } from "./upstash-store";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);
const P = keyPrefix("test");
const T0 = 1_800_000_000_000;

function setup() {
  const clock = { t: T0 };
  const store = new MemoryDriverStore(P, () => clock.t);
  return { clock, store };
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("session token", () => {
  it("round-trips and expires at 90 days", async () => {
    const { store } = setup();
    const d = await store.createDriver({ label: "A" });
    const tok = signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SECRET, T0);
    expect(verifySessionToken(tok, SECRET, T0)?.sub).toBe(d.driverId);
    const exp = T0 + SESSION_TTL_SECONDS * 1000;
    expect(verifySessionToken(tok, SECRET, exp - 1000)).not.toBeNull();
    expect(verifySessionToken(tok, SECRET, exp)).toBeNull();
  });

  it("rejects tampered payload, tampered signature, wrong secret", async () => {
    const { store } = setup();
    const d = await store.createDriver({ label: "A" });
    const tok = signSessionToken({ driverId: d.driverId, tokenVersion: 1 }, SECRET, T0);
    const [v, body, sig] = tok.split(".");
    const forged = b64({ ...JSON.parse(Buffer.from(body, "base64url").toString()), exp: 9_999_999_999 });
    expect(verifySessionToken(`${v}.${forged}.${sig}`, SECRET, T0)).toBeNull();
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(verifySessionToken(`${v}.${body}.${flipped}`, SECRET, T0)).toBeNull();
    expect(verifySessionToken(tok, OTHER, T0)).toBeNull();
  });

  it("rejects malformed tokens without throwing (incl. short signature length)", () => {
    for (const t of ["", "x", "v1.a", "v1.a.b.c", "v2.a.b", "v1..", "v1.%%%.%%%", "v1.e30.AA", "a".repeat(5000)]) {
      expect(verifySessionToken(t, SECRET, T0)).toBeNull();
    }
  });

  it("rejects validly signed but badly shaped payloads", () => {
    const mk = (p: unknown) => {
      const head = `v1.${b64(p)}`;
      return `${head}.${createHmac("sha256", SECRET).update(head).digest("base64url")}`;
    };
    expect(verifySessionToken(mk({ sub: "x", iat: 1, exp: 9e9, tv: 1 }), SECRET, T0)).toBeNull();
    expect(verifySessionToken(mk("str"), SECRET, T0)).toBeNull();
    expect(verifySessionToken(mk(null), SECRET, T0)).toBeNull();
  });

  it("rejects stale tv, revoked driver, unknown driver", async () => {
    const { store } = setup();
    const d = await store.createDriver({ label: "A" });
    const ok = signSessionToken({ driverId: d.driverId, tokenVersion: 1 }, SECRET, T0);
    expect((await authenticateSession(ok, store, SECRET, T0))?.driverId).toBe(d.driverId);
    const stale = signSessionToken({ driverId: d.driverId, tokenVersion: 2 }, SECRET, T0);
    expect(await authenticateSession(stale, store, SECRET, T0)).toBeNull();
    await store.revokeDriver(d.driverId);
    expect(await authenticateSession(ok, store, SECRET, T0)).toBeNull();
    const ghost = signSessionToken({ driverId: "drv_" + "A".repeat(22), tokenVersion: 1 }, SECRET, T0);
    expect(await authenticateSession(ghost, store, SECRET, T0)).toBeNull();
  });

  it("refuses short secrets", () => {
    expect(() => signSessionToken({ driverId: "drv_" + "A".repeat(22), tokenVersion: 1 }, "short", T0)).toThrow();
    expect(() => verifySessionToken("v1.a.b", "short", T0)).toThrow();
  });

  it("getSessionSecret fails closed when missing or short", () => {
    const old = process.env.FINN_SESSION_SECRET;
    try {
      delete process.env.FINN_SESSION_SECRET;
      expect(() => getSessionSecret()).toThrow();
      process.env.FINN_SESSION_SECRET = "short";
      expect(() => getSessionSecret()).toThrow();
      process.env.FINN_SESSION_SECRET = SECRET;
      expect(getSessionSecret()).toBe(SECRET);
    } finally {
      if (old === undefined) delete process.env.FINN_SESSION_SECRET;
      else process.env.FINN_SESSION_SECRET = old;
    }
  });
});

describe("invites (memory store)", () => {
  it("parallel redeem with maxUses=1 yields exactly one success", async () => {
    const { store } = setup();
    const { code } = await store.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 });
    const res = await Promise.all(Array.from({ length: 20 }, () => store.redeemInvite(code)));
    expect(res.filter(Boolean)).toHaveLength(1);
  });

  it("maxUses=3 allows exactly 3", async () => {
    const { store } = setup();
    const { code } = await store.createInvite({ label: "A", maxUses: 3, expiresAt: T0 + 1000 });
    const res = await Promise.all(Array.from({ length: 10 }, () => store.redeemInvite(code)));
    expect(res.filter(Boolean)).toHaveLength(3);
  });

  it("expired, revoked, exhausted, unknown and malformed all return null", async () => {
    const { store, clock } = setup();
    const exp = await store.createInvite({ label: "E", maxUses: 1, expiresAt: T0 + 1000 });
    clock.t = T0 + 1000;
    const rev = await store.createInvite({ label: "R", maxUses: 1, expiresAt: T0 + 9999 });
    await store.revokeInvite(rev.code);
    const ex = await store.createInvite({ label: "X", maxUses: 1, expiresAt: T0 + 9999 });
    expect(await store.redeemInvite(ex.code)).not.toBeNull();
    const outs = await Promise.all([
      store.redeemInvite(exp.code),
      store.redeemInvite(rev.code),
      store.redeemInvite(ex.code),
      store.redeemInvite(generateInviteCode()),
      store.redeemInvite("garbage"),
      store.redeemInvite(""),
    ]);
    expect(outs.every((o) => o === null)).toBe(true);
  });

  it("accepts lowercase/whitespace input; code never stored in clear", async () => {
    const { store } = setup();
    const { code } = await store.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 });
    expect(store.allKeys().some((k) => k.includes(code))).toBe(false);
    expect(store.allKeys()).toContain(`${P}invite:${hashInviteCode(code)}`);
    expect(await store.redeemInvite(`  ${code.toLowerCase()} `)).not.toBeNull();
  });

  it("generated codes match FINN-XXXX-XXXX without ambiguous chars", () => {
    for (let i = 0; i < 200; i++) expect(generateInviteCode()).toMatch(/^FINN-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  it("validates input", async () => {
    const { store } = setup();
    await expect(store.createInvite({ label: "", maxUses: 1, expiresAt: T0 })).rejects.toThrow();
    await expect(store.createInvite({ label: "a", maxUses: 0, expiresAt: T0 })).rejects.toThrow();
    await expect(store.createInvite({ label: "a", maxUses: 1.5, expiresAt: T0 })).rejects.toThrow();
  });
});

describe("rate limit and isolation (memory store)", () => {
  it("blocks past the budget and resets after the window", async () => {
    const { store, clock } = setup();
    const ip = "1.2.3.4";
    const r: boolean[] = [];
    for (let i = 0; i < 12; i++) r.push(await checkRedeemRateLimit(store, ip));
    expect(r.filter(Boolean)).toHaveLength(10);
    expect(await checkRedeemRateLimit(store, "5.6.7.8")).toBe(true);
    clock.t += 601_000;
    expect(await checkRedeemRateLimit(store, ip)).toBe(true);
  });

  it("driver A never reads B; revoking A leaves B active; keys prefixed", async () => {
    const { store } = setup();
    const a = await store.createDriver({ label: "A" });
    const b = await store.createDriver({ label: "B" });
    expect((await store.getDriver(a.driverId))?.label).toBe("A");
    expect((await store.getDriver(b.driverId))?.label).toBe("B");
    expect(a.driverId).not.toBe(b.driverId);
    expect(a.driverId).toMatch(/^drv_[A-Za-z0-9_-]{22}$/);
    await store.revokeDriver(a.driverId);
    expect((await store.getDriver(b.driverId))?.status).toBe("active");
    await store.getDriver("../driver:" + b.driverId).then((d) => expect(d).toBeNull());
    await store.incrementRateLimit("ratelimit:redeem:x", 60);
    expect(store.allKeys().length).toBeGreaterThan(0);
    expect(store.allKeys().every((k) => k.startsWith("finn:test:"))).toBe(true);
  });

  it("rejects a store without a valid prefix", () => {
    expect(() => new MemoryDriverStore("")).toThrow();
    expect(() => new MemoryDriverStore("driver:")).toThrow();
  });
});

describe("createDriverStore env selection (fail closed)", () => {
  it("production/preview/unknown without KV vars throws", () => {
    for (const VERCEL_ENV of ["production", "preview", "staging"]) {
      expect(() => createDriverStore({ VERCEL_ENV })).toThrow(/not configured/);
      expect(() => createDriverStore({ VERCEL_ENV, KV_REST_API_URL: "https://x" })).toThrow();
      expect(() => createDriverStore({ VERCEL_ENV, KV_REST_API_TOKEN: "t" })).toThrow();
    }
    expect(() => createDriverStore({ NODE_ENV: "production" })).toThrow(/not configured/);
  });
  it("development/test fall back to memory; with vars use Upstash (no network at construction)", () => {
    expect(createDriverStore({})).toBeInstanceOf(MemoryDriverStore);
    expect(createDriverStore({ VERCEL_ENV: "test" })).toBeInstanceOf(MemoryDriverStore);
    const s = createDriverStore({ VERCEL_ENV: "production", KV_REST_API_URL: "https://x.example", KV_REST_API_TOKEN: "t" });
    expect(s).toBeInstanceOf(UpstashDriverStore);
  });
});

/** Mock Redis emulating the semantics of our 3 scripts; records every call. */
function mockRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const calls: { op: string; keys: string[] }[] = [];
  const redis: RedisLike = {
    async hgetall(key) {
      calls.push({ op: "hgetall", keys: [key] });
      const h = hashes.get(key);
      return h ? { ...h } : null;
    },
    async hset(key, v) {
      calls.push({ op: "hset", keys: [key] });
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...v });
      return 1;
    },
    async eval(script, ks, args) {
      calls.push({ op: script === REDEEM_SCRIPT ? "redeem" : script === REVOKE_SCRIPT ? "revoke" : "rl", keys: ks });
      if (script === REDEEM_SCRIPT) {
        const inv = hashes.get(ks[0]);
        if (!inv || inv.revoked === "1" || Number(inv.uses) >= Number(inv.maxUses) || Number(inv.expiresAt) <= Number(args[0])) return 0;
        inv.uses = String(Number(inv.uses) + 1);
        const f: Record<string, string> = {};
        for (let i = 1; i < args.length; i += 2) f[args[i]] = args[i + 1];
        hashes.set(ks[1], f);
        return 1;
      }
      if (script === REVOKE_SCRIPT) {
        const h = hashes.get(ks[0]);
        if (h) h[args[0]] = args[1];
        return 1;
      }
      if (script === RATELIMIT_SCRIPT) {
        const h = hashes.get(ks[0]) ?? { n: "0" };
        h.n = String(Number(h.n) + 1);
        hashes.set(ks[0], h);
        return Number(h.n);
      }
      throw new Error("unexpected script");
    },
  };
  return { redis, hashes, calls };
}

describe("UpstashDriverStore (mock client, no network)", () => {
  const mk = () => {
    const m = mockRedis();
    const clock = { t: T0 };
    return { ...m, clock, store: new UpstashDriverStore(m.redis, keyPrefix("preview"), () => clock.t) };
  };

  it("maps every key under finn:<env>: and never stores the code in clear", async () => {
    const { store, hashes, calls } = mk();
    const d = await store.createDriver({ label: "A" });
    const { code } = await store.createInvite({ label: "I", maxUses: 1, expiresAt: T0 + 1000 });
    await store.redeemInvite(code);
    await store.incrementRateLimit("ratelimit:redeem:1.1.1.1", 60);
    await store.revokeDriver(d.driverId);
    const all = [...hashes.keys(), ...calls.flatMap((c) => c.keys)];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((k) => k.startsWith("finn:preview:"))).toBe(true);
    expect(all).toContain(`finn:preview:driver:${d.driverId}`);
    expect(all).toContain(`finn:preview:invite:${hashInviteCode(code)}`);
    expect(all).toContain("finn:preview:ratelimit:redeem:1.1.1.1");
    expect(JSON.stringify([...hashes.entries()])).not.toContain(code);
    expect(all.some((k) => k.includes(code))).toBe(false);
  });

  it("redeem is a single eval; parallel redeem with maxUses=1 gives one success", async () => {
    const { store, calls } = mk();
    const { code } = await store.createInvite({ label: "I", maxUses: 1, expiresAt: T0 + 1000 });
    const res = await Promise.all(Array.from({ length: 15 }, () => store.redeemInvite(code)));
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(calls.filter((c) => c.op === "redeem")).toHaveLength(15);
    expect(REDEEM_SCRIPT).toContain("HINCRBY");
  });

  it("expired, revoked, exhausted, unknown, malformed -> null; revoked driver fails auth", async () => {
    const { store, clock } = mk();
    const e = await store.createInvite({ label: "E", maxUses: 1, expiresAt: T0 + 10 });
    const r = await store.createInvite({ label: "R", maxUses: 1, expiresAt: T0 + 9999 });
    await store.revokeInvite(r.code);
    const x = await store.createInvite({ label: "X", maxUses: 1, expiresAt: T0 + 9999 });
    const first = await store.redeemInvite(x.code);
    expect(first).not.toBeNull();
    clock.t = T0 + 10;
    const outs = await Promise.all([e.code, r.code, x.code, generateInviteCode(), "nope"].map((c) => store.redeemInvite(c)));
    expect(outs.every((o) => o === null)).toBe(true);
    const tok = signSessionToken({ driverId: first!.driverId, tokenVersion: first!.tokenVersion }, SECRET, T0);
    expect(await authenticateSession(tok, store, SECRET, T0)).not.toBeNull();
    await store.revokeDriver(first!.driverId);
    expect(await authenticateSession(tok, store, SECRET, T0)).toBeNull();
  });

  it("revoke of a nonexistent invite/driver creates nothing", async () => {
    const { store, hashes } = mk();
    await store.revokeInvite(generateInviteCode());
    await store.revokeDriver("drv_" + "A".repeat(22));
    expect(hashes.size).toBe(0);
  });

  it("round-trips numeric-looking labels as strings and isolates drivers", async () => {
    const { store } = mk();
    const a = await store.createDriver({ label: "1e3" });
    const b = await store.createDriver({ label: "B" });
    expect((await store.getDriver(a.driverId))?.label).toBe("1e3");
    expect((await store.getDriver(b.driverId))?.label).toBe("B");
    expect(await store.getDriver("drv_" + "Z".repeat(22))).toBeNull();
    expect(await store.getDriver("../x")).toBeNull();
  });

  it("rate limit counter increments", async () => {
    const { store } = mk();
    expect(await store.incrementRateLimit("ratelimit:redeem:a", 60)).toBe(1);
    expect(await store.incrementRateLimit("ratelimit:redeem:a", 60)).toBe(2);
    expect(await checkRedeemRateLimit(store, "9.9.9.9")).toBe(true);
  });
});
