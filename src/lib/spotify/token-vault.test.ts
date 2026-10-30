import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDriverStore, UpstashDriverStore, type DriverStore } from "@/lib/driver";
import type { RedisLike } from "@/lib/driver/upstash-store";
import { decryptToken } from "./token-crypto";
import { OTHER_TEST_KEY, TEST_ENC_KEY, useTestTokenVault } from "./testing";
import {
  TokenVaultDisabledError,
  deleteSpotifyRefreshToken,
  loadSpotifyRefreshToken,
  saveSpotifyRefreshToken,
  tokenAad,
} from "./token-vault";

const A = "drv_" + "A".repeat(22);
const B = "drv_" + "B".repeat(22);
const RT = "AQD-plain_refresh.token-0123456789";
const P = "finn:development:";

let vault: Awaited<ReturnType<typeof useTestTokenVault>>;
beforeEach(async () => {
  vault = await useTestTokenVault(vi.stubEnv);
});
afterEach(() => {
  vault.restore();
  vi.unstubAllEnvs();
});

/** Redis double that records EVERY argument of EVERY write and read; asserts the plaintext never shows. */
function spyRedis() {
  const kv = new Map<string, string>();
  const seen: unknown[][] = [];
  const rec = <A extends unknown[], R>(op: string, fn: (...a: A) => R) => (...a: A): R => {
    seen.push([op, ...a]);
    return fn(...a);
  };
  const redis: RedisLike = {
    hgetall: async () => [],
    hset: async () => 1,
    sadd: async () => 1,
    smembers: async () => [],
    get: rec("get", async (k: string) => kv.get(k) ?? null),
    set: rec("set", async (k: string, v: string, o?: { ex: number }) => {
      void o;
      kv.set(k, v);
      return "OK";
    }),
    del: rec("del", async (...ks: string[]) => ks.filter((k) => kv.delete(k)).length),
    getdel: rec("getdel", async (k: string) => {
      const v = kv.get(k) ?? null;
      kv.delete(k);
      return v;
    }),
    eval: rec("eval", async () => 1),
  };
  return { redis, kv, seen };
}

describe("token vault", () => {
  it("never hands the plaintext to the store (spy on every write, Memory and Upstash-like)", async () => {
    const spy = spyRedis();
    const up = new UpstashDriverStore(spy.redis, P, Date.now);
    const mem = new MemoryDriverStore(P);
    const setMem = vi.spyOn(mem, "setSpotifyBlob");
    await saveSpotifyRefreshToken(A, RT, { store: up });
    await saveSpotifyRefreshToken(A, RT, { store: mem });
    expect(JSON.stringify(spy.seen)).not.toContain(RT);
    expect(JSON.stringify(setMem.mock.calls)).not.toContain(RT);
    expect([...spy.kv.values()][0]).toMatch(/^v1\./);
    expect(await loadSpotifyRefreshToken(A, { store: up })).toBe(RT);
    expect(await loadSpotifyRefreshToken(A, { store: mem })).toBe(RT);
  });

  it("the store itself refuses anything that is not an encrypted blob", async () => {
    for (const bad of [RT, "", "v1.a.b.c", "v1." + "A".repeat(16) + ".x." + "B".repeat(22)]) {
      await expect(new MemoryDriverStore(P).setSpotifyBlob(A, bad)).rejects.toThrow();
      const spy = spyRedis();
      await expect(new UpstashDriverStore(spy.redis, P).setSpotifyBlob(A, bad)).rejects.toThrow();
      expect(spy.seen).toEqual([]);
    }
  });

  it("the key is bound to the driver: a blob copied to another driver does not decrypt (reads as not connected)", async () => {
    await saveSpotifyRefreshToken(A, RT, { store: vault.store });
    const blob = (await vault.store.getSpotifyBlob(A)) as string;
    await vault.store.setSpotifyBlob(B, blob);
    expect(await loadSpotifyRefreshToken(B, { store: vault.store })).toBeNull();
    expect(await loadSpotifyRefreshToken(A, { store: vault.store })).toBe(RT);
    expect(decryptToken(blob, Buffer.from(TEST_ENC_KEY, "hex"), tokenAad(A))).toBe(RT);
  });

  it("the AAD carries the environment: a blob from preview does not decrypt in production", async () => {
    const preview = { FINN_TOKEN_ENC_KEY: TEST_ENC_KEY, VERCEL_ENV: "preview" };
    const production = { FINN_TOKEN_ENC_KEY: TEST_ENC_KEY, VERCEL_ENV: "production" };
    const store = new MemoryDriverStore("finn:preview:");
    await saveSpotifyRefreshToken(A, RT, { store, env: preview });
    expect(tokenAad(A, preview)).toBe(`finn:preview:spotify:${A}`);
    expect(await loadSpotifyRefreshToken(A, { store, env: production })).toBeNull();
    expect(await loadSpotifyRefreshToken(A, { store, env: preview })).toBe(RT);
  });

  it("a rotated key does not decrypt old blobs (not connected)", async () => {
    await saveSpotifyRefreshToken(A, RT, { store: vault.store });
    vi.stubEnv("FINN_TOKEN_ENC_KEY", OTHER_TEST_KEY);
    expect(await loadSpotifyRefreshToken(A, { store: vault.store })).toBeNull();
  });

  it("without a valid key nothing is written and nothing is read", async () => {
    const set = vi.spyOn(vault.store, "setSpotifyBlob");
    const get = vi.spyOn(vault.store, "getSpotifyBlob");
    for (const key of ["", "short", "a".repeat(64), process.env.FINN_SESSION_SECRET ?? ""]) {
      vi.stubEnv("FINN_TOKEN_ENC_KEY", key);
      await expect(saveSpotifyRefreshToken(A, RT, { store: vault.store })).rejects.toBeInstanceOf(TokenVaultDisabledError);
      await expect(loadSpotifyRefreshToken(A, { store: vault.store })).rejects.toBeInstanceOf(TokenVaultDisabledError);
    }
    expect(set).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("a key equal to another secret is rejected by the vault too", async () => {
    vi.stubEnv("FINN_SESSION_SECRET", TEST_ENC_KEY);
    await expect(saveSpotifyRefreshToken(A, RT, { store: vault.store })).rejects.toBeInstanceOf(TokenVaultDisabledError);
  });

  it("deleting is idempotent and works without the key", async () => {
    await saveSpotifyRefreshToken(A, RT, { store: vault.store });
    vi.stubEnv("FINN_TOKEN_ENC_KEY", "");
    await deleteSpotifyRefreshToken(A, { store: vault.store });
    await deleteSpotifyRefreshToken(A, { store: vault.store });
    expect(await vault.store.getSpotifyBlob(A)).toBeNull();
  });

  it("invalid driver ids are refused / read as absent", async () => {
    await expect(saveSpotifyRefreshToken("../x", RT, { store: vault.store })).rejects.toThrow();
    expect(await loadSpotifyRefreshToken("../x", { store: vault.store })).toBeNull();
    const down = { getSpotifyBlob: vi.fn() } as unknown as DriverStore;
    expect(await loadSpotifyRefreshToken("nope", { store: down })).toBeNull();
    expect(down.getSpotifyBlob).not.toHaveBeenCalled();
  });
});
