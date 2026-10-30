import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DriverStoreUnavailableError,
  MemoryDriverStore,
  OAUTH_STATE_TTL_SECONDS,
  UpstashDriverStore,
  createRedisClient,
  keyPrefix,
  type DriverStore,
} from "./index";
import { UNLINK_SCRIPT } from "./upstash-store";
import { encryptToken } from "../spotify/token-crypto";
import { TEST_ENC_KEY } from "../spotify/testing";

const A = "drv_" + "A".repeat(22);
const B = "drv_" + "B".repeat(22);
const P = keyPrefix("preview");
const blobFor = (id: string) => encryptToken("rt-" + id, Buffer.from(TEST_ENC_KEY, "hex"), `${P}spotify:${id}`);

afterEach(() => vi.unstubAllGlobals());

/** Fake Upstash REST (real SDK on top): strings with TTL (virtual clock), GETDEL, DEL, SET EX, EVAL for revoke. */
function fakeUpstash(clock: { t: number }, opts: { failEval?: boolean } = {}) {
  const kv = new Map<string, { v: string; exp?: number }>();
  const hashes = new Map<string, Record<string, string>>();
  const commands: string[][] = [];
  const live = (k: string) => {
    const e = kv.get(k);
    if (e && e.exp !== undefined && e.exp <= clock.t) kv.delete(k);
    return kv.get(k);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: unknown, init: RequestInit) => {
      const cmd = (JSON.parse(init.body as string) as unknown[]).map(String); // the SDK sends `ex` as a number
      commands.push(cmd);
      const [op, ...r] = cmd;
      const reply = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
      switch (op.toLowerCase()) {
        case "set": {
          const flags = r.slice(2).map((x) => x.toUpperCase());
          if (flags.includes("NX") && live(r[0])) return reply(null);
          if (flags.includes("XX") && !live(r[0])) return reply(null);
          const exI = flags.indexOf("EX");
          kv.set(r[0], { v: r[1], exp: exI >= 0 ? clock.t + Number(flags[exI + 1]) * 1000 : undefined });
          return reply("OK");
        }
        case "sadd":
          return reply(1);
        case "hset": {
          const h = hashes.get(r[0]) ?? {};
          for (let i = 1; i < r.length; i += 2) h[r[i]] = r[i + 1];
          hashes.set(r[0], h);
          return reply(1);
        }
        case "get":
          return reply(live(r[0])?.v ?? null);
        case "getdel": {
          const e = live(r[0]);
          kv.delete(r[0]);
          return reply(e?.v ?? null);
        }
        case "del": {
          let n = 0;
          for (const k of r) if (kv.delete(k)) n++;
          return reply(n);
        }
        case "eval": {
          if (opts.failEval && r[0] === UNLINK_SCRIPT) return new Response(JSON.stringify({ error: "ERR boom" }), { status: 500 });
          if (r[0] === UNLINK_SCRIPT) {
            const e = live(r[2]);
            if (e && e.v === r[3]) {
              kv.delete(r[2]);
              return reply(1);
            }
            return reply(0);
          }
          const n = Number(r[1]);
          const h = hashes.get(r[2]);
          if (n === 1 && h) h[r[2 + n]] = r[3 + n];
          return reply(h ? 1 : 0);
        }
      }
      return new Response(JSON.stringify({ error: "unsupported" }), { status: 400 });
    }),
  );
  return { kv, hashes, commands };
}

type Setup = { name: string; make: () => { store: DriverStore; clock: { t: number }; has: (key: string) => boolean; commands?: string[][] } };
const setups: Setup[] = [
  {
    name: "memory",
    make: () => {
      const clock = { t: 1_000_000 };
      const store = new MemoryDriverStore(P, () => clock.t);
      return { store, clock, has: (k) => store.allKeys().includes(k) };
    },
  },
  {
    name: "upstash (real SDK, fake REST)",
    make: () => {
      const clock = { t: 1_000_000 };
      const f = fakeUpstash(clock);
      const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
      return { store, clock, has: (k) => f.kv.has(k), commands: f.commands };
    },
  },
];

describe.each(setups)("oauth state and token blobs: $name", ({ make }) => {
  it("state: create then consume gives the driverId of the server record; second use fails", async () => {
    const { store } = make();
    const state = await store.createOAuthState(A);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.consumeOAuthState(state)).toBe(A);
    expect(await store.consumeOAuthState(state)).toBeNull();
  });

  it("state: unknown, malformed and wrong-length values fail (malformed ones never reach Redis)", async () => {
    const { store, commands } = make();
    expect(await store.consumeOAuthState("A".repeat(43))).toBeNull();
    const before = commands?.length ?? 0;
    for (const bad of ["", "x", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + ".", A, null as unknown as string]) {
      expect(await store.consumeOAuthState(bad)).toBeNull();
    }
    if (commands) expect(commands.length).toBe(before);
  });

  it("state: expires after 600 s", async () => {
    const { store, clock } = make();
    const s1 = await store.createOAuthState(A);
    clock.t += (OAUTH_STATE_TTL_SECONDS - 1) * 1000;
    expect(await store.consumeOAuthState(s1)).toBe(A);
    const s2 = await store.createOAuthState(A);
    clock.t += (OAUTH_STATE_TTL_SECONDS + 1) * 1000;
    expect(await store.consumeOAuthState(s2)).toBeNull();
  });

  it("state: atomic single use under a race, one winner out of many", async () => {
    const { store } = make();
    const state = await store.createOAuthState(A);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.consumeOAuthState(state)));
    expect(results.filter((r) => r === A)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(11);
  });

  it("state: each state is bound to its own driver", async () => {
    const { store } = make();
    const [sa, sb] = [await store.createOAuthState(A), await store.createOAuthState(B)];
    expect(sa).not.toBe(sb);
    expect(await store.consumeOAuthState(sb)).toBe(B);
    expect(await store.consumeOAuthState(sa)).toBe(A);
  });

  it("blob: set/get/delete per driver, isolated, idempotent delete", async () => {
    const { store } = make();
    await store.setSpotifyBlob(A, blobFor(A));
    expect(await store.getSpotifyBlob(B)).toBeNull();
    expect(await store.getSpotifyBlob(A)).toMatch(/^v1\./);
    await store.setSpotifyBlob(B, blobFor(B));
    await store.deleteSpotifyBlob(A);
    await store.deleteSpotifyBlob(A);
    expect(await store.getSpotifyBlob(A)).toBeNull();
    expect(await store.getSpotifyBlob(B)).not.toBeNull();
  });

  it("rotated blob: only replaces an existing one (XX); a missing blob stays missing", async () => {
    const { store } = make();
    expect(await store.setSpotifyBlobIfExists(A, blobFor(A))).toBe(false);
    expect(await store.getSpotifyBlob(A)).toBeNull();
    expect(await store.hasSpotifyBlob(A)).toBe(false);
    await store.setSpotifyBlob(A, blobFor(A));
    const rotated = blobFor(A);
    expect(await store.setSpotifyBlobIfExists(A, rotated)).toBe(true);
    expect(await store.getSpotifyBlob(A)).toBe(rotated);
    expect(await store.hasSpotifyBlob(A)).toBe(true);
    await store.deleteSpotifyBlob(A);
    expect(await store.setSpotifyBlobIfExists(A, blobFor(A))).toBe(false);
    expect(await store.getSpotifyBlob(A)).toBeNull();
    await expect(store.setSpotifyBlobIfExists(A, "plain-token")).rejects.toThrow();
  });

  it("account link: NX for a new account, ok for the same driver, conflict for another (nothing changes)", async () => {
    const { store } = make();
    expect(await store.linkSpotifyAccount(A, "acc-1")).toBe("linked");
    expect(await store.linkSpotifyAccount(A, "acc-1")).toBe("linked");
    expect(await store.linkSpotifyAccount(B, "acc-1")).toBe("conflict");
    expect(await store.getLinkedDriver("acc-1")).toBe(A);
    expect(await store.linkSpotifyAccount(B, "acc-2")).toBe("linked");
    expect(await store.getLinkedDriver("acc-2")).toBe(B);
    expect(await store.getLinkedDriver("nobody")).toBeNull();
    expect(await store.getLinkedDriver("../x")).toBeNull();
    await expect(store.linkSpotifyAccount(A, "UPPER")).rejects.toThrow();
    await expect(store.linkSpotifyAccount("bad", "acc-3")).rejects.toThrow();
  });

  it("account link: a changed account releases only that driver's previous link; delete/purge release the current one, never another driver's", async () => {
    const { store } = make();
    await store.linkSpotifyAccount(A, "acc-a1");
    await store.linkSpotifyAccount(B, "acc-b");
    await store.linkSpotifyAccount(A, "acc-a2");
    expect(await store.getLinkedDriver("acc-a1")).toBeNull();
    expect(await store.getLinkedDriver("acc-a2")).toBe(A);
    await store.deleteSpotifyBlob(A);
    expect(await store.getLinkedDriver("acc-a2")).toBeNull();
    expect(await store.getLinkedDriver("acc-b")).toBe(B);
    await store.linkSpotifyAccount(A, "acc-a3");
    await store.purgeDriverData(A);
    expect(await store.getLinkedDriver("acc-a3")).toBeNull();
    // stale pointer: B takes acc-a4 after A released it; A's later cleanup must not touch it
    await store.linkSpotifyAccount(A, "acc-a4");
    await store.deleteSpotifyBlob(A);
    await store.linkSpotifyAccount(B, "acc-a4");
    await store.deleteSpotifyBlob(A);
    expect(await store.getLinkedDriver("acc-a4")).toBe(B);
  });

  it("revokeDriver releases the account link too", async () => {
    const { store } = make();
    const a = await store.createDriver({ label: "A" });
    await store.linkSpotifyAccount(a.driverId, "acc-r");
    await store.revokeDriver(a.driverId);
    expect(await store.getLinkedDriver("acc-r")).toBeNull();
  });

  it("revokeDriver deletes the driver's blob and only theirs", async () => {
    const { store } = make();
    const a = await store.createDriver({ label: "A" });
    const b = await store.createDriver({ label: "B" });
    await store.setSpotifyBlob(a.driverId, blobFor(a.driverId));
    await store.setSpotifyBlob(b.driverId, blobFor(b.driverId));
    await store.revokeDriver(a.driverId);
    expect(await store.getSpotifyBlob(a.driverId)).toBeNull();
    expect(await store.getSpotifyBlob(b.driverId)).not.toBeNull();
  });

  it("purgeDriverData removes the blob, leaves other drivers alone, is idempotent", async () => {
    const { store } = make();
    await store.setSpotifyBlob(A, blobFor(A));
    await store.setSpotifyBlob(B, blobFor(B));
    await store.purgeDriverData(A);
    await store.purgeDriverData(A);
    await store.purgeDriverData("not-an-id");
    expect(await store.getSpotifyBlob(A)).toBeNull();
    expect(await store.getSpotifyBlob(B)).not.toBeNull();
  });
});

describe("upstash specifics (wire level)", () => {
  it("state is stored under sha256(state) with TTL 600, consumed with GETDEL, and the raw state is never sent to Redis", async () => {
    const clock = { t: 1_000_000 };
    const f = fakeUpstash(clock);
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
    const state = await store.createOAuthState(A);
    const key = `${P}oauth-state:${createHash("sha256").update(state).digest("hex")}`;
    const set = f.commands.find((c) => c[0].toLowerCase() === "set");
    expect(set?.[1]).toBe(key);
    expect(JSON.parse(set?.[2] ?? "{}")).toMatchObject({ driverId: A });
    const exAt = (set ?? []).findIndex((x) => x.toUpperCase() === "EX");
    expect(exAt).toBeGreaterThan(0);
    expect(set?.[exAt + 1]).toBe("600");
    await store.consumeOAuthState(state);
    const ops = f.commands.map((c) => c[0].toLowerCase());
    expect(ops).toEqual(["set", "getdel"]); // one atomic command, never get + del
    expect(JSON.stringify(f.commands)).not.toContain(state);
  });

  it("wire: the rotated write is SET ... XX and the account link is SET ... NX (never a plain SET on the index)", async () => {
    const clock = { t: 1_000_000 };
    const f = fakeUpstash(clock);
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
    await store.setSpotifyBlob(A, blobFor(A));
    f.commands.length = 0;
    await store.setSpotifyBlobIfExists(A, blobFor(A));
    expect(f.commands[0][0].toLowerCase()).toBe("set");
    expect(f.commands[0].slice(3).map((x) => x.toUpperCase())).toEqual(["XX"]);
    f.commands.length = 0;
    await store.linkSpotifyAccount(A, "acc-wire");
    const idxSet = f.commands.find((c) => c[1] === `${P}spotify-index:acc-wire`);
    expect(idxSet?.slice(3).map((x) => x.toUpperCase())).toEqual(["NX"]);
    expect(f.commands.filter((c) => c[1] === `${P}spotify-index:acc-wire` && c[0].toLowerCase() === "set")).toHaveLength(1);
  });

  it("a failing release of the account link never keeps the token: blob first, then the link; the error stays generic and a retry finishes", async () => {
    for (const how of ["delete", "purge", "revoke"] as const) {
      const clock = { t: 1_000_000 };
      const f = fakeUpstash(clock, { failEval: true });
      const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
      f.kv.set(`${P}spotify:${A}`, { v: blobFor(A) });
      f.kv.set(`${P}spotify-account:${A}`, { v: "acc-keep" });
      f.kv.set(`${P}spotify-index:acc-keep`, { v: A });
      const op = () => (how === "delete" ? store.deleteSpotifyBlob(A) : how === "purge" ? store.purgeDriverData(A) : store.revokeDriver(A));
      const err = await op().catch((e: unknown) => e);
      expect(f.kv.has(`${P}spotify:${A}`), how).toBe(false); // the token is gone although the release failed
      if (how !== "revoke") expect(err).toBeInstanceOf(DriverStoreUnavailableError);
      if (err instanceof Error) expect(err.message + String(err.cause ?? "")).not.toMatch(/boom|ERR/);
      expect(f.kv.has(`${P}spotify-account:${A}`)).toBe(true); // pointer kept, so the release can be retried
    }
  });

  it("release goes through the compare-and-delete script with the driver as ARGV: a stale pointer never frees another driver's link", async () => {
    const clock = { t: 1_000_000 };
    const f = fakeUpstash(clock);
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
    f.kv.set(`${P}spotify-account:${A}`, { v: "acc-stale" }); // A's pointer survived a crash...
    f.kv.set(`${P}spotify-index:acc-stale`, { v: B }); // ...but the account now belongs to B
    f.commands.length = 0;
    await store.deleteSpotifyBlob(A);
    const ev = f.commands.find((c) => c[0].toLowerCase() === "eval");
    expect(ev?.slice(1)).toEqual([UNLINK_SCRIPT, "1", `${P}spotify-index:acc-stale`, A]);
    expect(f.kv.get(`${P}spotify-index:acc-stale`)?.v).toBe(B);
    expect(f.kv.has(`${P}spotify-account:${A}`)).toBe(false);
  });

  it("a record older than the TTL is refused even if Redis kept it (defense in depth)", async () => {
    const clock = { t: 1_000_000 };
    const f = fakeUpstash(clock);
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
    const state = await store.createOAuthState(A);
    for (const e of f.kv.values()) delete e.exp; // the key "lost" its TTL
    clock.t += 700_000;
    expect(await store.consumeOAuthState(state)).toBeNull();
  });

  it("corrupt state records and unexpected reply types fail closed", async () => {
    const clock = { t: 1_000_000 };
    const f = fakeUpstash(clock);
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
    const state = await store.createOAuthState(A);
    for (const [k] of f.kv) f.kv.set(k, { v: JSON.stringify({ driverId: "../evil", createdAt: clock.t }) });
    expect(await store.consumeOAuthState(state)).toBeNull();
  });

  it("Redis down: generic error, nothing of the SDK in it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "ERR secret-detail" }), { status: 500 })));
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok-secret"), P);
    for (const op of [() => store.createOAuthState(A), () => store.consumeOAuthState("A".repeat(43)), () => store.getSpotifyBlob(A), () => store.setSpotifyBlob(A, blobFor(A)), () => store.deleteSpotifyBlob(A), () => store.purgeDriverData(A)]) {
      const err = await op().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverStoreUnavailableError);
      expect(String((err as Error).message) + String((err as Error).cause ?? "")).not.toMatch(/secret/);
    }
  });

  it("purgeDriverData deletes spotify:<id>, driver-addr:<id> and the account pointer of that driver only", async () => {
    const clock = { t: 1 };
    const f = fakeUpstash(clock);
    const store = new UpstashDriverStore(createRedisClient("https://fake.upstash.example", "tok"), P, () => clock.t);
    await store.purgeDriverData(A);
    expect(f.commands).toEqual([
      ["del", `${P}spotify:${A}`, `${P}driver-addr:${A}`], // the token and addresses go first
      ["get", `${P}spotify-account:${A}`], // no linked account: nothing to release
      ["del", `${P}spotify-account:${A}`],
    ]);
  });
});
