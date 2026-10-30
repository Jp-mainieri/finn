/**
 * QA attack on delivery 5a (dono registrado), kept as acceptance tests. Findings fixed in round 2 are asserted as
 * fixed (N1 trim, N3 live owner for legacy/A2A, N4 legacy id as value). Tests named "debt" pin what is known and
 * consciously left (N2 orphan addresses, in-flight refresh window, unreachable branch). No network, in-memory store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_OWNER_ID, registerTestOwner } from "../helpers/owner";
import {
  authorizeA2A,
  authorizeDriver,
  getOwnerDriverId,
  guardA2A,
  isOwner,
  LEGACY_OWNER_DRIVER_ID,
  resetA2ADisabledLogForTests,
  resetOwnerLogForTests,
} from "@/lib/auth";
import { handleA2ARequest } from "@/lib/a2a-server";
import type { Agent, AgentTaskInput } from "@/lib/contracts/a2a";
import { MemoryDriverStore, keyPrefix, setDriverStoreForTests, signSessionToken } from "@/lib/driver";
import { getAccessToken, getOwnerSpotifyUserId, resetSpotifyTokenCache } from "@/lib/spotify/auth";
import { createFakeSpotify, json, TEST_ENC_KEY, TOKEN_URL } from "@/lib/spotify/testing";
import { encryptToken } from "@/lib/spotify/token-crypto";
import { loadSpotifyRefreshToken, saveRotatedSpotifyRefreshToken, saveSpotifyRefreshToken, tokenAad } from "@/lib/spotify/token-vault";
import { getAddressBook, resetAddressBook } from "@/lib/waze/address-book";
import { GET as callbackGET } from "@/app/api/spotify/callback/route";
import { POST as connectPOST } from "@/app/api/spotify/connect/route";
import { DELETE as connectionDELETE, GET as connectionGET } from "@/app/api/spotify/connection/route";

const GUEST = "drv_" + "G".repeat(22);
const API = "legacy-api-token-0123456789abcdef";
const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const A2A = "9c1e47d2b86a30f5e7d4c2a91b68f03e5d7a24c9e1b0836f4a5d2c7e91f0b3a8";
const A2A_NEXT = "0123456789abcdef".repeat(4);
const CODE = "CODE-abc";
const REDIRECT = "https://finn.test/api/spotify/callback";

let store: MemoryDriverStore;
let fake: ReturnType<typeof createFakeSpotify>;
let exchanges = 0;
let nextProfile: { id: string; display_name?: string } | undefined;
const profiles = new Map<string, { id: string; display_name?: string }>();

beforeEach(() => {
  resetOwnerLogForTests();
  resetA2ADisabledLogForTests();
  resetSpotifyTokenCache();
  resetAddressBook();
  exchanges = 0;
  nextProfile = undefined;
  profiles.clear();
  store = new MemoryDriverStore(keyPrefix("development"));
  setDriverStoreForTests(store);
  vi.stubEnv("FINN_SESSION_SECRET", SECRET);
  vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
  vi.stubEnv("SPOTIFY_CLIENT_ID", "cid");
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", "csec");
  vi.stubEnv("SPOTIFY_REDIRECT_URI", REDIRECT);
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "server-owner-rt");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINN_API_TOKEN", API);
  fake = createFakeSpotify({
    me: (bearer) => (bearer ? (profiles.get(bearer) ?? { id: "owner-spotify-id", display_name: "Dono" }) : undefined),
    override: (c) => {
      if (c.url !== TOKEN_URL) return undefined;
      const form = new URLSearchParams(c.body ?? "");
      if (form.get("grant_type") !== "authorization_code") return undefined;
      const accessToken = `access-ex-${++exchanges}`;
      profiles.set(accessToken, nextProfile ?? { id: `spuser-${exchanges}`, display_name: `P${exchanges}` });
      return json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: "guest-new-rt" });
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

const bearer = (t?: string): Record<string, string> => (t ? { authorization: `Bearer ${t}` } : {});
const sessionFor = (driverId: string, tokenVersion = 1) => signSessionToken({ driverId, tokenVersion }, SECRET);
const orch = (t: string) => new Request("http://x/api/orchestrator", { headers: bearer(t) });
const connect = (t?: string) => connectPOST(new Request("https://finn.test/api/spotify/connect", { method: "POST", headers: bearer(t) }));
const status = (t?: string) => connectionGET(new Request("https://finn.test/api/spotify/connection", { headers: bearer(t) }));
const disconnect = (t?: string) => connectionDELETE(new Request("https://finn.test/api/spotify/connection", { method: "DELETE", headers: bearer(t) }));
const callback = (qs: string) => callbackGET(new Request(`https://finn.test/api/spotify/callback?${qs}`));
const authCodeCalls = () => fake.find("POST", TOKEN_URL).filter((c) => (c.body ?? "").includes("grant_type=authorization_code"));
const serverTokenUsed = () => fake.find("POST", TOKEN_URL).some((c) => (c.body ?? "").includes("refresh_token=server-owner-rt"));

async function guest(label = "Convidado") {
  const d = await store.createDriver({ label });
  return { id: d.driverId, token: sessionFor(d.driverId, d.tokenVersion), tv: d.tokenVersion };
}
async function startConnect(token: string): Promise<string> {
  const res = await connect(token);
  expect(res.status).toBe(200);
  return new URL(((await res.json()) as { url: string }).url).searchParams.get("state") as string;
}

// ---------------------------------------------------------------------------------------------
// (1) full state table
// ---------------------------------------------------------------------------------------------
describe("(1) getOwnerDriverId: full table", () => {
  const VALID = TEST_OWNER_ID;
  const L = LEGACY_OWNER_DRIVER_ID;
  // [FINN_OWNER_DRIVER_ID, FINN_LEGACY_TOKEN_ENABLED, expected owner]
  const rows: Array<[string | undefined, string | undefined, string | undefined, string]> = [
    [VALID, undefined, VALID, "valid, no flag"],
    [VALID, "1", VALID, "valid, flag 1"],
    [VALID, "0", VALID, "valid, flag 0"],
    [VALID, "true", VALID, "valid, flag true"],
    [undefined, "1", L, "no var, flag 1 -> legacy"],
    [undefined, "0", undefined, "no var, flag 0"],
    [undefined, "true", undefined, "no var, flag true"],
    [undefined, " 1", undefined, "no var, flag ' 1'"],
    [undefined, "1 ", undefined, "no var, flag '1 '"],
    [undefined, "01", undefined, "no var, flag '01'"],
    [undefined, "１", undefined, "no var, flag fullwidth 1"],
    [undefined, undefined, undefined, "nothing"],
    ["", "1", L, "empty var, flag 1"],
    ["", undefined, undefined, "empty var, no flag"],
    ["   ", "1", L, "blank var, flag 1 (invalid -> legacy)"],
    ["   ", undefined, undefined, "blank var, no flag"],
    [`${VALID}\n`, "1", VALID, "N1 fixed: trailing newline (echo | vercel env add) is trimmed, flag 1 -> the id"],
    [`${VALID}\n`, undefined, VALID, "N1 fixed: trailing newline, flag removed -> the id"],
    [` ${VALID}`, undefined, VALID, "N1 fixed: leading space is trimmed"],
    [`"${VALID}"`, undefined, undefined, "quoted"],
    [VALID.toLowerCase(), undefined, VALID.toLowerCase(), "lowercased is a DIFFERENT valid id (ids are case-sensitive): it becomes the owner, not VALID"],
    [VALID.slice(0, -1), undefined, undefined, "short"],
    [VALID + "x", undefined, undefined, "long"],
    [VALID.replace("drv_", "DRV_"), undefined, undefined, "prefix case"],
    ["drv_" + "Á".repeat(22), undefined, undefined, "non-ascii"],
    [VALID + "\u0000", undefined, undefined, "NUL"],
    [`${VALID}\n${VALID}`, undefined, undefined, "multi-line"],
    ["drv_" + "A".repeat(22) + "\n", undefined, "drv_" + "A".repeat(22), "N1 fixed: trailing newline after trim (and the regex $ trap is gone)"],
    [L, undefined, undefined, "N4 fixed: the legacy id as the VALUE of the variable is invalid, flag OFF -> nobody"],
    [L, "1", L, "var legacy id (invalid), flag 1 -> legacy through the flag"],
  ];
  for (const [v, flag, expected, label] of rows) {
    it(label, () => {
      const env = { FINN_OWNER_DRIVER_ID: v, FINN_LEGACY_TOKEN_ENABLED: flag };
      expect(getOwnerDriverId(env)).toBe(expected);
      // invariant: at most one owner among the candidates, and it is exactly `expected`
      const candidates = [...new Set([VALID, L, GUEST, v ?? "", expected ?? "", ` ${VALID}`, VALID.toLowerCase(), VALID.toUpperCase(), "drv_" + "H".repeat(22)])];
      const owners = candidates.filter((c) => isOwner(c, env));
      expect(owners).toEqual(expected === undefined ? [] : [expected]);
    });
  }

  it("non-string inputs are never owner", () => {
    const env = { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID };
    for (const x of [undefined, null, 0, {}, [TEST_OWNER_ID], new String(TEST_OWNER_ID)]) expect(isOwner(x, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// (2) legacy token and sessions
// ---------------------------------------------------------------------------------------------
describe("(2) legacy token / sessions", () => {
  it("flag variants: only exactly '1' opens the legacy door", async () => {
    for (const flag of [undefined, "", "0", "true", " 1", "1 ", "01"]) {
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", flag);
      vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
      expect(((await authorizeDriver(orch(API))) as Response).status).toBe(401);
    }
  });

  it("legacy token + flag on + owner var: real id (also '\\n'-polluted, N1 fixed); var really invalid: legacy id with 1 log", async () => {
    registerTestOwner(store);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(await authorizeDriver(orch(API))).toEqual({ driverId: TEST_OWNER_ID });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", `${TEST_OWNER_ID}\n`);
    expect(await authorizeDriver(orch(API))).toEqual({ driverId: TEST_OWNER_ID });
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    vi.stubEnv("FINN_OWNER_DRIVER_ID", `"${TEST_OWNER_ID}"`);
    expect(await authorizeDriver(orch(API))).toEqual({ driverId: LEGACY_OWNER_DRIVER_ID });
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  it("wrong / padded legacy bearer", async () => {
    registerTestOwner(store);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    for (const t of [API + "x", API.slice(1), API.toUpperCase(), ""]) expect(((await authorizeDriver(orch(t))) as Response).status).toBe(401);
    // extractBearer trims and the server value is trimmed: whitespace around the right token is accepted
    expect(await authorizeDriver(new Request("http://x", { headers: { authorization: `Bearer   ${API}  ` } }))).toEqual({ driverId: TEST_OWNER_ID });
  });

  it("a signed v1 session for the legacy id or for an owner id with NO record is 401 (cannot be minted from outside)", async () => {
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    for (const id of [LEGACY_OWNER_DRIVER_ID, TEST_OWNER_ID]) {
      expect(((await authorizeDriver(orch(sessionFor(id)))) as Response).status).toBe(401);
    }
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    expect(((await authorizeDriver(orch(sessionFor(LEGACY_OWNER_DRIVER_ID)))) as Response).status).toBe(401);
  });

  it("registered owner: session works; after rotate (tv) or revoke the old session dies; N3 fixed: revoke ALSO cuts the legacy token and A2A, rotate does not", async () => {
    const d = await store.createDriver({ label: "Dono" });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", d.driverId);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    const t = sessionFor(d.driverId, d.tokenVersion);
    expect(await authorizeDriver(orch(t))).toEqual({ driverId: d.driverId });
    vi.stubEnv("FINN_A2A_TOKEN", A2A);
    const a2a = () => guardA2A(new Request("http://x", { headers: { ...bearer(A2A), "x-forwarded-for": "203.0.113.50" } }), { store });
    await store.rotateSessions(d.driverId);
    expect(((await authorizeDriver(orch(t))) as Response).status).toBe(401); // old session dies
    expect(await authorizeDriver(orch(API))).toEqual({ driverId: d.driverId }); // legacy token lives
    expect(await a2a()).toBeNull();
    await store.revokeDriver(d.driverId);
    expect(((await authorizeDriver(orch(API))) as Response).status).toBe(401); // the legacy door looks at the record now
    expect((await a2a())?.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------------------------
// (3) A2A
// ---------------------------------------------------------------------------------------------
describe("(3) A2A", () => {
  const req = (token = A2A, ip = "203.0.113.9") => new Request("http://x/api/agents/waze", { method: "POST", headers: { ...bearer(token), "x-forwarded-for": ip } });
  const body = () =>
    new Request("http://x/api/agents/waze", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", messageId: "m", role: "user", parts: [{ kind: "text", text: "oi" }], driverId: GUEST, metadata: { driverId: GUEST } } } }),
    });
  const seen: AgentTaskInput[] = [];
  const agent = { id: "waze", handle: async (i: AgentTaskInput) => (seen.push(i), { agent: "waze", status: "completed", speech: "ok", clientActions: [], toolCalls: [] }) } as unknown as Agent;
  const exploding = () => {
    const s = new MemoryDriverStore(keyPrefix("test"));
    const boom = () => {
      throw new Error("REDIS TOUCHED");
    };
    return Object.assign(s, { peekRateLimit: boom, incrementRateLimit: boom });
  };

  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv("FINN_A2A_TOKEN", A2A);
  });

  it("no owner: 503 for right, wrong, missing and non-hex bearers, and Redis is never touched", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    for (const t of [A2A, "wrong", "", A2A_NEXT]) {
      const r = await guardA2A(req(t), { store: exploding() });
      expect(r?.status).toBe(503);
    }
    expect(authorizeA2A(req())?.status).toBe(503);
  });

  it("owner present: Redis down is 503 (unchanged), wrong bearer 401, right bearer null", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect((await guardA2A(req(), { store: exploding() }))?.status).toBe(503);
    const s = registerTestOwner(new MemoryDriverStore(keyPrefix("test")));
    expect((await guardA2A(req("0".repeat(64)), { store: s }))?.status).toBe(401);
    expect(await guardA2A(req(), { store: s })).toBeNull();
  });

  it("limiter intact: 10 failures then 429 even for the right secret; rotation secret accepted", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", A2A_NEXT);
    const s = registerTestOwner(new MemoryDriverStore(keyPrefix("test")));
    expect(await guardA2A(req(A2A_NEXT, "198.51.100.1"), { store: s })).toBeNull();
    for (let i = 0; i < 10; i++) expect((await guardA2A(req("0".repeat(64), "198.51.100.2"), { store: s }))?.status).toBe(401);
    expect((await guardA2A(req(A2A, "198.51.100.2"), { store: s }))?.status).toBe(429);
  });

  it("runs as the owner id whatever the body says (driverId in message/metadata ignored)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await handleA2ARequest(agent, body());
    expect(seen.map((s) => s.driverId)).toEqual([TEST_OWNER_ID]);
  });

  it("second lock returns JSON-RPC error with id null (HTTP 200 if the route were bypassed) and does not read the body", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    const r = new Request("http://x", { method: "POST", body: "not json" });
    const res = await handleA2ARequest(agent, r);
    expect(res.error?.message).toBe("A2A endpoint disabled");
    expect(res.id).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("route module: no owner -> 503, agent registry never reached", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    const { POST } = await import("@/app/api/agents/[agent]/route");
    const res = await POST(req(), { params: Promise.resolve({ agent: "waze" }) } as never);
    expect(res.status).toBe(503);
  });

  it("flag removed after var set: A2A stays on, as the owner (virada step 5)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    expect(authorizeA2A(req())).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// (4) caches
// ---------------------------------------------------------------------------------------------
describe("(4) module caches", () => {
  it("owner token never served to a guest or to a look-alike id; guest cache not served to the owner", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    const t = await getAccessToken({ driverId: TEST_OWNER_ID });
    for (const id of [GUEST, TEST_OWNER_ID.toLowerCase(), `${TEST_OWNER_ID} `, LEGACY_OWNER_DRIVER_ID]) {
      await expect(getAccessToken({ driverId: id })).rejects.toBeDefined();
    }
    expect(t).toBeTypeOf("string");
    const g = await guest();
    await saveSpotifyRefreshToken(g.id, "guest-rt", { store });
    const gt = await getAccessToken({ driverId: g.id });
    expect(gt).not.toBe(t);
  });

  it("forceRefresh on the owner id after loss of ownership does not use the server token", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await getAccessToken({ driverId: TEST_OWNER_ID });
    const n = fake.find("POST", TOKEN_URL).length;
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    await expect(getAccessToken({ driverId: TEST_OWNER_ID, forceRefresh: true })).rejects.toBeDefined();
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(n);
  });

  it("legacy id loses a cached owner token the moment a real owner is configured in-process", async () => {
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    await getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await expect(getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID })).rejects.toBeDefined();
  });

  it("getOwnerSpotifyUserId: no owner + token present throws before any network call, even if an id was cached before", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(await getOwnerSpotifyUserId()).toBe("owner-spotify-id");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    const n = fake.calls.length;
    await expect(getOwnerSpotifyUserId()).rejects.toThrow();
    expect(fake.calls).toHaveLength(n);
  });

  it("debt (accepted, env cannot change in prod): an in-flight owner refresh is shared with a caller that is no longer the owner", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fake.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string | URL | Request, i?: RequestInit) => {
        await gate;
        return inner(u, i);
      }),
    );
    const first = getAccessToken({ driverId: TEST_OWNER_ID });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined); // owner lost while the refresh is in flight
    const second = getAccessToken({ driverId: TEST_OWNER_ID });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a); // the ex-owner got the server token through the shared pending promise
    // ...but it is not cached for later
    await expect(getAccessToken({ driverId: TEST_OWNER_ID })).rejects.toBeDefined();
  });

  it("an in-flight refresh started as GUEST that finishes after the id became owner is not served as the owner's token afterwards", async () => {
    const g = await guest();
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await saveSpotifyRefreshToken(g.id, "guest-rt", { store });
    await getAccessToken({ driverId: g.id });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", g.id);
    await getAccessToken({ driverId: g.id });
    expect(serverTokenUsed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// (6)/(7) regression with the real (registered) owner and the virada script
// ---------------------------------------------------------------------------------------------
describe("(6) delivery 3/4 regression with a registered owner id", () => {
  it("owner session: connect 403, status by SPOTIFY_REFRESH_TOKEN (also when it is blank), DELETE clears blob + account link", async () => {
    const o = await guest("Dono");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", o.id);
    expect((await connect(o.token)).status).toBe(403);
    expect(await (await status(o.token)).json()).toEqual({ connected: true });
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "   ");
    expect(await (await status(o.token)).json()).toEqual({ connected: false });
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "server-owner-rt");
    // residual from the guest era
    await store.setSpotifyBlob(o.id, encryptToken("old", Buffer.from(TEST_ENC_KEY, "hex"), tokenAad(o.id, process.env)));
    await store.linkSpotifyAccount(o.id, "old-spotify-account");
    expect(await (await disconnect(o.token)).json()).toEqual({ connected: true });
    expect(await store.getSpotifyBlob(o.id)).toBeNull();
    // the account is free for someone else now
    const g = await guest();
    expect(await store.linkSpotifyAccount(g.id, "old-spotify-account")).not.toBe("conflict");
  });

  it("guest-era blob does not hijack the owner: the owner refreshes with the SERVER token", async () => {
    const o = await guest("Dono");
    await saveSpotifyRefreshToken(o.id, "blob-rt-from-guest-era", { store });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", o.id);
    await getAccessToken({ driverId: o.id });
    const bodies = fake.find("POST", TOKEN_URL).map((c) => c.body ?? "");
    expect(bodies.some((b) => b.includes("blob-rt-from-guest-era"))).toBe(false);
    expect(serverTokenUsed()).toBe(true);
    expect(await loadSpotifyRefreshToken(o.id, { store })).toBe("blob-rt-from-guest-era"); // still there until DELETE/purge
  });

  it("OAuth flow started while the registered owner was still a guest: the callback after the variable is set stores nothing and spends no code", async () => {
    const o = await guest("Dono");
    const state = await startConnect(o.token);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", o.id);
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(400);
    expect(authCodeCalls()).toHaveLength(0);
    expect(await store.getSpotifyBlob(o.id)).toBeNull();
  });

  it("callback refuses a guest who consents with the OWNER's Spotify account (/v1/me), owner = real id", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    const g = await guest();
    const state = await startConnect(g.token);
    nextProfile = { id: "owner-spotify-id", display_name: "Dono" };
    const res = await callback(`code=${CODE}&state=${state}`);
    expect(res.status).toBe(400);
    expect(await store.getSpotifyBlob(g.id)).toBeNull();
  });

  it("saveRotatedSpotifyRefreshToken refuses the owner id (defense in depth: refreshFor never calls it for the owner, so nothing else covers this line)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await expect(saveRotatedSpotifyRefreshToken(TEST_OWNER_ID, "x", { store })).rejects.toThrow();
    const g = await guest();
    await saveSpotifyRefreshToken(g.id, "old", { store });
    await expect(saveRotatedSpotifyRefreshToken(g.id, "new", { store })).resolves.toBe(true);
  });

  it("purge of the registered owner clears its blob (the dev MemoryDriverStore does not model the address hash: not verifiable here; Upstash DEL covers it, no test)", async () => {
    const o = await guest("Dono");
    await saveSpotifyRefreshToken(o.id, "x", { store });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", o.id);
    await store.purgeDriverData(o.id);
    expect(await store.getSpotifyBlob(o.id)).toBeNull();
  });
});

describe("(7) virada script: where fail-closed getOwnerSpotifyUserId bites", () => {
  async function guestCallback(): Promise<{ connect: number; callback: number; stored: string | null }> {
    const g = await guest();
    const c = await connect(g.token);
    const state = new URL(((await c.json()) as { url: string }).url).searchParams.get("state") as string;
    const res = await callback(`code=${CODE}&state=${state}`);
    return { connect: c.status, callback: res.status, stored: await loadSpotifyRefreshToken(g.id, { store }) };
  }

  it("S1 today's prod (flag 1, no var): guest connect completes", async () => {
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    expect(await guestCallback()).toEqual({ connect: 200, callback: 200, stored: "guest-new-rt" });
  });
  it("S2 flag 1 + var: completes", async () => {
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(await guestCallback()).toEqual({ connect: 200, callback: 200, stored: "guest-new-rt" });
  });
  it("S3 flag removed + var (the roteiro's end state): completes", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(await guestCallback()).toEqual({ connect: 200, callback: 200, stored: "guest-new-rt" });
  });
  it("S4 flag removed BEFORE a valid var (no owner at all): POST /connect is still 200 and the 502 happens at the CALLBACK, after the user consented; nothing stored; no server token read", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    const r = await guestCallback();
    expect(r).toEqual({ connect: 200, callback: 502, stored: null });
    expect(serverTokenUsed()).toBe(false);
  });
  it("S4b N1 fixed: a variable polluted with a newline is the owner, so the guest connect completes", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", `${TEST_OWNER_ID}\n`);
    expect(await guestCallback()).toEqual({ connect: 200, callback: 200, stored: "guest-new-rt" });
  });
  it("S5 no SPOTIFY_REFRESH_TOKEN at all: no owner is fine (owner check skipped)", async () => {
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "");
    expect(await guestCallback()).toEqual({ connect: 200, callback: 200, stored: "guest-new-rt" });
  });
  it("S6 the 502 is recoverable: once the var is fixed, a new attempt works", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", "bad");
    expect((await guestCallback()).callback).toBe(502);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect((await guestCallback()).callback).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// FINDING: addresses saved by voice under the legacy id are orphaned by the virada
// ---------------------------------------------------------------------------------------------
describe("virada and the Redis address book", () => {
  it("debt (N2, accepted): an address saved by voice while the legacy id was owner is NOT visible to the real owner id afterwards (key is per driverId); the seed is", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", JSON.stringify({ casa: "Seed Rua, 1" }));
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    await getAddressBook(LEGACY_OWNER_DRIVER_ID).set("casa", "Rua Que o Dono Ditou, 99");
    await getAddressBook(LEGACY_OWNER_DRIVER_ID).set("trabalho", "Trabalho Ditado, 5");
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBe("Rua Que o Dono Ditou, 99");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(await getAddressBook(TEST_OWNER_ID).get("casa")).toBe("Seed Rua, 1"); // dictated value lost, seed wins
    expect(await getAddressBook(TEST_OWNER_ID).get("trabalho")).toBeUndefined(); // no seed for it: lost
    // and the legacy id (now an ordinary id) keeps an orphan hash nobody can reach or purge via driver:purge (no record)
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBe("Rua Que o Dono Ditou, 99");
  });
});
