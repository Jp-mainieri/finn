/**
 * Delivery 4 (Spotify token custody) end to end: real route modules, real auth, in-memory store, fake Spotify.
 * Born from the qa attack tests; findings that were fixed in round 2 are asserted as fixed. Tests named "debt" pin
 * behavior that is known and consciously left for later (see docs/revisoes). No network, no real Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { DriverStoreUnavailableError, MemoryDriverStore, setDriverStoreForTests, signSessionToken } from "@/lib/driver";
import { evictSpotifyAccessToken, getAccessToken, resetSpotifyTokenCache } from "@/lib/spotify/auth";
import { decryptToken, encryptToken } from "@/lib/spotify/token-crypto";
import { createFakeSpotify, json, loggedText, OTHER_TEST_KEY, TEST_ENC_KEY, TOKEN_URL } from "@/lib/spotify/testing";
import { loadSpotifyRefreshToken, saveSpotifyRefreshToken, tokenAad } from "@/lib/spotify/token-vault";
import { GET as callbackGET } from "@/app/api/spotify/callback/route";
import { POST as connectPOST } from "@/app/api/spotify/connect/route";
import { DELETE as connectionDELETE, GET as connectionGET } from "@/app/api/spotify/connection/route";
import { GET as loginGET } from "@/app/api/spotify/login/route";
import { NextRequest } from "next/server";

const SESSION_SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const RT = "RT-QA-SENTINEL-0123456789";
const CODE = "CODE-QA";
const REDIRECT = "https://finn.test/api/spotify/callback";
const KEY = Buffer.from(TEST_ENC_KEY, "hex");
const AAD = "finn:preview:spotify:drv_" + "A".repeat(22);

let store: MemoryDriverStore;
let fake: ReturnType<typeof createFakeSpotify>;
let exchangeRt: string | undefined;
let exchanges: number;
/** What GET /v1/me answers for the access token of each code exchange (default: a new account per exchange). */
let profiles: Map<string, { id: string; display_name?: string }>;
let nextProfile: { id: string; display_name?: string } | undefined;
let meFails = false;

async function newDriver(label = "B") {
  const d = await store.createDriver({ label });
  return { id: d.driverId, token: signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SESSION_SECRET) };
}
const auth = (t?: string): Record<string, string> => (t ? { authorization: `Bearer ${t}` } : {});
const connect = (t?: string) => connectPOST(new Request("https://finn.test/api/spotify/connect", { method: "POST", headers: auth(t) }));
const callback = (qs: string, headers: Record<string, string> = {}) =>
  callbackGET(new Request(`https://finn.test/api/spotify/callback?${qs}`, { headers }));
const status = (t?: string) => connectionGET(new Request("https://finn.test/api/spotify/connection", { headers: auth(t) }));
const disconnect = (t?: string) => connectionDELETE(new Request("https://finn.test/api/spotify/connection", { method: "DELETE", headers: auth(t) }));
async function startConnect(t: string): Promise<string> {
  const res = await connect(t);
  expect(res.status).toBe(200);
  return new URL(((await res.json()) as { url: string }).url).searchParams.get("state") as string;
}
// Errors are expanded (JSON.stringify(new Error("x")) is "{}"): a logged `err` or `cause` cannot hide.
const logged = () => loggedText([vi.mocked(console.error), vi.mocked(console.warn), vi.mocked(console.log), vi.mocked(console.info)]);
const grantCalls = (grant: string) => fake.find("POST", TOKEN_URL).filter((c) => (c.body ?? "").includes(`grant_type=${grant}`));
// refreshes of DRIVERS (the owner's own refresh, used once to learn the owner's account id, is not counted)
const refreshCalls = () => grantCalls("refresh_token").filter((c) => !(c.body ?? "").includes("server-owner-rt"));

beforeEach(() => {
  resetSpotifyTokenCache();
  exchangeRt = RT;
  exchanges = 0;
  profiles = new Map();
  nextProfile = undefined;
  meFails = false;
  store = new MemoryDriverStore("finn:development:", () => Date.now());
  setDriverStoreForTests(store);
  vi.stubEnv("FINN_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
  vi.stubEnv("SPOTIFY_CLIENT_ID", "client-id");
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", "client-secret");
  vi.stubEnv("SPOTIFY_REDIRECT_URI", REDIRECT);
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "server-owner-rt");
  vi.stubEnv("NODE_ENV", "test");
  fake = createFakeSpotify({
    me: (bearer) => (meFails || !bearer ? undefined : (profiles.get(bearer) ?? { id: "owner-spotify-id", display_name: "Dono" })),
    override: (c) => {
      if (c.url !== TOKEN_URL) return undefined;
      const form = new URLSearchParams(c.body ?? "");
      if (form.get("grant_type") !== "authorization_code") return undefined;
      const accessToken = `access-ex-${++exchanges}`;
      profiles.set(accessToken, nextProfile ?? { id: `spuser-${exchanges}`, display_name: `Perfil ${exchanges}` });
      return json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, ...(exchangeRt ? { refresh_token: exchangeRt } : {}) });
    },
  });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  for (const m of ["error", "warn", "log", "info"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  setDriverStoreForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("QA crypto", () => {
  it("non-canonical base64url (spare bits flipped) is refused in iv, ct and tag", () => {
    const blob = encryptToken(RT, KEY, AAD);
    const parts = blob.split(".");
    let exercised = 0;
    for (const i of [1, 2, 3]) {
      // 22-char tag / 16-char iv end with spare bits: changing the last char to another that decodes to the same bytes
      const p = [...parts];
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = p[i].at(-1) as string;
      const base = Buffer.from(p[i], "base64url");
      for (const c of alphabet) {
        if (c === last) continue;
        const cand = p[i].slice(0, -1) + c;
        if (Buffer.from(cand, "base64url").equals(base)) {
          const q = [...p];
          q[i] = cand;
          expect(decryptToken(q.join("."), KEY, AAD)).toBeNull();
          exercised++;
          break;
        }
      }
    }
    expect(exercised).toBeGreaterThan(0); // the tag always has spare bits: the test must not be vacuous
  });

  it("swapping iv and tag, or splicing the ciphertext of another blob, fails", () => {
    const a = encryptToken(RT, KEY, AAD).split(".");
    const b = encryptToken(RT, KEY, AAD).split(".");
    expect(decryptToken(`v1.${a[3].slice(0, 16)}.${a[2]}.${a[1]}${a[3].slice(16)}`, KEY, AAD)).toBeNull();
    expect(decryptToken(`v1.${a[1]}.${b[2]}.${a[3]}`, KEY, AAD)).toBeNull();
  });

  it("unicode and long tokens round trip; 31-byte key on decrypt is null (no throw)", () => {
    const t = "tok-áé✓-" + "x".repeat(300);
    expect(decryptToken(encryptToken(t, KEY, AAD), KEY, AAD)).toBe(t);
    expect(decryptToken(encryptToken(t, KEY, AAD), randomBytes(31), AAD)).toBeNull();
  });

  it("debt (N10, inherent to AES-GCM without a version): an OLD valid blob of the same driver decrypts again (rollback to a rotated-out token)", () => {
    const old = encryptToken("old-token", KEY, AAD);
    encryptToken("new-token", KEY, AAD);
    expect(decryptToken(old, KEY, AAD)).toBe("old-token");
  });

  it("the key must not be the all-lowercase twin of another secret even with whitespace around (trimmed)", async () => {
    vi.stubEnv("FINN_SESSION_SECRET", ` ${TEST_ENC_KEY} `);
    const { getTokenEncKey } = await import("@/lib/spotify/token-crypto");
    expect(getTokenEncKey(process.env)).toBeNull();
  });
});

describe("QA state and callback", () => {
  it("debt (decision: bound to the browser only in delivery 5): the callback is not bound to the browser that started it; ANY holder of the state URL links THEIR Spotify to the state's driver", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    // an attacker-controlled browser, no cookie, no session, completes the flow with the attacker's own code
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(200);
    expect(await loadSpotifyRefreshToken(a.id, { store })).toBe(RT); // token of whoever approved the consent now serves driver A
  });

  it("a state created BEFORE a revoke is refused AFTER it: generic page, nothing stored, no link", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    await store.revokeDriver(a.id);
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(400);
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    expect(store.allKeys().filter((k) => k.includes("spotify-index:") || k.includes(":spotify:"))).toEqual([]);
    expect(grantCalls("authorization_code")).toHaveLength(0); // nothing was even exchanged
  });

  it("a state whose driver does not exist (never created, or id of nobody) is refused, nothing stored", async () => {
    const ghost = "drv_" + "G".repeat(22);
    const state = await store.createOAuthState(ghost);
    expect((await callback(`code=${CODE}&state=${state}`)).status).toBe(400);
    expect(await store.getSpotifyBlob(ghost)).toBeNull();
  });

  it("debt (purge keeps the driver active by design): a state created before driver:purge still completes, the driver simply reconnects", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    await store.purgeDriverData(a.id);
    expect((await callback(`code=${CODE}&state=${state}`)).status).toBe(200);
    expect(await store.getSpotifyBlob(a.id)).not.toBeNull();
  });

  it("another live state of the same driver is not burned by consuming one", async () => {
    const a = await newDriver("A");
    const s1 = await startConnect(a.token);
    const s2 = await startConnect(a.token);
    await callback(`code=${CODE}&state=${s1}`);
    expect(await store.consumeOAuthState(s2)).toBe(a.id);
  });

  it("duplicated state parameter: only the first counts, the second (valid) state is NOT burned", async () => {
    const a = await newDriver("A");
    const good = await startConnect(a.token);
    const res = await callback(`code=${CODE}&state=${"B".repeat(43)}&state=${good}`);
    expect(res.status).toBe(400);
    expect(await store.consumeOAuthState(good)).toBe(a.id);
  });

  it("a state that carries trailing junk or different case is not accepted (and not burned)", async () => {
    const a = await newDriver("A");
    const s = await startConnect(a.token);
    for (const v of [s + "%20", " " + s, s.toLowerCase() === s ? s.toUpperCase() : s.toLowerCase(), s + s]) {
      expect((await callback(`code=${CODE}&state=${encodeURIComponent(v)}`)).status).toBe(400);
    }
    expect(await store.consumeOAuthState(s)).toBe(a.id);
  });

  it("code of 2049 chars burns the state and exchanges nothing; exactly 2048 chars goes through", async () => {
    const a = await newDriver("A");
    const s1 = await startConnect(a.token);
    expect((await callback(`code=${"c".repeat(2049)}&state=${s1}`)).status).toBe(400);
    expect(await store.consumeOAuthState(s1)).toBeNull();
    expect(fake.calls).toHaveLength(0);
    const s2 = await startConnect(a.token);
    expect((await callback(`code=${"c".repeat(2048)}&state=${s2}`)).status).toBe(200);
  });

  it("a Spotify token that is too long to store (> 1536 bytes) fails closed as 502 with nothing stored and nothing logged", async () => {
    exchangeRt = "R".repeat(1700);
    const a = await newDriver("A");
    const res = await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    expect(res.status).toBe(502);
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    expect(logged()).not.toContain("RRRR");
  });

  it("the error page body is byte-identical for 400 (bad state), 400 (error=), 502 (exchange) except the status code", async () => {
    const a = await newDriver("A");
    const bodies = new Set<string>();
    bodies.add(await (await callback(`code=${CODE}&state=${"Z".repeat(43)}`)).text());
    bodies.add(await (await callback(`error=access_denied&state=${await startConnect(a.token)}`)).text());
    exchangeRt = undefined;
    bodies.add(await (await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).text());
    expect(bodies.size).toBe(1);
  });

  it("the success page is not cacheable and carries a CSP that forbids scripts", async () => {
    const a = await newDriver("A");
    const res = await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("QA rotation, disconnect and concurrency", () => {
  const rotatingFake = (rotateTo = "b-new") => {
    let n = 0;
    fake = createFakeSpotify({
      override: (c) =>
        c.url === TOKEN_URL ? json({ access_token: `acc-${++n}`, token_type: "Bearer", expires_in: 3600, refresh_token: rotateTo }) : undefined,
    });
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
  };

  it("DELETE during an in-flight refresh is NOT undone: no blob comes back and the access token is not cached", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-old", { store });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return json({ access_token: "acc-inflight", token_type: "Bearer", expires_in: 3600, refresh_token: "b-rotated" });
      }),
    );
    const inflight = getAccessToken({ driverId: a.id });
    await new Promise((r) => setTimeout(r, 5));
    expect((await disconnect(a.token)).status).toBe(200);
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    release();
    await inflight; // the caller of that very request still gets the token it asked for
    expect(await store.getSpotifyBlob(a.id)).toBeNull(); // not resurrected
    await expect(getAccessToken({ driverId: a.id })).rejects.toMatchObject({ speech: "Conecte seu Spotify." }); // not cached
  });

  it("revoke or purge (another process, no evict) during an in-flight refresh: no blob, no cached access token", async () => {
    for (const how of ["revoke", "purge"] as const) {
      resetSpotifyTokenCache();
      const a = await newDriver("A");
      await saveSpotifyRefreshToken(a.id, "b-old", { store });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      vi.stubGlobal("fetch", vi.fn(async () => {
        await gate;
        return json({ access_token: "acc-late", token_type: "Bearer", expires_in: 3600, ...(how === "revoke" ? { refresh_token: "b-rot" } : {}) });
      }));
      const inflight = getAccessToken({ driverId: a.id });
      await new Promise((r) => setTimeout(r, 5));
      await (how === "revoke" ? store.revokeDriver(a.id) : store.purgeDriverData(a.id));
      release();
      await inflight;
      expect(await store.getSpotifyBlob(a.id)).toBeNull();
      await expect(getAccessToken({ driverId: a.id })).rejects.toMatchObject({ speech: "Conecte seu Spotify." });
    }
  });

  it("evict during an in-flight refresh: the old promise's finally() leaves the NEWER pending entry alone, so a forced refresh joins it", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-old", { store });
    const gates: Array<() => void> = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise<void>((r) => gates.push(r));
        return json({ access_token: `acc-${++n}`, token_type: "Bearer", expires_in: 3600 });
      }),
    );
    const first = getAccessToken({ driverId: a.id });
    await new Promise((r) => setTimeout(r, 5));
    evictSpotifyAccessToken(a.id); // e.g. reconnect callback
    const second = getAccessToken({ driverId: a.id });
    await new Promise((r) => setTimeout(r, 5));
    expect(gates).toHaveLength(2);
    gates[0](); // the OLD refresh finishes first
    await first;
    const forced = getAccessToken({ driverId: a.id, forceRefresh: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(gates).toHaveLength(2); // joined `second`: no third, parallel refresh
    gates[1]();
    await Promise.all([second, forced]);
  });

  it("a refresh that started before an evict does not repopulate the cache (stale access token of the old connection)", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-old", { store });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const mine = ++n;
      if (mine === 1) await gate;
      return json({ access_token: `acc-${mine}`, token_type: "Bearer", expires_in: 3600 });
    }));
    const stale = getAccessToken({ driverId: a.id });
    await new Promise((r) => setTimeout(r, 5));
    evictSpotifyAccessToken(a.id);
    release();
    await stale;
    expect(await getAccessToken({ driverId: a.id })).toBe("acc-2"); // refreshed again, not the stale acc-1
  });

  it("failing to store a rotated token: the access token still works, a fixed warning with no token, and the OLD token is used on the next refresh", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-old", { store });
    rotatingFake("b-new-QA");
    vi.spyOn(store, "setSpotifyBlobIfExists").mockRejectedValue(new DriverStoreUnavailableError());
    await expect(getAccessToken({ driverId: a.id })).resolves.toBe("acc-1");
    expect(logged()).not.toContain("b-new-QA");
    expect(logged()).not.toContain("b-old");
    await getAccessToken({ driverId: a.id, forceRefresh: true });
    expect(refreshCalls().map((c) => new URLSearchParams(c.body ?? "").get("refresh_token"))).toEqual(["b-old", "b-old"]);
  });

  it("rotated token for the OWNER is kept only in memory and never written to the store", async () => {
    rotatingFake("owner-new-QA");
    const set = vi.spyOn(store, "setSpotifyBlob");
    await getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID });
    expect(set).not.toHaveBeenCalled();
    await getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID, forceRefresh: true });
    expect(new URLSearchParams(grantCalls("refresh_token")[1].body ?? "").get("refresh_token")).toBe("owner-new-QA");
    expect(logged()).not.toContain("owner-new-QA");
  });

  it("debt (N7, pre-existing shape): callers of the same driver share ONE refresh, so the first caller's AbortSignal rejects the others", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-old", { store });
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))),
    );
    const ac = new AbortController();
    const p1 = getAccessToken({ driverId: a.id, signal: ac.signal });
    const p2 = getAccessToken({ driverId: a.id });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const results = await Promise.allSettled([p1, p2]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });

  it("two connects racing from two drivers each get their own state and neither sees the other's driverId", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    const [sa, sb] = await Promise.all([startConnect(a.token), startConnect(b.token)]);
    const [ra, rb] = await Promise.all([callback(`code=${CODE}&state=${sa}`), callback(`code=${CODE}&state=${sb}`)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await store.getSpotifyBlob(a.id)).not.toBe(await store.getSpotifyBlob(b.id));
  });

  it("revoked driver's session cannot call connect, status or disconnect (401)", async () => {
    const a = await newDriver("A");
    await store.revokeDriver(a.id);
    expect((await connect(a.token)).status).toBe(401);
    expect((await status(a.token)).status).toBe(401);
    expect((await disconnect(a.token)).status).toBe(401);
  });

  it("rotateSessions (tokenVersion bump) invalidates the old session on the three routes", async () => {
    const a = await newDriver("A");
    await store.rotateSessions(a.id);
    expect((await connect(a.token)).status).toBe(401);
    expect((await status(a.token)).status).toBe(401);
  });

  it("a forged driverId in the body or query of connect/connection/disconnect is not an input", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    await saveSpotifyRefreshToken(b.id, "b-tok", { store });
    const r = await connectionGET(new Request(`https://finn.test/api/spotify/connection?driverId=${b.id}`, { headers: { ...auth(a.token), "x-driver-id": b.id, cookie: `driverId=${b.id}` } }));
    expect(await r.json()).toEqual({ connected: false });
    await connectionDELETE(new Request(`https://finn.test/api/spotify/connection?driverId=${b.id}`, { method: "DELETE", headers: auth(a.token), body: JSON.stringify({ driverId: b.id }) }));
    expect(await store.getSpotifyBlob(b.id)).not.toBeNull();
  });
});

describe("owner (LEGACY_OWNER_DRIVER_ID): connected through the server token, never through the vault", () => {
  const ownerHeaders = () => {
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_API_TOKEN", "legacy-" + "ab".repeat(20));
    return "legacy-" + "ab".repeat(20);
  };

  it("GET connection is connected = Boolean(SPOTIFY_REFRESH_TOKEN), with no blob, without the vault key, and without touching the store", async () => {
    const t = ownerHeaders();
    const get = vi.spyOn(store, "getSpotifyBlob");
    expect(await (await status(t)).json()).toEqual({ connected: true });
    vi.stubEnv("FINN_TOKEN_ENC_KEY", "");
    expect(await (await status(t)).json()).toEqual({ connected: true });
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "  ");
    expect(await (await status(t)).json()).toEqual({ connected: false });
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "");
    expect(await (await status(t)).json()).toEqual({ connected: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("POST connect is 403 for the owner (and creates no state)", async () => {
    const t = ownerHeaders();
    const create = vi.spyOn(store, "createOAuthState");
    expect((await connect(t)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("saveSpotifyRefreshToken refuses the legacy id, so no blob can ever sit under it", async () => {
    await expect(saveSpotifyRefreshToken(LEGACY_OWNER_DRIVER_ID, "x-tok", { store })).rejects.toThrow();
    expect(await store.getSpotifyBlob(LEGACY_OWNER_DRIVER_ID)).toBeNull();
  });

  it("a state minted for the owner id earlier is refused by the callback: nothing exchanged, nothing stored", async () => {
    const state = await store.createOAuthState(LEGACY_OWNER_DRIVER_ID);
    expect((await callback(`code=${CODE}&state=${state}`)).status).toBe(400);
    expect(grantCalls("authorization_code")).toHaveLength(0);
    expect(await store.getSpotifyBlob(LEGACY_OWNER_DRIVER_ID)).toBeNull();
  });

  it("DELETE still works for the legacy id: clears a residual blob and answers the same connected as GET; the server token stays in use", async () => {
    const t = ownerHeaders();
    await store.setSpotifyBlob(LEGACY_OWNER_DRIVER_ID, encryptToken("old", KEY, tokenAad(LEGACY_OWNER_DRIVER_ID)));
    const res = await disconnect(t);
    expect(await res.json()).toEqual({ connected: true });
    expect(await store.getSpotifyBlob(LEGACY_OWNER_DRIVER_ID)).toBeNull();
    await expect(getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID })).resolves.toBeTypeOf("string");
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "");
    expect(await (await disconnect(t)).json()).toEqual({ connected: false });
  });

  it("an owner who comes in through an invite has an ordinary driverId and uses the normal flow", async () => {
    const o = await newDriver("Owner by invite");
    expect((await callback(`code=${CODE}&state=${await startConnect(o.token)}`)).status).toBe(200);
    expect(await (await status(o.token)).json()).toEqual({ connected: true });
  });

  it("the owner's own Spotify account cannot be linked to a guest (account of SPOTIFY_REFRESH_TOKEN): generic refusal, nothing stored", async () => {
    const a = await newDriver("A");
    nextProfile = { id: "Owner-Spotify-ID" }; // same account as the owner, any case
    const res = await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    expect(res.status).toBe(400);
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    expect(await store.getLinkedDriver("owner-spotify-id")).toBeNull();
  });

  it("without SPOTIFY_REFRESH_TOKEN the owner check is skipped (and the owner account is not looked up)", async () => {
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "");
    const a = await newDriver("A");
    nextProfile = { id: "owner-spotify-id" };
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(200);
    expect(grantCalls("refresh_token")).toHaveLength(0);
  });

  it("owner account lookup failing (token exists, /me does not answer) fails closed; the lookup is cached once it works", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => (u === "https://accounts.spotify.com/api/token" && !(init.body as string).includes("authorization_code") ? json({ error: "x" }, 400) : fake.fetch(u, init))));
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(502);
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    expect((await callback(`code=${CODE}&state=${await startConnect(b.token)}`)).status).toBe(200);
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    expect(grantCalls("refresh_token").filter((c) => (c.body ?? "").includes("server-owner-rt")).length).toBe(1); // the failed one never reached the recorder; the ok one is cached for the third callback
  });
});

describe("one Spotify account, one driver (spotify-index, SET NX)", () => {
  const linked = (uid: string) => store.getLinkedDriver(uid);

  it("a second driver presenting an account already linked to another is refused: generic page, nothing stored, first link intact", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    nextProfile = { id: "shared-account", display_name: "Compartilhada" };
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(200);
    const res = await callback(`code=${CODE}&state=${await startConnect(b.token)}`);
    expect(res.status).toBe(400);
    expect(await store.getSpotifyBlob(b.id)).toBeNull();
    expect(await linked("shared-account")).toBe(a.id);
    expect(await (await status(b.token)).json()).toEqual({ connected: false });
    expect(logged()).not.toContain("shared-account");
  });

  it("the refusal page is byte-identical to the other failures", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    nextProfile = { id: "shared-account" };
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    const conflict = await (await callback(`code=${CODE}&state=${await startConnect(b.token)}`)).text();
    const badState = await (await callback(`code=${CODE}&state=${"Q".repeat(43)}`)).text();
    expect(conflict).toBe(badState);
  });

  it("the same driver reconnecting the same account is fine (and the index still points at them)", async () => {
    const a = await newDriver("A");
    nextProfile = { id: "my-account" };
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(200);
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(200);
    expect(await linked("my-account")).toBe(a.id);
  });

  it("changing account releases the previous link of THAT driver only, leaving no orphan index", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    nextProfile = { id: "acc-b" };
    await callback(`code=${CODE}&state=${await startConnect(b.token)}`);
    nextProfile = { id: "acc-a1" };
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    nextProfile = { id: "acc-a2" };
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(200);
    expect(await linked("acc-a1")).toBeNull();
    expect(await linked("acc-a2")).toBe(a.id);
    expect(await linked("acc-b")).toBe(b.id);
    // the old account is free again: another driver may take it
    nextProfile = { id: "acc-a1" };
    expect((await callback(`code=${CODE}&state=${await startConnect(b.token)}`)).status).toBe(200);
    expect(await linked("acc-a1")).toBe(b.id);
    expect(await linked("acc-b")).toBeNull();
  });

  it("DELETE /connection, driver:purge and driver:revoke release the link of that driver and only theirs", async () => {
    const [a, b, c] = [await newDriver("A"), await newDriver("B"), await newDriver("C")];
    for (const [d, id] of [[a, "acc-a"], [b, "acc-b"], [c, "acc-c"]] as const) {
      nextProfile = { id };
      await callback(`code=${CODE}&state=${await startConnect(d.token)}`);
    }
    await disconnect(a.token);
    expect(await linked("acc-a")).toBeNull();
    await store.purgeDriverData(b.id);
    expect(await linked("acc-b")).toBeNull();
    await store.revokeDriver(c.id);
    expect(await linked("acc-c")).toBeNull();
    nextProfile = { id: "acc-a" };
    const d = await newDriver("D");
    expect((await callback(`code=${CODE}&state=${await startConnect(d.token)}`)).status).toBe(200); // freed accounts can be taken again
    expect(store.allKeys().filter((k) => k.includes("spotify-index:"))).toHaveLength(1);
  });

  it("an index entry now owned by someone else is never released by a stale pointer", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    nextProfile = { id: "acc-x" };
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    await store.deleteSpotifyBlob(a.id); // frees acc-x
    nextProfile = { id: "acc-x" };
    await callback(`code=${CODE}&state=${await startConnect(b.token)}`);
    await store.deleteSpotifyBlob(a.id); // A again: must not touch B's link
    expect(await linked("acc-x")).toBe(b.id);
  });

  it("/me failing, answering garbage or with an invalid id: generic refusal, nothing stored or linked", async () => {
    const a = await newDriver("A");
    meFails = true;
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(502);
    meFails = false;
    for (const bad of [{ id: "" }, { id: "../x" }, { id: "a b" }, { id: "x".repeat(101) }, {} as { id: string }]) {
      nextProfile = bad;
      expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(502);
    }
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    expect(store.allKeys().filter((k) => k.includes("spotify-index:") || k.includes("spotify-account:"))).toEqual([]);
  });

  it("the success page shows the linked profile label, escaped, and still no token, script or cookie", async () => {
    const a = await newDriver("A");
    nextProfile = { id: "label-user", display_name: '<img src=x onerror=alert(1)> "Ana" & Cia' };
    const res = await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    const html = await res.text();
    expect(html).toContain("&#60;img src=x onerror=alert(1)&#62; &#34;Ana&#34; &#38; Cia");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain(RT);
    expect(res.headers.get("set-cookie")).toBeNull();
    nextProfile = { id: "no-name-user" };
    const b = await newDriver("B");
    expect(await (await callback(`code=${CODE}&state=${await startConnect(b.token)}`)).text()).toContain("no-name-user");
  });

  it("racing callbacks of two drivers with the same account: exactly one wins", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    nextProfile = { id: "contested" };
    const [sa, sb] = [await startConnect(a.token), await startConnect(b.token)];
    const rs = await Promise.all([callback(`code=${CODE}&state=${sa}`), callback(`code=${CODE}&state=${sb}`)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = (await linked("contested")) as string;
    expect([a.id, b.id]).toContain(winner);
    expect(await store.getSpotifyBlob(winner === a.id ? b.id : a.id)).toBeNull();
  });
});

describe("callback configuration and timeouts", () => {
  it("VERCEL_ENV=production without SPOTIFY_REDIRECT_URI: connect is 503 and the callback fails closed (state not consumed, nothing exchanged or stored)", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SPOTIFY_REDIRECT_URI", "");
    expect((await connect(a.token)).status).toBe(503);
    expect((await callback(`code=${CODE}&state=${state}`)).status).toBe(503);
    expect(fake.calls).toHaveLength(0);
    expect(await store.consumeOAuthState(state)).toBe(a.id); // still alive: the failed callback did not burn it
  });

  it("outside production the origin fallback stays (preview, development)", async () => {
    vi.stubEnv("SPOTIFY_REDIRECT_URI", "");
    const a = await newDriver("A");
    for (const env of ["preview", "development", ""]) {
      vi.stubEnv("VERCEL_ENV", env);
      const url = new URL(((await (await connect(a.token)).json()) as { url: string }).url);
      expect(url.searchParams.get("redirect_uri")).toBe("https://finn.test/api/spotify/callback");
    }
  });

  it("the code exchange and /v1/me run under a 5 s abort signal; an aborted exchange is a generic 502 and stores nothing", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const a = await newDriver("A");
    expect((await callback(`code=${CODE}&state=${await startConnect(a.token)}`)).status).toBe(200);
    const sawFiveSeconds = timeout.mock.calls.filter(([ms]) => ms === 5000).length;
    expect(sawFiveSeconds).toBeGreaterThanOrEqual(2); // exchange + /me (+ the owner lookup)
    // now a hung Spotify: the signal fires and the fetch honors it
    timeout.mockImplementation(() => AbortSignal.abort());
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => (init.signal?.aborted ? Promise.reject(new DOMException("aborted", "TimeoutError")) : new Promise(() => {}))));
    const b = await newDriver("B");
    const state = await store.createOAuthState(b.id);
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(502);
    expect(await store.getSpotifyBlob(b.id)).toBeNull();
    expect(logged()).not.toMatch(/TimeoutError|aborted/);
  });
});

describe("QA login (dev flow of the owner)", () => {
  const req = (url = "http://127.0.0.1:3000/api/spotify/login", headers: Record<string, string> = {}) =>
    new NextRequest(url, { headers: { host: "127.0.0.1:3000", ...headers } });

  it("development: redirects to Spotify with a 32-byte hex state in an httpOnly lax cookie scoped to /api/spotify; nothing is stored", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:3000/api/spotify/callback");
    const res = await loginGET(req());
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.origin).toBe("https://accounts.spotify.com");
    const state = loc.searchParams.get("state") as string;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const cookie = res.headers.get("set-cookie") as string;
    expect(cookie).toContain(`finn_spotify_oauth_state=${state}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/api/spotify");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(store.allKeys()).toEqual([]);
  });

  it("development: the dev callback needs the cookie to equal the state; a mismatching cookie falls to the normal path and shows nothing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await callback(`code=${CODE}&state=${"f".repeat(64)}`, { cookie: "finn_spotify_oauth_state=" + "e".repeat(64) });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(RT);
  });

  it("the development gate also needs VERCEL_ENV absent or development: with VERCEL_ENV=production/preview the token page and the login stay closed", async () => {
    for (const vercelEnv of ["production", "preview"]) {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL_ENV", vercelEnv);
      const res = await callback(`code=${CODE}&state=dev-state`, { cookie: "finn_spotify_oauth_state=dev-state" });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(RT);
      expect((await loginGET(req())).status).toBe(410);
    }
    expect(fake.calls).toHaveLength(0);
    vi.stubEnv("VERCEL_ENV", "development"); // `vercel dev`
    expect((await callback(`code=${CODE}&state=dev-state`, { cookie: "finn_spotify_oauth_state=dev-state" })).status).toBe(200);
    expect((await loginGET(req())).status).toBe(307);
  });

  it("login is 410 for every non-development NODE_ENV even with an attacker-chosen cookie or query", async () => {
    for (const env of ["production", "test", "preview", "Development", " development"]) {
      vi.stubEnv("NODE_ENV", env);
      const res = await loginGET(req("http://127.0.0.1:3000/api/spotify/login?hop=1", { cookie: "finn_spotify_oauth_state=x" }));
      expect(res.status).toBe(410);
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("QA Redis degraded", () => {
  it("a never-answering store on the cold path hangs getAccessToken (the vault has no timeout of its own; the SDK client's 2 s abort is the only bound)", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-tok", { store });
    vi.spyOn(store, "getSpotifyBlob").mockImplementation(() => new Promise(() => {}));
    const outcome = await Promise.race([getAccessToken({ driverId: a.id }).then(() => "done", () => "err"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
    expect(outcome).toBe("pending");
  });

  it("the OWNER never touches Redis for the token (voice for the owner is immune to Redis slowness once the vault is not consulted)", async () => {
    const get = vi.spyOn(store, "getSpotifyBlob").mockImplementation(() => new Promise(() => {}));
    await expect(getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID })).resolves.toBeTypeOf("string");
    expect(get).not.toHaveBeenCalled();
  });

  it("a Redis blip does not poison the cache: the next call after recovery works and no negative result is cached", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-tok", { store });
    const spy = vi.spyOn(store, "getSpotifyBlob").mockRejectedValueOnce(new DriverStoreUnavailableError());
    await expect(getAccessToken({ driverId: a.id })).rejects.toMatchObject({ speech: "Não consegui acessar sua conta do Spotify agora." });
    await expect(getAccessToken({ driverId: a.id })).resolves.toBeTypeOf("string");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("callback: store throwing on the SAVE after a successful exchange gives 502, the state is already burned, nothing logged", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    vi.spyOn(store, "setSpotifyBlob").mockRejectedValue(new DriverStoreUnavailableError());
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(502);
    expect(await store.consumeOAuthState(state)).toBeNull();
    expect(logged()).toBe("[]");
  });
});

describe("QA log sweep on the refresh paths and reconnect", () => {
  it("token endpoint 400/401/500 and a network error whose message carries the refresh token: nothing sensitive in console.*", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-LOGSWEEP-token", { store });
    const modes: Array<() => Response | Promise<Response>> = [
      () => json({ error: "invalid_grant", error_description: "b-LOGSWEEP-token" }, 400),
      () => json({ error: "invalid_client" }, 401),
      () => json({ error: "boom b-LOGSWEEP-token" }, 500),
      () => {
        throw new TypeError("fetch failed for refresh_token=b-LOGSWEEP-token");
      },
    ];
    for (const m of modes) {
      resetSpotifyTokenCache();
      vi.stubGlobal("fetch", vi.fn(async () => m()));
      await getAccessToken({ driverId: a.id }).catch(() => {});
    }
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: "acc-LOGSWEEP", token_type: "Bearer", expires_in: 3600, refresh_token: "b-LOGSWEEP-new" })));
    resetSpotifyTokenCache();
    await getAccessToken({ driverId: a.id });
    resetSpotifyTokenCache();
    await getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID });
    const text = logged();
    for (const secret of ["b-LOGSWEEP-token", "b-LOGSWEEP-new", "acc-LOGSWEEP", "server-owner-rt", "client-secret"]) expect(text).not.toContain(secret);
  });

  it("a Spotify Web API call that fails at the network level, with a sentinel in the error message, leaves no trace in console.* and no cause on the UserFacingError", async () => {
    const { spotifyRequest } = await import("@/lib/spotify/api");
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-API-token", { store });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u === TOKEN_URL) return json({ access_token: "acc-API", token_type: "Bearer", expires_in: 3600 });
        throw new TypeError("socket hang up Bearer acc-API refresh=b-API-token");
      }),
    );
    const err = await spotifyRequest("/me/player/pause", { method: "PUT", driverId: a.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    const text = logged();
    expect(text).not.toContain("acc-API");
    expect(text).not.toContain("b-API-token");
  });

  it("reconnecting (callback) drops the cached access token of the previous connection: the next call refreshes with the NEW token", async () => {
    const a = await newDriver("A");
    exchangeRt = "RT-first";
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    await getAccessToken({ driverId: a.id });
    expect(refreshCalls()).toHaveLength(1);
    exchangeRt = "RT-second";
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    await getAccessToken({ driverId: a.id });
    expect(refreshCalls()).toHaveLength(2);
    expect(refreshCalls()[1].body).toContain("refresh_token=RT-second");
  });
});

describe("QA vault misc", () => {
  it("cipher AAD binds the prefix of the store env, not NODE_ENV", () => {
    expect(tokenAad("drv_" + "A".repeat(22), { VERCEL_ENV: "preview" })).toBe(`finn:preview:spotify:drv_${"A".repeat(22)}`);
    expect(tokenAad("drv_" + "A".repeat(22), { NODE_ENV: "production" })).toBe(`finn:development:spotify:drv_${"A".repeat(22)}`);
  });

  it("a blob of another driver in this driver's slot reads as not connected, and 'connect' status stays false", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    await saveSpotifyRefreshToken(b.id, "b-tok", { store });
    await store.setSpotifyBlob(a.id, (await store.getSpotifyBlob(b.id)) as string);
    expect(await (await status(a.token)).json()).toEqual({ connected: false });
    await expect(getAccessToken({ driverId: a.id })).rejects.toMatchObject({ speech: "Conecte seu Spotify." });
  });

  it("the OTHER key cannot read what the first wrote, and vault status flips to false (documented reconnect)", async () => {
    const a = await newDriver("A");
    await saveSpotifyRefreshToken(a.id, "b-tok", { store });
    vi.stubEnv("FINN_TOKEN_ENC_KEY", OTHER_TEST_KEY);
    expect(await (await status(a.token)).json()).toEqual({ connected: false });
  });
});
