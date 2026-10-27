import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriverStoreUnavailableError } from "@/lib/driver/store";
import {
  getAddressBook,
  InvalidAddressError,
  MAX_ADDRESS_LENGTH,
  MemoryAddressBook,
  normalizeAddress,
  parseSavedAddresses,
  resetAddressBook,
  UpstashAddressBook,
} from "./address-book";
import { createRedisClient } from "@/lib/driver";

describe("parseSavedAddresses", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads casa and trabalho", () => {
    expect(parseSavedAddresses('{"casa":" Rua Augusta, 123 ","trabalho":"Av. Paulista, 1000"}')).toEqual({
      casa: "Rua Augusta, 123",
      trabalho: "Av. Paulista, 1000",
    });
  });

  it("returns nothing for an empty value", () => {
    expect(parseSavedAddresses("")).toEqual({});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("logs and ignores invalid JSON", () => {
    expect(parseSavedAddresses("{casa: Rua Augusta")).toEqual({});
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("logs and ignores non-object JSON", () => {
    expect(parseSavedAddresses('["Rua Augusta"]')).toEqual({});
    expect(parseSavedAddresses('"Rua Augusta"')).toEqual({});
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("drops unknown labels and empty or non-string addresses", () => {
    expect(parseSavedAddresses('{"casa":"Rua A, 1","academia":"Rua B","trabalho":""}')).toEqual({
      casa: "Rua A, 1",
    });
    expect(parseSavedAddresses('{"casa":42}')).toEqual({});
  });
});

const A = "drv_" + "A".repeat(22);
const B = "drv_" + "B".repeat(22);
const PREFIX = "finn:test:";

/** Real SDK over a fake Upstash REST endpoint (global fetch stubbed): HSET/HGETALL only, no network. */
function fakeUpstash(opts: { fail?: boolean; corrupt?: unknown } = {}) {
  const hashes = new Map<string, Record<string, string>>();
  const commands: string[][] = [];
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const cmd = JSON.parse(init.body as string) as string[];
    commands.push(cmd);
    if (opts.fail) return new Response(JSON.stringify({ error: "ERR secret-detail Rua Augusta 123" }), { status: 500 });
    const reply = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
    const [op, key, ...rest] = cmd;
    if (op.toLowerCase() === "hset") {
      const h = hashes.get(key) ?? {};
      for (let i = 0; i < rest.length; i += 2) h[rest[i]] = rest[i + 1];
      hashes.set(key, h);
      return reply(rest.length / 2);
    }
    if (op.toLowerCase() === "hgetall") {
      if (opts.corrupt !== undefined) return reply(opts.corrupt);
      const h = hashes.get(key);
      return reply(h ? Object.entries(h).flat() : []);
    }
    return new Response(JSON.stringify({ error: "unsupported" }), { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { hashes, commands, redis: createRedisClient("https://fake.upstash.example", "fake-token") };
}

describe("normalizeAddress", () => {
  it("trims and accepts 1..200 characters", () => {
    expect(normalizeAddress("  Rua A, 1 ")).toBe("Rua A, 1");
    expect(normalizeAddress("x")).toBe("x");
    expect(normalizeAddress("x".repeat(MAX_ADDRESS_LENGTH))).toHaveLength(MAX_ADDRESS_LENGTH);
  });
  it.each([[""], ["   "], ["x".repeat(MAX_ADDRESS_LENGTH + 1)], ["a\nb"], ["a\u0000b"], ["a\u001b[0m"], ["a\u0085b"], [42], [undefined], [null]])(
    "rejects %j",
    (v) => {
      expect(() => normalizeAddress(v)).toThrow(InvalidAddressError);
    },
  );
  it("the error never carries the value", () => {
    try {
      normalizeAddress("Rua Secreta\u0000");
    } catch (e) {
      expect(String((e as Error).message) + String((e as Error).stack)).not.toContain("Secreta");
    }
  });
});

describe("MemoryAddressBook", () => {
  it("driver B never reads driver A's address, even sharing one backing map", async () => {
    const backing = new Map();
    const a = new MemoryAddressBook(A, PREFIX, backing);
    const b = new MemoryAddressBook(B, PREFIX, backing);
    await a.set("casa", "Rua do A, 1");
    expect(await b.get("casa")).toBeUndefined();
    await b.set("casa", "Rua do B, 2");
    expect(await a.get("casa")).toBe("Rua do A, 1");
    expect(await b.get("casa")).toBe("Rua do B, 2");
  });
  it("validates on write and keys carry the env prefix", async () => {
    const backing = new Map();
    const a = new MemoryAddressBook(A, PREFIX, backing);
    await expect(a.set("casa", "x".repeat(201))).rejects.toThrow(InvalidAddressError);
    await a.set("trabalho", "Av. B, 2");
    expect([...backing.keys()]).toEqual([`${PREFIX}driver-addr:${A}`]);
  });
  it("rejects invalid driver ids and prefixes", () => {
    expect(() => new MemoryAddressBook("../etc", PREFIX)).toThrow();
    expect(() => new MemoryAddressBook(A, "nope")).toThrow();
  });
});

describe("UpstashAddressBook (real SDK, fake fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("driver B never reads driver A's address", async () => {
    const { redis, commands } = fakeUpstash();
    const a = new UpstashAddressBook(redis, PREFIX, A);
    const b = new UpstashAddressBook(redis, PREFIX, B);
    await a.set("casa", "  Rua do A, 1 ");
    expect(await a.get("casa")).toBe("Rua do A, 1");
    expect(await b.get("casa")).toBeUndefined();
    await b.set("trabalho", "Av. do B, 2");
    expect(await a.get("trabalho")).toBeUndefined();
    // every key used carries the environment prefix and the owner's id
    const used = new Set(commands.map((c) => c[1]));
    expect(used).toEqual(new Set([`${PREFIX}driver-addr:${A}`, `${PREFIX}driver-addr:${B}`]));
  });

  it("does not store an invalid value and does not even call Redis for it", async () => {
    const { redis, commands } = fakeUpstash();
    const a = new UpstashAddressBook(redis, PREFIX, A);
    await expect(a.set("casa", "x".repeat(201))).rejects.toThrow(InvalidAddressError);
    await expect(a.set("casa", "a\u0000b")).rejects.toThrow(InvalidAddressError);
    expect(commands).toHaveLength(0);
  });

  it("ignores a corrupt or foreign value found in the hash", async () => {
    const { redis, hashes } = fakeUpstash();
    hashes.set(`${PREFIX}driver-addr:${A}`, { casa: "x".repeat(500), trabalho: "ok\u0000bad" });
    const a = new UpstashAddressBook(redis, PREFIX, A);
    expect(await a.get("casa")).toBeUndefined();
    expect(await a.get("trabalho")).toBeUndefined();
  });

  it("any Redis failure is the generic error, with nothing of the SDK message", async () => {
    const { redis } = fakeUpstash({ fail: true });
    const a = new UpstashAddressBook(redis, PREFIX, A);
    for (const op of [() => a.get("casa"), () => a.set("casa", "Rua Augusta, 123")]) {
      const err = await op().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverStoreUnavailableError);
      expect(JSON.stringify(err) + String((err as Error).message) + String((err as Error).stack)).not.toMatch(/secret-detail|Augusta/);
      expect((err as Error).cause).toBeUndefined();
    }
  });

  it("a malformed HGETALL reply fails closed (generic error), not as 'no address'", async () => {
    const { redis } = fakeUpstash({ corrupt: ["casa"] });
    await expect(new UpstashAddressBook(redis, PREFIX, A).get("casa")).rejects.toBeInstanceOf(DriverStoreUnavailableError);
  });
});

describe("getAddressBook", () => {
  const OWNER = LEGACY_OWNER_DRIVER_ID;
  beforeEach(() => {
    resetAddressBook();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAddressBook();
  });

  it("owner reads the env seed; the seed is never written back; Redis wins once saved", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", '{"trabalho":"Av. Paulista, 1000","casa":"Seed Casa"}');
    const book = getAddressBook(OWNER);
    expect(await book.get("trabalho")).toBe("Av. Paulista, 1000");
    // fresh instance (new request): still only the seed, nothing was persisted by reading
    const devKeysBefore = await getAddressBook("drv_" + "C".repeat(22)).get("casa");
    expect(devKeysBefore).toBeUndefined();
    await book.set("casa", "Rua Augusta, 123");
    expect(await getAddressBook(OWNER).get("casa")).toBe("Rua Augusta, 123");
    expect(await getAddressBook(OWNER).get("trabalho")).toBe("Av. Paulista, 1000");
    vi.stubEnv("WAZE_SAVED_ADDRESSES", "");
    // seed gone: the saved one stays, the never-saved one is gone => seed was not written back
    expect(await getAddressBook(OWNER).get("casa")).toBe("Rua Augusta, 123");
    expect(await getAddressBook(OWNER).get("trabalho")).toBeUndefined();
  });

  it("a non-owner never sees the owner's seed or saved addresses", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", '{"casa":"Casa do Dono"}');
    await getAddressBook(OWNER).set("trabalho", "Trabalho do Dono");
    const other = getAddressBook(A);
    expect(await other.get("casa")).toBeUndefined();
    expect(await other.get("trabalho")).toBeUndefined();
  });

  it("ignores an invalid seed without logging its content", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", "not json Rua Augusta");
    expect(await getAddressBook(OWNER).get("casa")).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("Augusta");
  });

  it("rejects ids that are neither a driverId nor the owner (fail closed)", () => {
    for (const bad of ["", "drv_short", "../x", `${A}x`, "drv_" + "A".repeat(21) + "\n"]) {
      expect(() => getAddressBook(bad)).toThrow();
    }
  });

  it("production without Redis variables fails closed (never memory); also NODE_ENV=production and unknown envs", () => {
    for (const env of [
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "development", NODE_ENV: "production" },
      { VERCEL_ENV: "weird" },
      { VERCEL_ENV: "production", KV_REST_API_URL: "https://x.example" },
    ]) {
      expect(() => getAddressBook(A, env)).toThrow();
      expect(() => getAddressBook(OWNER, env)).toThrow();
    }
  });

  it("with Redis variables, uses Redis under the finn:<env>: prefix", async () => {
    const { hashes } = fakeUpstash();
    const env = { VERCEL_ENV: "production", NODE_ENV: "production", KV_REST_API_URL: "https://fake.upstash.example", KV_REST_API_TOKEN: "fake-token" };
    await getAddressBook(A, env).set("casa", "Rua do A, 1");
    expect([...hashes.keys()]).toEqual([`finn:production:driver-addr:${A}`]);
    expect(await getAddressBook(B, env).get("casa")).toBeUndefined();
  });
});
