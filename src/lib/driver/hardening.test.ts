import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriverStoreUnavailableError,
  MemoryDriverStore,
  UpstashDriverStore,
  authenticateSession,
  checkRedeemRateLimit,
  createDriverStore,
  createRedisClient,
  getSessionSecret,
  hashInviteCode,
  isAcceptableSecret,
  keyPrefix,
  normalizeIpForRateLimit,
  redeemRateLimitKey,
  signSessionToken,
  verifySessionToken,
} from "./index";
import { REDEEM_SCRIPT, RATELIMIT_SCRIPT, REVOKE_SCRIPT, ROTATE_SCRIPT, hashToRecord } from "./upstash-store";
import { createHmac } from "node:crypto";

const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const PEPPER = "c2b7d95e01f84a36b9d0e7a15c4f8823e6a91b07d3f5c8e24a0b69d1f7c3e5a8";
const PEPPER2 = "17e4a9c06b3d85f2a0c9e1b74d6f3a58c0b2e7d91f46a3c85e0d7b29f1a4c6e3";
const T0 = 1_800_000_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const VALID_ID = "drv_" + "A".repeat(22);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Fake Upstash REST endpoint for the REAL SDK: speaks the real wire format
 * (POST body = command array, reply {result}), HGETALL as a flat array.
 */
function fakeUpstash(opts: { failWith?: { status: number; error: string }; hang?: boolean; evalResult?: unknown } = {}) {
  const hashes = new Map<string, Record<string, string>>();
  const counters = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  const commands: string[][] = [];
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const cmd = JSON.parse(init.body as string) as string[];
    commands.push(cmd);
    if (opts.hang) {
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    }
    if (opts.failWith) {
      return new Response(JSON.stringify({ error: opts.failWith.error }), { status: opts.failWith.status });
    }
    const reply = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
    const [op, ...rest] = cmd;
    switch (op.toLowerCase()) {
      case "hset": {
        const h = hashes.get(rest[0]) ?? {};
        for (let i = 1; i < rest.length; i += 2) h[rest[i]] = rest[i + 1];
        hashes.set(rest[0], h);
        return reply(1);
      }
      case "sadd": {
        sets.set(rest[0], (sets.get(rest[0]) ?? new Set()).add(rest[1]));
        return reply(1);
      }
      case "smembers":
        return reply([...(sets.get(rest[0]) ?? [])]);
      case "hgetall": {
        const h = hashes.get(rest[0]);
        return reply(h ? Object.entries(h).flat() : []);
      }
      case "eval": {
        if (opts.evalResult !== undefined) return reply(opts.evalResult);
        const [script, nk, ...more] = rest;
        const n = Number(nk);
        const ks = more.slice(0, n);
        const args = more.slice(n);
        if (script === REDEEM_SCRIPT) {
          const inv = hashes.get(ks[0]);
          if (!inv || inv.revoked === "1" || Number(inv.uses) >= Number(inv.maxUses) || Number(inv.expiresAt) <= Number(args[0])) {
            return reply([0]);
          }
          inv.uses = String(Number(inv.uses) + 1);
          hashes.set(ks[1], { driverId: args[1], label: inv.label, status: "active", tokenVersion: "1", createdAt: args[2] });
          sets.set(ks[2], (sets.get(ks[2]) ?? new Set()).add(args[1]));
          return reply([1, inv.label]);
        }
        if (script === REVOKE_SCRIPT) {
          const h = hashes.get(ks[0]);
          if (h) h[args[0]] = args[1];
          return reply(1);
        }
        if (script === ROTATE_SCRIPT) {
          const h = hashes.get(ks[0]);
          if (h && h.status === "active") {
            h.tokenVersion = String(Number(h.tokenVersion) + 1);
            return reply(1);
          }
          return reply(0);
        }
        if (script === RATELIMIT_SCRIPT) {
          const v = (counters.get(ks[0]) ?? 0) + 1;
          counters.set(ks[0], v);
          return reply(v);
        }
        return new Response(JSON.stringify({ error: "unknown script" }), { status: 400 });
      }
    }
    return new Response(JSON.stringify({ error: "unsupported" }), { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, hashes, commands, sets };
}

const P = keyPrefix("preview");
const real = (timeoutMs?: number) =>
  new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok-secret-xyz", timeoutMs), P, () => T0, PEPPER);

describe("real @upstash/redis SDK against a fake REST endpoint (no network)", () => {
  it("createDriver -> getDriver -> invite -> redeem -> auth works end to end", async () => {
    const { hashes, commands } = fakeUpstash();
    const store = real();
    const d = await store.createDriver({ label: "1e3" });
    expect(await store.getDriver(d.driverId)).toEqual(d);
    expect(await store.getDriver(VALID_ID)).toBeNull();

    const { code } = await store.createInvite({ label: "Carro", maxUses: 1, expiresAt: T0 + 60_000 });
    const [first, second] = await Promise.all([store.redeemInvite(code), store.redeemInvite(code)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const got = (first ?? second)!;
    expect(got.label).toBe("Carro");
    expect(await store.getDriver(got.driverId)).toEqual(got);

    const tok = signSessionToken({ driverId: got.driverId, tokenVersion: got.tokenVersion }, SECRET, T0);
    expect((await authenticateSession(tok, store, SECRET, T0))?.driverId).toBe(got.driverId);
    await store.revokeDriver(got.driverId);
    expect(await authenticateSession(tok, store, SECRET, T0)).toBeNull();

    expect(await store.redeemInvite(code)).toBeNull();
    expect(await store.incrementRateLimit("ratelimit:redeem:1.1.1.1", 60)).toBe(1);
    expect(await store.incrementRateLimit("ratelimit:redeem:1.1.1.1", 60)).toBe(2);
    // every redeem attempt is exactly one EVAL; every key sits under the env prefix; no clear code
    expect(commands.filter((c) => c[0] === "eval" && c[1] === REDEEM_SCRIPT)).toHaveLength(3);
    for (const k of hashes.keys()) expect(k.startsWith("finn:preview:")).toBe(true);
    expect(JSON.stringify(commands)).not.toContain(code);
    expect(JSON.stringify(commands)).toContain(hashInviteCode(code, PEPPER));
  });

  it("listDrivers through the real SDK: SMEMBERS + HGETALL, redeem feeds the index in the same EVAL", async () => {
    const { commands, sets } = fakeUpstash();
    const store = real();
    const a = await store.createDriver({ label: "A" });
    const { code } = await store.createInvite({ label: "B", maxUses: 1, expiresAt: T0 + 60_000 });
    const b = (await store.redeemInvite(code))!;
    expect([...sets.get("finn:preview:drivers")!].sort()).toEqual([a.driverId, b.driverId].sort());
    const redeem = commands.find((c) => c[0] === "eval" && c[1] === REDEEM_SCRIPT)!;
    expect(redeem[2]).toBe(3);
    expect(redeem[5]).toBe("finn:preview:drivers");
    expect(REDEEM_SCRIPT).toContain("SADD");
    await store.revokeDriver(b.driverId);
    const list = await store.listDrivers();
    expect(list.map((d) => [d.driverId, d.label, d.status])).toEqual([
      [a.driverId, "A", "active"],
      [b.driverId, "B", "revoked"],
    ]);
    expect(JSON.stringify(list)).not.toContain(code);
  });

  it("listDrivers fails closed on a malformed SMEMBERS reply and on SDK errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "oops" }), { status: 200 })));
    await expect(real().listDrivers()).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    fakeUpstash({ failWith: { status: 500, error: "boom" } });
    await expect(real().listDrivers()).rejects.toBeInstanceOf(DriverStoreUnavailableError);
  });

  it("does not send telemetry headers and makes exactly one attempt per command", async () => {
    const { fetchMock } = fakeUpstash({ failWith: { status: 503, error: "down" } });
    await expect(real().getDriver(VALID_ID)).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => h.toLowerCase().startsWith("upstash-telemetry"))).toBe(false);
  });

  it("network failure on redeem is not retried (cannot burn an invite use)", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", f);
    await expect(real().redeemInvite("FINN-ABCD-EFGH")).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("SDK HTTP errors never leak command, key, hash, token or driverId", async () => {
    fakeUpstash({ failWith: { status: 400, error: "ERR WRONGTYPE" } });
    const store = real();
    const code = "FINN-ABCD-EFGH";
    const errs: Error[] = [];
    for (const p of [
      store.getDriver(VALID_ID),
      store.redeemInvite(code),
      store.revokeDriver(VALID_ID),
      store.incrementRateLimit("ratelimit:redeem:9.9.9.9", 60),
      store.createDriver({ label: "A" }),
    ]) {
      await p.then(
        () => expect.unreachable(),
        (e) => errs.push(e),
      );
    }
    for (const e of errs) {
      expect(e).toBeInstanceOf(DriverStoreUnavailableError);
      const dump = `${e.message} ${e.stack} ${String(e.cause)} ${JSON.stringify(e)}`;
      for (const secret of ["command was", "finn:preview", hashInviteCode(code, PEPPER), code, "tok-secret-xyz", VALID_ID, "9.9.9.9", "WRONGTYPE", "invite:", "driver:"]) {
        expect(dump).not.toContain(secret);
      }
      expect(e.cause).toBeUndefined();
    }
  });

  it("a hung Redis fails inside the timeout", async () => {
    const { fetchMock } = fakeUpstash({ hang: true });
    const store = real(40);
    const t = Date.now();
    await expect(store.getDriver(VALID_ID)).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    await expect(store.redeemInvite("FINN-ABCD-EFGH")).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("null / non-numeric / malformed replies fail closed (never 'zero hits' or 'redeemed')", async () => {
    for (const evalResult of [null, "OK", 0, -1, 1.5, [], [2], [1]]) {
      fakeUpstash({ evalResult });
      const store = real();
      await expect(store.incrementRateLimit("ratelimit:redeem:a", 60)).rejects.toBeInstanceOf(DriverStoreUnavailableError);
      if (evalResult !== 0 && !(Array.isArray(evalResult) && evalResult[0] === 0)) {
        await expect(store.redeemInvite("FINN-ABCD-EFGH")).rejects.toBeInstanceOf(DriverStoreUnavailableError);
      }
    }
    await expect(
      (async () => {
        fakeUpstash({ evalResult: null });
        return checkRedeemRateLimit(real(), "1.2.3.4");
      })(),
    ).rejects.toBeInstanceOf(DriverStoreUnavailableError);
  });

  it("rejects bad timeout values", () => {
    expect(() => createRedisClient("https://x.example", "t", 0)).toThrow();
    expect(() => createRedisClient("https://x.example", "t", 1.5)).toThrow();
  });
});

describe("hashToRecord", () => {
  it("accepts flat arrays and objects, rejects odd/garbage", () => {
    expect(hashToRecord(["a", "1", "b", "x"])).toEqual({ a: "1", b: "x" });
    expect(hashToRecord({ a: 1, b: "x" })).toEqual({ a: "1", b: "x" });
    expect(hashToRecord([])).toBeNull();
    expect(hashToRecord(null)).toBeNull();
    expect(() => hashToRecord(["a"])).toThrow(DriverStoreUnavailableError);
    expect(() => hashToRecord("str")).toThrow(DriverStoreUnavailableError);
    expect(() => hashToRecord([1, 2])).toThrow(DriverStoreUnavailableError);
  });
  it("getDriver returns null when the stored driverId differs from the key", async () => {
    const { hashes } = fakeUpstash();
    const store = real();
    const d = await store.createDriver({ label: "A" });
    const other = "drv_" + "B".repeat(22);
    hashes.set(`${P}driver:${other}`, { ...hashes.get(`${P}driver:${d.driverId}`)! });
    expect(await store.getDriver(other)).toBeNull();
  });
});

describe("rate limit validation and keys", () => {
  it.each([0, -1, 1.5, NaN, Infinity, 86_401])("windowSeconds %s throws (memory and upstash)", async (w) => {
    fakeUpstash();
    await expect(new MemoryDriverStore(P, () => T0, PEPPER).incrementRateLimit("ratelimit:redeem:a", w)).rejects.toThrow();
    await expect(real().incrementRateLimit("ratelimit:redeem:a", w)).rejects.toThrow();
  });
  it("only ratelimit: keys with restricted charset", async () => {
    fakeUpstash();
    for (const k of ["driver:abc", "ratelimit:", "ratelimit:a b", "ratelimit:a\n", "x:ratelimit:a", "ratelimit:" + "a".repeat(101)]) {
      await expect(new MemoryDriverStore(P, () => T0, PEPPER).incrementRateLimit(k, 60)).rejects.toThrow();
      await expect(real().incrementRateLimit(k, 60)).rejects.toThrow();
    }
  });
  it("normalizes IPs: IPv6 to /64, mapped v4, missing/garbage to noip bucket", () => {
    expect(redeemRateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(redeemRateLimitKey("2001:db8:1:2::1"));
    expect(redeemRateLimitKey("2001:db8:1:3::1")).not.toBe(redeemRateLimitKey("2001:db8:1:2::1"));
    expect(redeemRateLimitKey("::ffff:1.2.3.4")).toBe(redeemRateLimitKey("1.2.3.4"));
    expect(redeemRateLimitKey("::1")).toBe("ratelimit:redeem:v6-0-0-0-0");
    for (const bad of [undefined, null, "", "  ", "unknown", "1.2.3.4, 5.6.7.8", "evil:../driver", "999.1.1.1"]) {
      expect(redeemRateLimitKey(bad)).toBe("ratelimit:redeem:noip");
      expect(normalizeIpForRateLimit(bad).known).toBe(false);
    }
  });
  it("no-IP bucket is small (3)", async () => {
    const store = new MemoryDriverStore(P, () => T0, PEPPER);
    const r: boolean[] = [];
    for (let i = 0; i < 5; i++) r.push(await checkRedeemRateLimit(store, undefined));
    expect(r.filter(Boolean)).toHaveLength(3);
  });
});

describe("input validation (memory and upstash)", () => {
  const stores = () => {
    fakeUpstash();
    return [new MemoryDriverStore(P, () => T0, PEPPER), real()];
  };
  it("labels: trimmed, 1..64, no control chars", async () => {
    for (const s of stores()) {
      expect((await s.createDriver({ label: "  Joao  " })).label).toBe("Joao");
      for (const label of ["", "   ", "a".repeat(65), "a\nb", "a\u0000b", "\u001b[31mred", "a\u0085b"]) {
        await expect(s.createDriver({ label })).rejects.toThrow();
        await expect(s.createInvite({ label, maxUses: 1, expiresAt: T0 + 1000 })).rejects.toThrow();
      }
    }
  });
  it("maxUses 1..1000 integer; expiresAt future ms within 1 year", async () => {
    const year = 365 * 24 * 3600 * 1000;
    for (const s of stores()) {
      for (const maxUses of [0, 1001, 1.5, NaN, Infinity]) {
        await expect(s.createInvite({ label: "a", maxUses, expiresAt: T0 + 1000 })).rejects.toThrow();
      }
      for (const expiresAt of [T0, T0 - 1, NaN, Infinity, T0 + year + 1, Math.floor(T0 / 1000) + 5]) {
        await expect(s.createInvite({ label: "a", maxUses: 1, expiresAt })).rejects.toThrow();
      }
      await expect(s.createInvite({ label: "a", maxUses: 1000, expiresAt: T0 + year })).resolves.toBeDefined();
    }
  });
});

describe("session token hardening", () => {
  const mk = (p: unknown, secret = SECRET) => {
    const head = `v1.${b64(p)}`;
    return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
  };
  const now = Math.floor(T0 / 1000);
  const good = { sub: VALID_ID, iat: now, exp: now + 1000, tv: 1 };

  it("accepts a well-formed payload (control)", () => {
    expect(verifySessionToken(mk(good), SECRET, T0)).not.toBeNull();
  });
  it("rejects non-canonical base64url on signature and body", () => {
    const tok = mk(good);
    const [v, body, sig] = tok.split(".");
    for (const t of [`${tok}=`, `${v}.${body}.${sig}=`, `${v}.${body}.${sig} `, `${v}.${body}.${sig}\n`, `${v}.${body}=.${sig}`, `${v}.${body}!.${sig}`]) {
      expect(verifySessionToken(t, SECRET, T0)).toBeNull();
    }
    // last char variant of the signature (non-canonical trailing bits)
    const variants = ["A", "B", "C", "D"].map((c) => `${v}.${body}.${sig.slice(0, -1)}${c}`).filter((t) => t !== tok);
    for (const t of variants) expect(verifySessionToken(t, SECRET, T0)).toBeNull();
  });
  it("rejects bad tv / iat / exp", () => {
    for (const p of [
      { ...good, tv: -1 },
      { ...good, tv: 1.5 },
      { ...good, tv: Number.MAX_SAFE_INTEGER + 2 },
      { ...good, iat: now + 3600 },
      { ...good, exp: now + 90 * 86400 + 1 + 0, iat: now },
      { ...good, exp: now },
      { ...good, iat: "1" },
      { ...good, exp: null },
    ]) {
      expect(verifySessionToken(mk(p), SECRET, T0)).toBeNull();
    }
    expect(verifySessionToken(mk({ ...good, iat: now + 30 }), SECRET, T0)).not.toBeNull();
    expect(verifySessionToken(mk({ ...good, tv: 0 }), SECRET, T0)).not.toBeNull();
  });
  it("sign validates tokenVersion and clock", () => {
    for (const tokenVersion of [NaN, 1.5, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => signSessionToken({ driverId: VALID_ID, tokenVersion }, SECRET, T0)).toThrow();
    }
    expect(() => signSessionToken({ driverId: VALID_ID, tokenVersion: 1 }, SECRET, NaN)).toThrow();
  });
  it("secret rule: 64 hex with >= 8 distinct chars", () => {
    expect(isAcceptableSecret(SECRET)).toBe(true);
    for (const s of ["a".repeat(64), "ab".repeat(32), " ".repeat(64), "z".repeat(64), "a".repeat(32), SECRET + "0", SECRET.slice(1), "", undefined]) {
      expect(isAcceptableSecret(s)).toBe(false);
    }
    vi.stubEnv("FINN_SESSION_SECRET", "a".repeat(64));
    expect(() => getSessionSecret()).toThrow();
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    expect(getSessionSecret()).toBe(SECRET);
  });
  it("authenticateSession rejects a driver whose stored id differs from sub", async () => {
    const store = new MemoryDriverStore(P, () => T0, PEPPER);
    const d = await store.createDriver({ label: "A" });
    const tok = signSessionToken({ driverId: d.driverId, tokenVersion: 1 }, SECRET, T0);
    const liar = { ...store, getDriver: async () => ({ ...d, driverId: "drv_" + "C".repeat(22) }) } as unknown as MemoryDriverStore;
    expect(await authenticateSession(tok, liar, SECRET, T0)).toBeNull();
  });
});

describe("store selection", () => {
  it("NODE_ENV=production is never relaxed, even with VERCEL_ENV development/test", () => {
    for (const VERCEL_ENV of ["development", "test", undefined]) {
      expect(() => createDriverStore({ VERCEL_ENV, NODE_ENV: "production" })).toThrow(/not configured/);
    }
    expect(createDriverStore({ VERCEL_ENV: "development", NODE_ENV: "development" })).toBeInstanceOf(MemoryDriverStore);
  });
  it("getDriverStore is a singleton and fails closed in production without KV", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    const mod = await import("./index");
    expect(mod.getDriverStore()).toBe(mod.getDriverStore());
    expect(mod.getDriverStore()).toBeInstanceOf(mod.MemoryDriverStore);

    vi.resetModules();
    vi.stubEnv("VERCEL_ENV", "production");
    const prod = await import("./index");
    expect(() => prod.getDriverStore()).toThrow(/not configured/);
    expect(() => prod.getDriverStore()).toThrow(/not configured/); // failure is not cached as success
  });
});

describe("invite pepper", () => {
  const memory = (pepper?: string) => new MemoryDriverStore(P, () => T0, pepper);

  it("keys are HMAC(pepper, code): never the clear code nor plain sha256, in both stores", async () => {
    const { createHash } = await import("node:crypto");
    const { hashes, commands } = fakeUpstash();
    const store = real();
    const { code } = await store.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 });
    const plain = createHash("sha256").update(code).digest("hex");
    const dump = JSON.stringify([[...hashes.entries()], commands]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(plain);
    expect(dump).toContain(hashInviteCode(code, PEPPER));
    const mem = memory(PEPPER);
    const m = await mem.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 });
    const keysDump = JSON.stringify(mem.allKeys());
    expect(keysDump).not.toContain(m.code);
    expect(keysDump).not.toContain(createHash("sha256").update(m.code).digest("hex"));
    expect(keysDump).toContain(hashInviteCode(m.code, PEPPER));
  });

  it("different peppers give different keys; redeem under another pepper is null like unknown", async () => {
    expect(hashInviteCode("FINN-ABCD-EFGH", PEPPER)).not.toBe(hashInviteCode("FINN-ABCD-EFGH", PEPPER2));
    const a = memory(PEPPER);
    const { code } = await a.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 });
    expect(await memory(PEPPER2).redeemInvite(code)).toBeNull();

    fakeUpstash();
    const up = (p: string) => new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "t"), P, () => T0, p);
    const up1 = up(PEPPER);
    const c2 = await up1.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 });
    expect(await up(PEPPER2).redeemInvite(c2.code)).toBeNull();
    expect(await up1.redeemInvite(c2.code)).not.toBeNull();
  });

  it("pepper format, independence from session secret, and fail closed when missing", async () => {
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    expect(() => memory(SECRET)).toThrow(/differ/);
    expect(() => memory("a".repeat(64))).toThrow();
    expect(() => memory("short")).toThrow();
    expect(() => hashInviteCode("FINN-ABCD-EFGH", "x")).toThrow();
    // lazy env: missing pepper only fails when an invite operation runs
    vi.stubEnv("FINN_INVITE_PEPPER", "");
    const lazy = memory();
    await expect(lazy.createDriver({ label: "ok" })).resolves.toBeDefined();
    await expect(lazy.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 })).rejects.toThrow(/FINN_INVITE_PEPPER/);
    await expect(lazy.redeemInvite("FINN-ABCD-EFGH")).rejects.toThrow();
    vi.stubEnv("FINN_INVITE_PEPPER", SECRET);
    await expect(lazy.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 })).rejects.toThrow(/differ/);
    vi.stubEnv("FINN_INVITE_PEPPER", PEPPER);
    await expect(lazy.createInvite({ label: "A", maxUses: 1, expiresAt: T0 + 1000 })).resolves.toBeDefined();
  });

  it("errors never contain the pepper or secret values", () => {
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    for (const bad of [SECRET, "zz"]) {
      try {
        hashInviteCode("FINN-ABCD-EFGH", bad);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(SECRET);
      }
    }
  });
});

describe("rotateSessions", () => {
  const kinds = () => {
    fakeUpstash();
    return { memory: new MemoryDriverStore(P, () => T0, PEPPER), sdk: real() };
  };

  it.each(["memory", "sdk"] as const)("%s: old token fails, new passes, driver stays active", async (kind) => {
    const s = kinds()[kind];
    const d = await s.createDriver({ label: "A" });
    const old = signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SECRET, T0);
    expect(await authenticateSession(old, s, SECRET, T0)).not.toBeNull();
    await s.rotateSessions(d.driverId);
    expect(await authenticateSession(old, s, SECRET, T0)).toBeNull();
    const after = (await s.getDriver(d.driverId))!;
    expect(after.status).toBe("active");
    expect(after.tokenVersion).toBe(d.tokenVersion + 1);
    const fresh = signSessionToken({ driverId: d.driverId, tokenVersion: after.tokenVersion }, SECRET, T0);
    expect((await authenticateSession(fresh, s, SECRET, T0))?.driverId).toBe(d.driverId);
  });

  it.each(["memory", "sdk"] as const)("%s: concurrent rotates lose no increments", async (kind) => {
    const s = kinds()[kind];
    const d = await s.createDriver({ label: "A" });
    await Promise.all(Array.from({ length: 25 }, () => s.rotateSessions(d.driverId)));
    expect((await s.getDriver(d.driverId))?.tokenVersion).toBe(d.tokenVersion + 25);
  });

  it.each(["memory", "sdk"] as const)("%s: revoked/unknown/invalid ids change and create nothing; A x B isolated", async (kind) => {
    const k = kinds();
    const s = k[kind];
    const a = await s.createDriver({ label: "A" });
    const b = await s.createDriver({ label: "B" });
    await s.rotateSessions(a.driverId);
    expect((await s.getDriver(b.driverId))?.tokenVersion).toBe(b.tokenVersion);
    await s.revokeDriver(b.driverId);
    await s.rotateSessions(b.driverId);
    expect((await s.getDriver(b.driverId))?.tokenVersion).toBe(b.tokenVersion);
    const ghost = "drv_" + "Q".repeat(22);
    await s.rotateSessions(ghost);
    await s.rotateSessions("../x");
    expect(await s.getDriver(ghost)).toBeNull();
    if (kind === "memory") expect((s as MemoryDriverStore).allKeys().filter((x) => x.includes(ghost))).toHaveLength(0);
  });

  it("sdk: no phantom hash and generic error on redis failure / bad reply", async () => {
    const { hashes } = fakeUpstash();
    const s = real();
    await s.rotateSessions("drv_" + "Q".repeat(22));
    expect(hashes.size).toBe(0);
    fakeUpstash({ evalResult: null });
    await expect(real().rotateSessions(VALID_ID)).rejects.toBeInstanceOf(DriverStoreUnavailableError);
    fakeUpstash({ failWith: { status: 500, error: "x" } });
    await expect(real().rotateSessions(VALID_ID)).rejects.toBeInstanceOf(DriverStoreUnavailableError);
  });
});
