/**
 * Delivery 5a: who the OWNER is. The owner is the only identity that uses SPOTIFY_REFRESH_TOKEN and
 * WAZE_SAVED_ADDRESSES; everybody else (including the legacy id once it stops being the owner) never reaches them.
 * Contract: docs/contratos/pwa-convite-e-dono.md. No network, no real Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_OWNER_ID } from "../../tests/helpers/owner";
import {
  authorizeA2A,
  authorizeDriver,
  getOwnerDriverId,
  guardA2A,
  isOwner,
  LEGACY_OWNER_DRIVER_ID,
  resetA2ADisabledLogForTests,
  resetOwnerLogForTests,
} from "./auth";
import { handleA2ARequest } from "./a2a-server";
import type { Agent, AgentTaskInput } from "./contracts/a2a";
import { MemoryDriverStore, keyPrefix, setDriverStoreForTests } from "./driver";
import { getAccessToken, getOwnerSpotifyUserId, resetSpotifyTokenCache } from "./spotify/auth";
import { handleConnect, handleConnectionStatus, handleDisconnect } from "./spotify/connect";
import { createFakeSpotify, stubSpotifyEnv, TEST_ENC_KEY, TOKEN_URL } from "./spotify/testing";
import { encryptToken } from "./spotify/token-crypto";
import { saveSpotifyRefreshToken, tokenAad } from "./spotify/token-vault";
import { getAddressBook, resetAddressBook } from "./waze/address-book";

const GUEST = "drv_" + "G".repeat(22);
const OTHER_VALID = "drv_" + "H".repeat(22);
const A2A = "9c1e47d2b86a30f5e7d4c2a91b68f03e5d7a24c9e1b0836f4a5d2c7e91f0b3a8";
const SEED = JSON.stringify({ casa: "Rua do Servidor, 1" });
const API = "legacy-api-token-0123456789abcdef";

const owners = (env: Record<string, string | undefined>) => ({ owner: getOwnerDriverId(env), env });

beforeEach(() => {
  resetOwnerLogForTests();
  resetA2ADisabledLogForTests();
  resetSpotifyTokenCache();
  resetAddressBook();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setDriverStoreForTests(undefined);
});

describe("getOwnerDriverId / isOwner", () => {
  it("a valid FINN_OWNER_DRIVER_ID is the owner, with or without the legacy flag", () => {
    expect(owners({ FINN_OWNER_DRIVER_ID: TEST_OWNER_ID }).owner).toBe(TEST_OWNER_ID);
    expect(owners({ FINN_OWNER_DRIVER_ID: TEST_OWNER_ID, FINN_LEGACY_TOKEN_ENABLED: "1" }).owner).toBe(TEST_OWNER_ID);
  });

  it("the legacy id is the owner only while the flag is exactly '1' and no valid variable exists", () => {
    expect(getOwnerDriverId({ FINN_LEGACY_TOKEN_ENABLED: "1" })).toBe(LEGACY_OWNER_DRIVER_ID);
    for (const flag of [undefined, "", "0", "true", " 1", "1 ", "TRUE"]) {
      expect(getOwnerDriverId({ FINN_LEGACY_TOKEN_ENABLED: flag })).toBeUndefined();
    }
  });

  it("no flag and no variable: nobody is the owner, not even the legacy id", () => {
    expect(getOwnerDriverId({})).toBeUndefined();
    for (const id of [LEGACY_OWNER_DRIVER_ID, GUEST, TEST_OWNER_ID, "", undefined, null, 5]) expect(isOwner(id, {})).toBe(false);
  });

  it("an invalid variable counts as absent (legacy if the flag is on, nobody otherwise) and logs one value-free line per process", () => {
    const bad = ["drv_short", `${TEST_OWNER_ID} `, ` ${TEST_OWNER_ID}`, TEST_OWNER_ID.toUpperCase(), "drv_" + "A".repeat(23), "drv_" + "A".repeat(21) + ":", "x"];
    for (const value of bad) {
      expect(getOwnerDriverId({ FINN_OWNER_DRIVER_ID: value })).toBeUndefined();
      expect(getOwnerDriverId({ FINN_OWNER_DRIVER_ID: value, FINN_LEGACY_TOKEN_ENABLED: "1" })).toBe(LEGACY_OWNER_DRIVER_ID);
    }
    expect(console.error).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const value of bad) expect(line).not.toContain(value);
    // empty is "absent", not "invalid": no log
    resetOwnerLogForTests();
    vi.mocked(console.error).mockClear();
    expect(getOwnerDriverId({ FINN_OWNER_DRIVER_ID: "" })).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("isOwner compares the exact id: no trim, no case folding, no prefix; a guest is never the owner", () => {
    const env = { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID };
    expect(isOwner(TEST_OWNER_ID, env)).toBe(true);
    for (const id of [` ${TEST_OWNER_ID}`, `${TEST_OWNER_ID} `, TEST_OWNER_ID.toLowerCase(), TEST_OWNER_ID.toUpperCase(), TEST_OWNER_ID.slice(0, -1), GUEST, OTHER_VALID, "", LEGACY_OWNER_DRIVER_ID]) {
      expect(isOwner(id, env)).toBe(false);
    }
  });

  it("legacy id + variable set + flag OFF: the legacy id is NOT the owner; flag ON + variable: still not (the real id is)", () => {
    expect(isOwner(LEGACY_OWNER_DRIVER_ID, { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID })).toBe(false);
    expect(isOwner(LEGACY_OWNER_DRIVER_ID, { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID, FINN_LEGACY_TOKEN_ENABLED: "1" })).toBe(false);
    expect(isOwner(TEST_OWNER_ID, { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID, FINN_LEGACY_TOKEN_ENABLED: "1" })).toBe(true);
  });

  it("reads the environment on every call (nothing cached across a change of owner)", () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(isOwner(TEST_OWNER_ID)).toBe(true);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", OTHER_VALID);
    expect(isOwner(TEST_OWNER_ID)).toBe(false);
    expect(isOwner(OTHER_VALID)).toBe(true);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    expect(isOwner(OTHER_VALID)).toBe(false);
  });
});

describe("legacy token (authorizeDriver)", () => {
  const req = () => new Request("http://x/api/orchestrator", { headers: { authorization: `Bearer ${API}` } });

  it("flag on + FINN_OWNER_DRIVER_ID: the legacy token maps to the REAL owner id, never the legacy id", async () => {
    vi.stubEnv("FINN_API_TOKEN", API);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(await authorizeDriver(req())).toEqual({ driverId: TEST_OWNER_ID });
  });

  it("flag on, variable absent or invalid: the provisional legacy id", async () => {
    vi.stubEnv("FINN_API_TOKEN", API);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    for (const v of [undefined, "", "drv_nope"]) {
      vi.stubEnv("FINN_OWNER_DRIVER_ID", v);
      expect(await authorizeDriver(req())).toEqual({ driverId: LEGACY_OWNER_DRIVER_ID });
    }
  });

  it("flag off: the legacy token opens nothing, whatever FINN_OWNER_DRIVER_ID says", async () => {
    vi.stubEnv("FINN_API_TOKEN", API);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(((await authorizeDriver(req())) as Response).status).toBe(401);
  });
});

describe("only the owner reaches SPOTIFY_REFRESH_TOKEN and WAZE_SAVED_ADDRESSES", () => {
  let fake: ReturnType<typeof createFakeSpotify>;
  let store: MemoryDriverStore;
  const refreshBodies = () => fake.find("POST", TOKEN_URL).map((c) => c.body ?? "");
  const serverTokenUsed = () => refreshBodies().some((b) => b.includes("refresh_token=refresh-token"));

  beforeEach(() => {
    stubSpotifyEnv(vi.stubEnv); // SPOTIFY_REFRESH_TOKEN = "refresh-token"
    vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
    vi.stubEnv("WAZE_SAVED_ADDRESSES", SEED);
    store = new MemoryDriverStore(keyPrefix("test"));
    setDriverStoreForTests(store);
    fake = createFakeSpotify();
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
  });

  it("owner = id of FINN_OWNER_DRIVER_ID: uses the server token and the seed", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await expect(getAccessToken({ driverId: TEST_OWNER_ID })).resolves.toBeTypeOf("string");
    expect(serverTokenUsed()).toBe(true);
    expect(await getAddressBook(TEST_OWNER_ID).get("casa")).toBe("Rua do Servidor, 1");
  });

  it("a guest never gets the server token or the seed", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await expect(getAccessToken({ driverId: GUEST })).rejects.toBeDefined(); // not connected: "Conecte seu Spotify"
    expect(refreshBodies()).toHaveLength(0);
    expect(await getAddressBook(GUEST).get("casa")).toBeUndefined();
  });

  it("legacy id with the variable set and the flag OFF is not the owner: no server token, no seed", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await expect(getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID })).rejects.toBeDefined();
    expect(refreshBodies()).toHaveLength(0);
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBeUndefined();
  });

  it("no flag and no variable: no id at all reaches the server token or the seed", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    for (const id of [LEGACY_OWNER_DRIVER_ID, TEST_OWNER_ID, GUEST]) {
      await expect(getAccessToken({ driverId: id })).rejects.toBeDefined();
      expect(await getAddressBook(id).get("casa")).toBeUndefined();
    }
    expect(refreshBodies()).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    // the account lookup of the owner fails closed too, without reading the server token
    await expect(getOwnerSpotifyUserId()).rejects.toBeDefined();
    expect(fake.calls).toHaveLength(0);
  });

  it("legacy flag on and no variable: the legacy id is the provisional owner (the car keeps its Spotify)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    await expect(getAccessToken({ driverId: LEGACY_OWNER_DRIVER_ID })).resolves.toBeTypeOf("string");
    expect(serverTokenUsed()).toBe(true);
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBe("Rua do Servidor, 1");
  });

  it("a cached owner access token does not survive the loss of ownership inside the same process", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await getAccessToken({ driverId: TEST_OWNER_ID });
    const before = refreshBodies().length;
    vi.stubEnv("FINN_OWNER_DRIVER_ID", OTHER_VALID); // another owner now; TEST_OWNER_ID is an ordinary driver
    await expect(getAccessToken({ driverId: TEST_OWNER_ID })).rejects.toBeDefined(); // not served from the cache
    expect(refreshBodies()).toHaveLength(before);
  });

  it("a guest token cache is not served to the same id once that id becomes the owner (and vice versa)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", OTHER_VALID);
    await saveSpotifyRefreshToken(GUEST, "guest-rt", { store });
    // the guest's own refresh
    await getAccessToken({ driverId: GUEST });
    expect(refreshBodies().some((b) => b.includes("refresh_token=guest-rt"))).toBe(true);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", GUEST);
    await getAccessToken({ driverId: GUEST });
    expect(serverTokenUsed()).toBe(true); // refreshed from the server token, not the cached guest token
  });

  it("the owner never uses the vault: saveSpotifyRefreshToken refuses the owner id (and only that one)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    await expect(saveSpotifyRefreshToken(TEST_OWNER_ID, "x", { store })).rejects.toThrow();
    expect(await store.getSpotifyBlob(TEST_OWNER_ID)).toBeNull();
    await expect(saveSpotifyRefreshToken(GUEST, "x", { store })).resolves.toBeUndefined();
    // the legacy id is an ordinary id once it is not the owner
    await expect(saveSpotifyRefreshToken(LEGACY_OWNER_DRIVER_ID, "x", { store })).resolves.toBeUndefined();
  });
});

describe("connect / connection routes follow the owner", () => {
  const secret = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
  let store: MemoryDriverStore;
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (t: string) => new Request("https://finn.test/api/spotify/connect", { method: "POST", headers: bearer(t) });
  const get = (t: string) => new Request("https://finn.test/api/spotify/connection", { headers: bearer(t) });
  const del = (t: string) => new Request("https://finn.test/api/spotify/connection", { method: "DELETE", headers: bearer(t) });

  beforeEach(() => {
    store = new MemoryDriverStore(keyPrefix("test"));
    setDriverStoreForTests(store);
    vi.stubEnv("FINN_API_TOKEN", API);
    vi.stubEnv("FINN_SESSION_SECRET", secret);
    vi.stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "server-rt");
  });

  it("owner via legacy token + variable: connect is 403, connection answers by SPOTIFY_REFRESH_TOKEN, DELETE clears a residual blob", async () => {
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect((await handleConnect(post(API), { store })).status).toBe(403);
    expect(await (await handleConnectionStatus(get(API), { store })).json()).toEqual({ connected: true });
    await store.setSpotifyBlob(TEST_OWNER_ID, encryptToken("old", Buffer.from(TEST_ENC_KEY, "hex"), tokenAad(TEST_OWNER_ID)));
    expect(await (await handleDisconnect(del(API), { store })).json()).toEqual({ connected: true });
    expect(await store.getSpotifyBlob(TEST_OWNER_ID)).toBeNull();
  });

  it("owner by session (invite): same 403 and the same server-token status, no legacy flag needed", async () => {
    const { signSessionToken } = await import("./driver");
    const d = await store.createDriver({ label: "Dono" });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", d.driverId);
    const t = signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, secret);
    expect((await handleConnect(post(t), { store })).status).toBe(403);
    expect(await (await handleConnectionStatus(get(t), { store })).json()).toEqual({ connected: true });
  });

  it("a guest session is never the owner: connect works, status ignores SPOTIFY_REFRESH_TOKEN", async () => {
    const { signSessionToken } = await import("./driver");
    const d = await store.createDriver({ label: "Convidado" });
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    const t = signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, secret);
    expect(await (await handleConnectionStatus(get(t), { store })).json()).toEqual({ connected: false });
    vi.stubEnv("SPOTIFY_CLIENT_ID", "cid");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "csec");
    vi.stubEnv("SPOTIFY_REDIRECT_URI", "https://finn.test/api/spotify/callback");
    expect((await handleConnect(post(t), { store })).status).toBe(200);
  });
});

describe("A2A runs as the owner; without one it is off (503)", () => {
  const req = (token = A2A) => new Request("http://x/api/agents/waze", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const body = (text: string) =>
    new Request("http://x/api/agents/waze", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", messageId: "m", role: "user", parts: [{ kind: "text", text }] } } }),
    });
  const seen: AgentTaskInput[] = [];
  const agent = { id: "waze", handle: async (i: AgentTaskInput) => (seen.push(i), { agent: "waze", status: "completed", speech: "ok", clientActions: [], toolCalls: [] }) } as unknown as Agent;

  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv("FINN_A2A_TOKEN", A2A);
  });

  it("no owner (no flag, no variable): authorizeA2A and guardA2A answer 503 'A2A endpoint disabled', even with the right secret, touching no Redis", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    expect(authorizeA2A(req())?.status).toBe(503);
    const store = new MemoryDriverStore(keyPrefix("test"));
    const peek = vi.spyOn(store, "peekRateLimit");
    const res = (await guardA2A(req(), { store }))!;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "A2A endpoint disabled" });
    expect(peek).not.toHaveBeenCalled();
  });

  it("handleA2ARequest is a second lock: without an owner the agent is never called", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", undefined);
    const res = await handleA2ARequest(agent, body("oi"));
    expect(res.error?.message).toBe("A2A endpoint disabled");
    expect(seen).toHaveLength(0);
  });

  it("with an owner: A2A runs as exactly that driverId (variable, then legacy fallback)", async () => {
    vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
    expect(authorizeA2A(req())).toBeNull();
    await handleA2ARequest(agent, body("oi"));
    expect(seen[0].driverId).toBe(TEST_OWNER_ID);
    vi.stubEnv("FINN_OWNER_DRIVER_ID", undefined);
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    await handleA2ARequest(agent, body("oi"));
    expect(seen[1].driverId).toBe(LEGACY_OWNER_DRIVER_ID);
  });
});

describe("mutation guard (documents what each test above defends)", () => {
  it("isOwner is not 'always true': an unrelated id is refused with and without an owner", () => {
    expect(isOwner(GUEST, { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID })).toBe(false);
    expect(isOwner(GUEST, {})).toBe(false);
  });
});
