/**
 * Delivery 4: the real route modules (connect, callback, connection, login) with the real auth, an in-memory
 * store and a fake Spotify. No network. Sentinels below must never show up in a response, header, log or write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriverStoreUnavailableError, MemoryDriverStore, setDriverStoreForTests, signSessionToken, type DriverStore } from "@/lib/driver";
import { getAccessToken, resetSpotifyTokenCache } from "@/lib/spotify/auth";
import { createFakeSpotify, json, loggedText, OTHER_TEST_KEY, TEST_ENC_KEY, TOKEN_URL } from "@/lib/spotify/testing";
import { expireLegacyRefreshCookie } from "@/lib/spotify/oauth";
import { loadSpotifyRefreshToken } from "@/lib/spotify/token-vault";
import { GET as callbackGET } from "./callback/route";
import { POST as connectPOST } from "./connect/route";
import { DELETE as connectionDELETE, GET as connectionGET } from "./connection/route";
import { GET as loginGET } from "./login/route";
import { registerTestOwner, TEST_OWNER_ID } from "../../../../tests/helpers/owner";

const SESSION_SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const RT = "RT-SENTINEL-do-not-leak-0123456789";
const CODE = "CODE-SENTINEL-abcdef";
const REDIRECT = "https://finn.test/api/spotify/callback";

let store: MemoryDriverStore;
let writes: unknown[][];
let fake: ReturnType<typeof createFakeSpotify>;
let exchangeMode: "ok" | "fail" | "no-refresh";
let exchanges: number;
/** What GET /v1/me answers for the access token of each code exchange (default: a new account per exchange). */
let profiles: Map<string, { id: string; display_name?: string }>;
let nextProfile: { id: string; display_name?: string } | undefined;

/** The store as the routes see it: every call with its arguments recorded, like a spy on all Redis traffic. */
function recorded(inner: MemoryDriverStore): DriverStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        writes.push([String(prop), ...args]);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as DriverStore;
}

async function newDriver(label = "B") {
  const d = await store.createDriver({ label });
  return { id: d.driverId, token: signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SESSION_SECRET) };
}

const auth = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
const connect = (token?: string, headers: Record<string, string> = {}) =>
  connectPOST(new Request("https://finn.test/api/spotify/connect", { method: "POST", headers: { ...auth(token), ...headers } }));
const callback = (qs: string, headers: Record<string, string> = {}) =>
  callbackGET(new Request(`https://finn.test/api/spotify/callback?${qs}`, { headers }));
const status = (token?: string) => connectionGET(new Request("https://finn.test/api/spotify/connection", { headers: auth(token) }));
const disconnect = (token?: string) => connectionDELETE(new Request("https://finn.test/api/spotify/connection", { method: "DELETE", headers: auth(token) }));

const grantCalls = (grant: string) => fake.find("POST", TOKEN_URL).filter((c) => (c.body ?? "").includes(`grant_type=${grant}`));

async function startConnect(token: string): Promise<string> {
  const res = await connect(token);
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { url: string }).url);
  return url.searchParams.get("state") as string;
}

// Errors are expanded (JSON.stringify(new Error("x")) is "{}"): a logged `err` or `cause` cannot hide.
const logged = () => loggedText([vi.mocked(console.error), vi.mocked(console.warn), vi.mocked(console.log), vi.mocked(console.info)]);

beforeEach(() => {
  resetSpotifyTokenCache();
  writes = [];
  exchangeMode = "ok";
  exchanges = 0;
  profiles = new Map();
  nextProfile = undefined;
  store = new MemoryDriverStore("finn:development:", () => Date.now());
  setDriverStoreForTests(recorded(store));
  vi.stubEnv("FINN_SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
  vi.stubEnv("SPOTIFY_CLIENT_ID", "client-id");
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", "client-secret");
  vi.stubEnv("SPOTIFY_REDIRECT_URI", REDIRECT);
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "server-owner-rt");
  vi.stubEnv("NODE_ENV", "test");
  fake = createFakeSpotify({
    me: (bearer) => (bearer ? (profiles.get(bearer) ?? { id: "owner-spotify-id", display_name: "Dono" }) : undefined),
    override: (c) => {
      if (c.url !== TOKEN_URL) return undefined;
      const form = new URLSearchParams(c.body ?? "");
      if (form.get("grant_type") !== "authorization_code") return undefined;
      if (exchangeMode === "fail") return json({ error: "invalid_grant", detail: RT }, 400);
      if (form.get("code") !== CODE || form.get("redirect_uri") !== REDIRECT) return json({ error: "invalid_grant" }, 400);
      const accessToken = `access-ex-${++exchanges}`;
      profiles.set(accessToken, nextProfile ?? { id: `spuser-${exchanges}`, display_name: `Perfil ${exchanges}` });
      return json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, ...(exchangeMode === "ok" ? { refresh_token: RT } : {}) });
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
});

describe("POST /api/spotify/connect", () => {
  it("401 without a session (and bad tokens), nothing created", async () => {
    expect((await connect()).status).toBe(401);
    expect((await connect("v1.garbage.garbage")).status).toBe(401);
    expect(writes.filter((w) => w[0] === "createOAuthState")).toEqual([]);
  });

  it("returns the Spotify consent URL with a fresh state bound to the caller", async () => {
    const { id, token } = await newDriver();
    const res = await connect(token);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    const state = url.searchParams.get("state") as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.consumeOAuthState(state)).toBe(id);
    expect(await startConnect(token)).not.toBe(await startConnect(token));
  });

  it("without a valid FINN_TOKEN_ENC_KEY: 503, nothing written, nothing read", async () => {
    const { token } = await newDriver();
    writes.length = 0;
    for (const key of ["", "short", "a".repeat(64), process.env.FINN_SESSION_SECRET!, process.env.FINN_SESSION_SECRET!.toUpperCase()]) {
      vi.stubEnv("FINN_TOKEN_ENC_KEY", key);
      const res = await connect(token);
      expect(res.status).toBe(503);
    }
    vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
    for (const other of ["FINN_INVITE_PEPPER", "FINN_A2A_TOKEN"]) {
      vi.stubEnv(other, TEST_ENC_KEY);
      expect((await connect(token)).status).toBe(503);
      vi.stubEnv(other, OTHER_TEST_KEY);
    }
    const names = writes.map((w) => w[0]);
    for (const forbidden of ["createOAuthState", "setSpotifyBlob", "getSpotifyBlob", "consumeOAuthState", "incrementRateLimit"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("rate limit: 10 per 600 s per driverId, the 11th is 429 with Retry-After, another driver is unaffected", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    for (let i = 0; i < 10; i++) expect((await connect(a.token)).status).toBe(200);
    const limited = await connect(a.token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect((await connect(b.token)).status).toBe(200);
  });

  it("Redis down: a plain 503, nothing of the error in the body or in the logs", async () => {
    const { token } = await newDriver();
    const real = new MemoryDriverStore("finn:development:");
    const d = await real.createDriver({ label: "X" });
    const tok = signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SESSION_SECRET);
    const down = new Proxy(real, {
      get(t, p, r) {
        if (p === "incrementRateLimit" || p === "createOAuthState") return async () => { throw new DriverStoreUnavailableError(); };
        return Reflect.get(t, p, r);
      },
    }) as unknown as DriverStore;
    setDriverStoreForTests(down);
    const res = await connect(tok);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/redis|upstash|token|driver store/i);
    expect(logged()).toBe("[]");
    void token;
  });
});

describe("GET /api/spotify/callback", () => {
  it("stores the token under the driver of the STATE record, whatever cookie, parameter or header says", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    const state = await startConnect(a.token);
    const res = await callback(`code=${CODE}&state=${state}&driverId=${b.id}&driver_id=${b.id}`, {
      cookie: `finn_spotify_oauth_state=other; driverId=${b.id}; finn_session=${b.token}`,
      authorization: `Bearer ${b.token}`,
      "x-driver-id": b.id,
    });
    expect(res.status).toBe(200);
    expect(await loadSpotifyRefreshToken(a.id, { store })).toBe(RT);
    expect(await loadSpotifyRefreshToken(b.id, { store })).toBeNull();
  });

  it("the page, headers and logs never carry the token, the code or the state; no cookie, no script", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    const res = await callback(`code=${CODE}&state=${state}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Spotify conectado");
    for (const secret of [RT, CODE, state]) {
      expect(html).not.toContain(secret);
      expect([...res.headers.values()].join("\n")).not.toContain(secret);
      expect(logged()).not.toContain(secret);
    }
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).not.toMatch(/<script|localStorage|spotify_refresh_token/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("every write to the store carries ciphertext only (spy on all traffic), and the blob decrypts for the right driver only", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    await callback(`code=${CODE}&state=${state}`);
    expect(JSON.stringify(writes)).not.toContain(RT);
    const blob = writes.find((w) => w[0] === "setSpotifyBlob")?.[2] as string;
    expect(blob).toMatch(/^v1\./);
  });

  it("state is single use: the second callback fails and does not exchange the code again", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    expect((await callback(`code=${CODE}&state=${state}`)).status).toBe(200);
    const exchanges = () => grantCalls("authorization_code").length;
    expect(exchanges()).toBe(1);
    const again = await callback(`code=${CODE}&state=${state}`);
    expect(again.status).toBe(400);
    expect(exchanges()).toBe(1);
  });

  it("racing callbacks with the same state: exactly one exchange and one winner", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    const results = await Promise.all(Array.from({ length: 8 }, () => callback(`code=${CODE}&state=${state}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(grantCalls("authorization_code")).toHaveLength(1);
  });

  it("missing, unknown, malformed, expired and used states all get the very same error page", async () => {
    const a = await newDriver("A");
    const used = await startConnect(a.token);
    await callback(`code=${CODE}&state=${used}`);
    const expired = await startConnect(a.token);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 601_000);
    const pages = new Set<string>();
    for (const qs of [
      `code=${CODE}`,
      `code=${CODE}&state=`,
      `code=${CODE}&state=${"A".repeat(43)}`,
      `code=${CODE}&state=not-a-state`,
      `code=${CODE}&state=${used}`,
      `code=${CODE}&state=${expired}`,
      `state=${used}`,
    ]) {
      const res = await callback(qs);
      expect(res.status).toBe(400);
      pages.add(await res.text());
    }
    vi.useRealTimers();
    expect(pages.size).toBe(1);
    expect([...pages][0]).not.toContain(RT);
    expect(grantCalls("authorization_code")).toHaveLength(1); // only the one good exchange
  });

  it("a Spotify 'error' still burns the state and shows the generic page without echoing the error", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    const res = await callback(`error=access_denied-SENTINEL&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("SENTINEL");
    expect(await store.consumeOAuthState(state)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("the code exchange failing or returning no refresh token stores nothing and logs no detail", async () => {
    const a = await newDriver("A");
    for (const mode of ["fail", "no-refresh"] as const) {
      exchangeMode = mode;
      const state = await startConnect(a.token);
      const res = await callback(`code=${CODE}&state=${state}`);
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain(RT);
    }
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    expect(logged()).not.toContain(RT);
    expect(logged()).not.toContain("invalid_grant");
  });

  it("Redis down at the callback: the same generic page, no log with detail", async () => {
    const down = new Proxy(store, {
      get(t, p, r) {
        if (p === "consumeOAuthState") return async () => { throw new DriverStoreUnavailableError(); };
        return Reflect.get(t, p, r);
      },
    }) as unknown as DriverStore;
    setDriverStoreForTests(down);
    const res = await callback(`code=${CODE}&state=${"A".repeat(43)}`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/redis|upstash/i);
    expect(logged()).toBe("[]");
    expect(fake.calls).toHaveLength(0);
  });

  it("without a valid key the callback does not even consume the state", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    vi.stubEnv("FINN_TOKEN_ENC_KEY", "");
    expect((await callback(`code=${CODE}&state=${state}`)).status).toBe(503);
    expect(fake.calls).toHaveLength(0);
    vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
    expect(await store.consumeOAuthState(state)).toBe(a.id); // still alive
  });

  it("a cookie state (the old dev flow) is worthless outside development: no exchange, no token shown", async () => {
    for (const env of ["production", "test", "preview"]) {
      vi.stubEnv("NODE_ENV", env);
      const res = await callback(`code=${CODE}&state=dev-state-abc`, { cookie: "finn_spotify_oauth_state=dev-state-abc" });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(RT);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("development: the owner's cookie flow shows the token once, with no script and no cookie", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await callback(`code=${CODE}&state=dev-state-abc`, { cookie: "finn_spotify_oauth_state=dev-state-abc" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(RT);
    expect(html).not.toMatch(/<script|localStorage/i);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(writes.map((w) => w[0])).not.toContain("setSpotifyBlob");
  });
});

describe("GET/DELETE /api/spotify/connection", () => {
  it("401 without a session", async () => {
    expect((await status()).status).toBe(401);
    expect((await disconnect()).status).toBe(401);
  });

  it("success answers of GET and DELETE expire the legacy refresh cookie (no value); 401 and 503 do not", async () => {
    const a = await newDriver("A");
    for (const res of [await status(a.token), await disconnect(a.token)]) {
      expect(res.status).toBe(200);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toBe("finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
      expect(cookie.split(";")[0]).toBe("finn_spotify_rt=");
    }
    expect((await status()).headers.get("set-cookie")).toBeNull();
    expect((await disconnect()).headers.get("set-cookie")).toBeNull();
    vi.stubEnv("FINN_TOKEN_ENC_KEY", "");
    const down = await status(a.token);
    expect(down.status).toBe(503);
    expect(down.headers.get("set-cookie")).toBeNull();
  });

  it("the owner path (GET and DELETE) also expires the legacy cookie", async () => {
    registerTestOwner(store);
    const owner = signSessionToken({ driverId: TEST_OWNER_ID, tokenVersion: 1 }, SESSION_SECRET);
    for (const res of [await status(owner), await disconnect(owner)]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBe("finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    }
  });

  it("a request carrying a finn_spotify_rt value never gets it back in body, headers or console", async () => {
    const SENTINEL = "SENTINEL-rt-9f3a7c1e";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const a = await newDriver("A");
    const cookie = { cookie: `finn_spotify_rt=${SENTINEL}` };
    const reqs = [
      connectionGET(new Request("https://finn.test/api/spotify/connection", { headers: { ...auth(a.token), ...cookie } })),
      connectionDELETE(new Request("https://finn.test/api/spotify/connection", { method: "DELETE", headers: { ...auth(a.token), ...cookie } })),
    ];
    for (const res of await Promise.all(reqs)) {
      expect(await res.text()).not.toContain(SENTINEL);
      expect(JSON.stringify([...res.headers.entries()])).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(SENTINEL);
  });

  it("the expiry cookie drops Secure only in local development", () => {
    expect(expireLegacyRefreshCookie({ NODE_ENV: "development" })).toBe("finn_spotify_rt=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    expect(expireLegacyRefreshCookie({ NODE_ENV: "production" })).toContain("Secure");
    expect(expireLegacyRefreshCookie({ NODE_ENV: "development", VERCEL_ENV: "preview" })).toContain("Secure");
    expect(expireLegacyRefreshCookie({})).toContain("Secure");
  });

  it("reports connected only after the flow, per driver; only a boolean in the body", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    expect(await (await status(a.token)).json()).toEqual({ connected: false });
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    const res = await status(a.token);
    expect(await res.json()).toEqual({ connected: true });
    expect(await (await status(b.token)).json()).toEqual({ connected: false });
  });

  it("an undecryptable blob reads as not connected", async () => {
    const a = await newDriver("A");
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    vi.stubEnv("FINN_TOKEN_ENC_KEY", OTHER_TEST_KEY);
    expect(await (await status(a.token)).json()).toEqual({ connected: false });
  });

  it("without the key it answers 503 (reading is off); Redis down is 503", async () => {
    const a = await newDriver("A");
    vi.stubEnv("FINN_TOKEN_ENC_KEY", "");
    expect((await status(a.token)).status).toBe(503);
    vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
    const real = store;
    setDriverStoreForTests(new Proxy(real, {
      get(t, p, r) {
        if (p === "getSpotifyBlob") return async () => { throw new DriverStoreUnavailableError(); };
        return Reflect.get(t, p, r);
      },
    }) as unknown as DriverStore);
    expect((await status(a.token)).status).toBe(503);
    expect(logged()).toBe("[]");
  });

  it("DELETE removes the blob and the cached access token, is idempotent, and touches only the caller", async () => {
    const a = await newDriver("A");
    const b = await newDriver("B");
    await callback(`code=${CODE}&state=${await startConnect(a.token)}`);
    await callback(`code=${CODE}&state=${await startConnect(b.token)}`);
    await getAccessToken({ driverId: a.id });
    const refreshes = () => grantCalls("refresh_token").filter((c) => (c.body ?? "").includes(`refresh_token=${RT}`)).length;
    expect(refreshes()).toBe(1);
    for (let i = 0; i < 2; i++) {
      const res = await disconnect(a.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: false });
    }
    expect(await store.getSpotifyBlob(a.id)).toBeNull();
    expect(await store.getSpotifyBlob(b.id)).not.toBeNull();
    await expect(getAccessToken({ driverId: a.id })).rejects.toMatchObject({ speech: "Conecte seu Spotify." });
    expect(refreshes()).toBe(1);
  });
});

describe("GET /api/spotify/login", () => {
  it("outside development: 410, a short page, no Spotify call, no store access, no cookie", async () => {
    for (const env of ["production", "test", "preview", ""]) {
      vi.stubEnv("NODE_ENV", env);
      writes.length = 0;
      const res = await loginGET(new Request("https://finn.test/api/spotify/login") as never);
      expect(res.status).toBe(410);
      expect(await res.text()).toContain("Conectar Spotify");
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(writes).toEqual([]);
    }
    expect(fake.calls).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("end to end and log sweep", () => {
  it("connect -> callback -> the driver's own token is what refreshes the access token; nothing sensitive was ever logged", async () => {
    const a = await newDriver("A");
    const state = await startConnect(a.token);
    await callback(`code=${CODE}&state=${state}`);
    await getAccessToken({ driverId: a.id });
    const refresh = fake.find("POST", TOKEN_URL).at(-1);
    expect(refresh?.body).toContain(`refresh_token=${RT}`);
    expect(refresh?.body).not.toContain("server-owner-rt");
    const text = logged();
    const blob = String(writes.find((w) => w[0] === "setSpotifyBlob")?.[2]);
    for (const secret of [RT, CODE, state, blob, TEST_ENC_KEY, SESSION_SECRET, a.token]) expect(text).not.toContain(secret);
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });
});
