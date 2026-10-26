import { afterEach, describe, expect, it, vi } from "vitest";
import { authorize } from "./auth";

const req = (auth?: string) =>
  new Request("http://x/api/orchestrator", { headers: auth ? { authorization: auth } : {} });

describe("authorize", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when FINN_API_TOKEN is unset", () => {
    vi.stubEnv("FINN_API_TOKEN", "");
    expect(authorize(req("Bearer anything"))?.status).toBe(503);
  });

  it("rejects missing or wrong tokens", () => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    expect(authorize(req())?.status).toBe(401);
    expect(authorize(req("Bearer nope"))?.status).toBe(401);
    expect(authorize(req("s3cret"))?.status).toBe(401);
  });

  it("accepts the right bearer token", () => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    expect(authorize(req("Bearer s3cret"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// authorizeDriver
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import {
  DriverStoreUnavailableError,
  MemoryDriverStore,
  isValidDriverId,
  keyPrefix,
  signSessionToken,
  SESSION_TTL_SECONDS,
  type DriverStore,
} from "@/lib/driver";
import { LEGACY_OWNER_DRIVER_ID, authorizeDriver } from "./auth";

const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const PEPPER = "c2b7d95e01f84a36b9d0e7a15c4f8823e6a91b07d3f5c8e24a0b69d1f7c3e5a8";
const T0 = 1_800_000_000_000;

function setup() {
  const clock = { t: T0 };
  const store = new MemoryDriverStore(keyPrefix("test"), () => clock.t, PEPPER);
  return { clock, store, now: () => clock.t };
}

async function bodyOf(r: Response) {
  return { status: r.status, text: await r.text(), headers: [...r.headers.entries()].sort() };
}

describe("authorizeDriver", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("legacy token flag", () => {
    it("legacy driverId constant has the driverId format", () => {
      expect(isValidDriverId(LEGACY_OWNER_DRIVER_ID)).toBe(true);
    });

    it.each([undefined, "", "true", "0", " 1", "1 ", "01", "yes", "TRUE"])("is OFF when flag is %j", async (flag) => {
      vi.stubEnv("FINN_API_TOKEN", "s3cret");
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", flag);
      const r = await authorizeDriver(req("Bearer s3cret"));
      expect(r).toBeInstanceOf(Response);
      expect((r as Response).status).toBe(401);
    });

    it("is ON only with exactly '1' and returns the fixed owner id", async () => {
      vi.stubEnv("FINN_API_TOKEN", "s3cret");
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
      expect(await authorizeDriver(req("Bearer s3cret"))).toEqual({ driverId: LEGACY_OWNER_DRIVER_ID });
      for (const bad of ["Bearer s3cre", "Bearer s3cretx", "Bearer nope", "s3cret", "Bearer "]) {
        expect(((await authorizeDriver(req(bad))) as Response).status).toBe(401);
      }
      expect(((await authorizeDriver(req())) as Response).status).toBe(401);
    });

    it("never accepts a legacy match when FINN_API_TOKEN is unset or empty", async () => {
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
      vi.stubEnv("FINN_API_TOKEN", "");
      expect(((await authorizeDriver(req("Bearer "))) as Response).status).toBe(401);
      expect(((await authorizeDriver(req("Bearer x"))) as Response).status).toBe(401);
    });

    it("legacy does not apply when the Bearer looks like a v1. token", async () => {
      vi.stubEnv("FINN_API_TOKEN", "v1.legacy.looking");
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
      vi.stubEnv("FINN_SESSION_SECRET", SECRET);
      const { store } = setup();
      const r = await authorizeDriver(req("Bearer v1.legacy.looking"), { store });
      expect((r as Response).status).toBe(401);
    });
  });

  describe("session token", () => {
    it("accepts valid, then rejects tampered, expired, revoked and rotated, all with the same 401", async () => {
      vi.stubEnv("FINN_SESSION_SECRET", SECRET);
      const { store, clock, now } = setup();
      const d = await store.createDriver({ label: "A" });
      const tok = signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SECRET, T0);
      const ok = (t: string) => authorizeDriver(req(`Bearer ${t}`), { store, now });

      expect(await ok(tok)).toEqual({ driverId: d.driverId });

      const [v, body, sig] = tok.split(".");
      const forgedBody = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), tv: 99 }),
      ).toString("base64url");
      const otherDriver = await store.createDriver({ label: "B" });
      const swapped = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), sub: otherDriver.driverId }),
      ).toString("base64url");
      const flippedSig = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
      const wrongSecret = `v1.${body}.${createHmac("sha256", "0".repeat(64)).update(`v1.${body}`).digest("base64url")}`;
      const responses = [
        await ok(`${v}.${forgedBody}.${sig}`),
        await ok(`${v}.${swapped}.${sig}`),
        await ok(`${v}.${body}.${flippedSig}`),
        await ok(wrongSecret),
        await ok("v1.garbage"),
      ] as Response[];
      for (const r of responses) expect(r).toBeInstanceOf(Response);

      clock.t = T0 + SESSION_TTL_SECONDS * 1000;
      responses.push((await ok(tok)) as Response); // expired
      clock.t = T0;

      const revoked = await store.createDriver({ label: "R" });
      const rTok = signSessionToken({ driverId: revoked.driverId, tokenVersion: 1 }, SECRET, T0);
      expect(await ok(rTok)).toEqual({ driverId: revoked.driverId });
      await store.revokeDriver(revoked.driverId);
      responses.push((await ok(rTok)) as Response);

      await store.rotateSessions(d.driverId);
      responses.push((await ok(tok)) as Response);
      const fresh = signSessionToken({ driverId: d.driverId, tokenVersion: 2 }, SECRET, T0);
      expect(await ok(fresh)).toEqual({ driverId: d.driverId });

      const snaps = await Promise.all(responses.map(bodyOf));
      expect(snaps.every((s) => s.status === 401)).toBe(true);
      for (const s of snaps) expect(s).toEqual(snaps[0]);
      expect(snaps[0].text).not.toMatch(/drv_|v1\./);
    });

    it("Redis unavailable -> short 503 with nothing leaked and nothing logged", async () => {
      vi.stubEnv("FINN_SESSION_SECRET", SECRET);
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      const { store, now } = setup();
      const d = await store.createDriver({ label: "A" });
      const tok = signSessionToken({ driverId: d.driverId, tokenVersion: 1 }, SECRET, T0);
      const broken = { getDriver: async () => { throw new DriverStoreUnavailableError(); } } as unknown as DriverStore;
      const r = (await authorizeDriver(req(`Bearer ${tok}`), { store: broken, now })) as Response;
      const text = await r.text();
      expect(r.status).toBe(503);
      expect(JSON.parse(text)).toEqual({ error: expect.any(String) });
      expect(text.length).toBeLessThan(120);
      expect(text + JSON.stringify([...r.headers])).not.toMatch(new RegExp(`${tok}|${d.driverId}|upstash|redis|DriverStore`, "i"));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    });

    it("missing or invalid FINN_SESSION_SECRET fails closed (503), never lets a v1 token through", async () => {
      const { store, now } = setup();
      const d = await store.createDriver({ label: "A" });
      const tok = signSessionToken({ driverId: d.driverId, tokenVersion: 1 }, SECRET, T0);
      vi.stubEnv("FINN_SESSION_SECRET", "");
      expect(((await authorizeDriver(req(`Bearer ${tok}`), { store, now })) as Response).status).toBe(503);
      vi.stubEnv("FINN_SESSION_SECRET", "weak");
      expect(((await authorizeDriver(req(`Bearer ${tok}`), { store, now })) as Response).status).toBe(503);
    });
  });

  it("/api/agents/* still uses only authorize() (not authorizeDriver)", () => {
    for (const f of ["src/app/api/agents/[agent]/route.ts", "src/app/api/agents/[agent]/card/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("authorizeDriver");
    }
    expect(readFileSync("src/app/api/agents/[agent]/route.ts", "utf8")).toMatch(/\bauthorize\(request\)/);
  });
});
