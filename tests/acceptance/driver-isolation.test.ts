/**
 * Delivery 3 (per-driver isolation) end to end: real route + real auth + real agents, with the scripted
 * model and the fake Spotify. Born from the qa attack tests; findings that were fixed are asserted as fixed.
 * Tests named "debt" pin behavior that is known and consciously left for later (see docs/revisoes).
 * No network: global fetch is the fake Spotify (anything else answers 599 = "Redis/Neuralake down").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as orchestratorPOST } from "@/app/api/orchestrator/route";
import { handleA2ARequest } from "@/lib/a2a-server";
import { A2A_RATE_LIMIT, authorizeA2A, guardA2A, LEGACY_OWNER_DRIVER_ID, resetA2ADisabledLogForTests } from "@/lib/auth";
import { TEST_OWNER_ID } from "../helpers/owner";
import type { Agent, AgentTaskInput } from "@/lib/contracts/a2a";
import { getDriverStore, keyPrefix, MemoryDriverStore, signSessionToken } from "@/lib/driver";
import { saveSpotifyRefreshToken } from "@/lib/spotify/token-vault";
import { createNavigateTo } from "@/agents/waze/tools";
import {
  getAddressBook,
  MemoryAddressBook,
  normalizeAddress,
  resetAddressBook,
} from "@/lib/waze/address-book";
import { SPOTIFY_CREDS, useHarness } from "../helpers/harness";
import { TEST_TOKEN } from "../helpers/http";
import { call, llm, say } from "../helpers/llm";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

const SESSION_SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const TOKEN_ENC_KEY = "0123456789abcdef".repeat(4);
const OWNER_ADDR = "Rua do Dono, 111";
const B_ADDR = "Rua do Motorista B, 222";

async function newDriver(label: string) {
  const store = getDriverStore();
  const d = await store.createDriver({ label });
  return { driver: d, token: signSessionToken({ driverId: d.driverId, tokenVersion: d.tokenVersion }, SESSION_SECRET), store };
}

function post(body: unknown, token: string, headers: Record<string, string> = {}) {
  return orchestratorPOST(
    new Request("http://x/api/orchestrator", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const logged = () =>
  JSON.stringify([
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.log).mock.calls,
  ]);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => resetAddressBook());

describe(" e2e through the real route + real auth (non-owner B with a real session token)", () => {
  const h = useHarness({
    spotify: true,
    addressBook: true,
    env: { WAZE_SAVED_ADDRESSES: JSON.stringify({ casa: OWNER_ADDR }), FINN_SESSION_SECRET: SESSION_SECRET, FINN_TOKEN_ENC_KEY: TOKEN_ENC_KEY },
  });

  it("B without a Spotify token: 'Conecte seu Spotify', zero calls to Spotify (route -> auth -> orchestrator -> agent)", async () => {
    const { token } = await newDriver("B");
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando.")] };
    const res = await post({ transcript: "toca rock nacional" }, token);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe("failed");
    expect(body.speech).toMatch(/Conecte seu Spotify/);
    expect(h.spotify.spotifyCalls).toEqual([]);
  });

  it("B with a bad stored token: server refresh token never appears in any token request", async () => {
    const { token, driver, store } = await newDriver("B");
    await saveSpotifyRefreshToken(driver.driverId, "b-stored-bad", { store });
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando.")] };
    await post({ transcript: "toca rock nacional" }, token);
    const bodies = h.spotify.callsTo("token").map((c) => c.body ?? "");
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).toContain("b-stored-bad");
      expect(b).not.toContain(SPOTIFY_CREDS.refreshToken);
    }
    expect(h.spotify.callsTo("play")).toEqual([]);
  });

  it("B with a token only in the body and in the cookie (never stored): it is ignored, zero calls to Spotify", async () => {
    const { token } = await newDriver("B");
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando.")] };
    const res = await (
      await post({ transcript: "toca rock nacional", driverContext: { spotifyRefreshToken: "b-from-body" } }, token, {
        cookie: "finn_spotify_rt=b-from-cookie; finn_spotify_token=b-from-cookie2",
      })
    ).json();
    expect(res.speech).toMatch(/Conecte seu Spotify/);
    expect(h.spotify.spotifyCalls).toEqual([]);
  });

  it("race: owner plays while B (no token) tries at the same time; B never gets the owner's access token", async () => {
    const { token } = await newDriver("B");
    h.spotify.latency.token = 30;
    llm.scripts.spotify = { turns: [call("toggle_playback", { action: "pause" }), say("Pausei.")] };
    const [rOwner, rB] = await Promise.all([
      post({ transcript: "pausa a música" }, TEST_TOKEN),
      post({ transcript: "pausa a música" }, token),
    ]);
    const owner = await rOwner.json();
    const b = await rB.json();
    expect(owner.results[0].status).toBe("completed");
    expect(b.results[0].status).toBe("failed");
    // exactly one pause reached Spotify: the owner's
    expect(h.spotify.callsTo("pause")).toHaveLength(1);
  });

  it("B asks for 'casa' while the owner has a seeded address: B is asked for its own, owner's text never in the response", async () => {
    const { token } = await newDriver("B");
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Qual é o endereço da sua casa?")] };
    const res = await post({ transcript: "me leva pra casa" }, token);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("Rua do Dono");
    expect(text).toContain("pendingLabel");
    expect(logged()).not.toContain("Rua do Dono");
  });

  it("B saves an address; the owner (legacy token) still reads the seed and B's text never reaches the owner", async () => {
    const { token } = await newDriver("B");
    llm.scripts.waze = { turns: [call("navigate_to", { destination: B_ADDR }), say("Beleza.")] };
    const ask = await post(
      { transcript: "Rua do Motorista B, 222", continuation: { agent: "waze", state: { pendingLabel: "casa" } } },
      token,
    );
    expect(ask.status).toBe(200);
    llm.reset();
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Indo.")] };
    const owner = await (await post({ transcript: "me leva pra casa" }, TEST_TOKEN)).json();
    const text = JSON.stringify(owner);
    expect(text).toContain(encodeURIComponent(OWNER_ADDR));
    expect(text).not.toContain("Motorista");
  });

  it("old PWA in cache: a driverContext in the body is ignored and save_address is never emitted (with or without it)", async () => {
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "  Rua Augusta,   123 " }), say("Certo.")] };
    const withCtx = await (
      await post(
        { transcript: "Rua Augusta, 123", driverContext: { savedAddresses: { casa: "IGNORADO" } }, continuation: { agent: "waze", state: { pendingLabel: "trabalho" } } },
        TEST_TOKEN,
      )
    ).json();
    expect(withCtx.clientActions.map((a: { type: string }) => a.type)).toEqual(["open_url"]);
    expect(JSON.stringify(withCtx)).not.toContain("IGNORADO");
    llm.reset();
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "Rua Augusta, 123" }), say("Certo.")] };
    const noCtx = await (
      await post({ transcript: "Rua Augusta, 123", continuation: { agent: "waze", state: { pendingLabel: "trabalho" } } }, TEST_TOKEN)
    ).json();
    expect(noCtx.clientActions.map((a: { type: string }) => a.type)).toEqual(["open_url"]);
  });

  it("PWA regression: owner (legacy) with a device-only 'casa' in driverContext.savedAddresses is asked again (decision 2), not silently served", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", undefined);
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Qual é o endereço da sua casa?")] };
    const res = await (await post({ transcript: "me leva pra casa", driverContext: { savedAddresses: { casa: "Só no aparelho, 9" } } }, TEST_TOKEN)).json();
    expect(res.continuation).toEqual({ agent: "waze", state: { pendingLabel: "casa" } });
    expect(JSON.stringify(res)).not.toContain("aparelho");
  });

  it("owner with a device token in body and cookie: ignored, the server token is used", async () => {
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando.")] };
    const res = await (
      await post({ transcript: "toca rock nacional", driverContext: { spotifyRefreshToken: "owner-device-bad" } }, TEST_TOKEN, {
        cookie: "finn_spotify_rt=owner-cookie-bad",
      })
    ).json();
    expect(res.results[0].status).toBe("completed");
    const bodies = h.spotify.callsTo("token").map((c) => c.body ?? "");
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).toContain(SPOTIFY_CREDS.refreshToken);
      expect(b).not.toMatch(/owner-device-bad|owner-cookie-bad/);
    }
  });

  it("owner without any token: server token still works (regression)", async () => {
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando.")] };
    const res = await (await post({ transcript: "toca rock nacional" }, TEST_TOKEN)).json();
    expect(res.results[0].status).toBe("completed");
    expect(h.spotify.callsTo("play")).toHaveLength(1);
  });

  it("revoked / rotated session tokens are refused (401) before any agent runs", async () => {
    const a = await newDriver("A");
    expect((await post({ transcript: "toca rock" }, a.token)).status).toBe(200);
    await a.store.rotateSessions(a.driver.driverId);
    expect((await post({ transcript: "toca rock" }, a.token)).status).toBe(401);
    const b = await newDriver("B2");
    await b.store.revokeDriver(b.driver.driverId);
    expect((await post({ transcript: "toca rock" }, b.token)).status).toBe(401);
  });

  it("a validly signed token whose sub is the provisional legacy id has no store record: 401 (the legacy id cannot be minted)", async () => {
    const forged = signSessionToken({ driverId: LEGACY_OWNER_DRIVER_ID, tokenVersion: 1 }, SESSION_SECRET);
    expect((await post({ transcript: "toca rock" }, forged)).status).toBe(401);
  });
});

describe("Redis trouble on the Waze path", () => {
  const h = useHarness({ spotify: true, addressBook: true, env: { WAZE_SAVED_ADDRESSES: undefined } });

  it("production without KV vars: an explicit destination still navigates (the book is only needed for casa/trabalho)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("KV_REST_API_URL", undefined);
    vi.stubEnv("KV_REST_API_TOKEN", undefined);
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "Avenida Paulista, 1000" }), say("Indo.")] };
    const res = await (await post({ transcript: "me leva pra Avenida Paulista, 1000" }, TEST_TOKEN)).json();
    expect(res.results[0].status).toBe("completed");
    expect(res.clientActions).toHaveLength(1);

    llm.reset();
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Indo.")] };
    const casa = await (await post({ transcript: "me leva pra casa" }, TEST_TOKEN)).json();
    expect(casa.results[0].status).toBe("failed");
    expect(casa.speech).toBe("Não consegui acessar seus endereços agora.");
    expect(casa.clientActions).toEqual([]);
  });

  it("Redis configured but down: explicit destination still navigates; 'casa' is a short spoken failure; nothing logged", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("KV_REST_API_URL", "https://fake.upstash.example");
    vi.stubEnv("KV_REST_API_TOKEN", "fake-token");
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "Avenida Paulista, 1000" }), say("Indo.")] };
    const ok = await (await post({ transcript: "me leva pra Avenida Paulista, 1000" }, TEST_TOKEN)).json();
    expect(ok.results[0].status).toBe("completed");

    llm.reset();
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Indo.")] };
    const down = await (await post({ transcript: "me leva pra casa" }, TEST_TOKEN)).json();
    expect(down.results[0].status).toBe("failed");
    expect(down.speech).toBe("Não consegui acessar seus endereços agora.");
    expect(down.clientActions).toEqual([]);
    expect(logged()).not.toMatch(/upstash|fake-token|599/i);
    expect(h.spotify.callsTo("token")).toEqual([]);
  });

  it("Redis hung (never answers): bounded by the client timeout, spoken failure, well under the 8 s agent budget", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("KV_REST_API_URL", "https://fake.upstash.example");
    vi.stubEnv("KV_REST_API_TOKEN", "fake-token");
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: unknown, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        });
      }),
    );
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Indo.")] };
    const t0 = Date.now();
    const res = await (await post({ transcript: "me leva pra casa" }, TEST_TOKEN)).json();
    const elapsed = Date.now() - t0;
    expect(res.speech).toBe("Não consegui acessar seus endereços agora.");
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);
});

describe("AddressBook values and isolation (unit)", () => {
  it("non-owner never sees the env seed, owner does; owner writes never alter the seed nor reach B", async () => {
    const env = { FINN_OWNER_DRIVER_ID: TEST_OWNER_ID, WAZE_SAVED_ADDRESSES: JSON.stringify({ casa: OWNER_ADDR, trabalho: "Trabalho do Dono, 5" }) };
    const B = "drv_" + "B".repeat(22);
    const owner = getAddressBook(TEST_OWNER_ID, env);
    const b = getAddressBook(B, env);
    expect(await owner.get("casa")).toBe(OWNER_ADDR);
    expect(await b.get("casa")).toBeUndefined();
    await owner.set("casa", "Nova casa do dono, 7");
    expect(await getAddressBook(TEST_OWNER_ID, env).get("casa")).toBe("Nova casa do dono, 7");
    expect(await getAddressBook(TEST_OWNER_ID, env).get("trabalho")).toBe("Trabalho do Dono, 5");
    expect(await b.get("casa")).toBeUndefined();
    await b.set("trabalho", "Trabalho do B");
    expect(await getAddressBook(TEST_OWNER_ID, env).get("trabalho")).toBe("Trabalho do Dono, 5");
  });

  it("hostile ids and labels never become keys", async () => {
    for (const id of ["", "drv_short", "drv_" + "A".repeat(21) + ":", "../x", "drv_" + "A".repeat(23), `${TEST_OWNER_ID} `, TEST_OWNER_ID.toUpperCase()]) {
      expect(() => getAddressBook(id, {})).toThrow();
    }
    const book = new MemoryAddressBook("drv_" + "A".repeat(22));
    for (const label of ["__proto__", "constructor", "toString", "Casa", "casa "]) {
      expect(await book.get(label as never)).toBeUndefined();
      await expect(book.set(label as never, "Rua X")).rejects.toThrow();
    }
  });

  it("normalizeAddress: length counts UTF-16 units; invisible, reordering and unpaired characters are rejected", () => {
    const accepts = (v: string) => {
      try {
        normalizeAddress(v);
        return true;
      } catch {
        return false;
      }
    };
    expect(accepts("a".repeat(200))).toBe(true);
    expect(accepts("a".repeat(201))).toBe(false);
    expect(accepts("😀".repeat(100))).toBe(true); // 200 UTF-16 units
    expect(accepts("😀".repeat(101))).toBe(false);
    expect(accepts("Rua X\u0000")).toBe(false);
    expect(accepts("Rua X\u001b[31m")).toBe(false);
    expect(accepts("Rua X\u0085")).toBe(false);
    expect({
      ls: accepts("Rua X\u2028Y"),
      rlo: accepts("Rua \u202eX"),
      zwsp: accepts("Rua\u200bX"),
      lone: accepts("Rua \ud800"),
    }).toEqual({ ls: false, rlo: false, zwsp: false, lone: false });
    expect(normalizeAddress("  Rua X  ")).toBe("Rua X");
  });

  it("a lone surrogate answer is rejected: nothing is saved, the label stays pending and 'casa' keeps working", async () => {
    const id = "drv_" + "C".repeat(22);
    const book = new MemoryAddressBook(id);
    const input = { transcript: "", contextId: "c", driverId: id, driverContext: {} } as AgentTaskInput;
    const out = await createNavigateTo(book, { pendingLabel: "casa" })({ destination: "Rua \ud800" }, input);
    expect(out).toEqual({ result: { needs_address: "casa", invalid_address: true }, continuation: { pendingLabel: "casa" } });
    expect(await book.get("casa")).toBeUndefined();
    const again = await createNavigateTo(book, undefined)({ destination: "casa" }, input);
    expect(again.result).toEqual({ needs_address: "casa" });
  });
});

describe("A2A limiter and rotation (unit)", () => {
  const A2A = "9c1e47d2b86a30f5e7d4c2a91b68f03e5d7a24c9e1b0836f4a5d2c7e91f0b3a8";
  const WRONG = "e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9f0"; // 64 hex, not a secret
  const req = (auth: string, ip = "1.2.3.4") =>
    new Request("http://x/api/agents/waze", { method: "POST", headers: { authorization: auth, "x-vercel-forwarded-for": ip } });
  beforeEach(() => {
    resetA2ADisabledLogForTests();
    vi.stubEnv("FINN_A2A_TOKEN", A2A);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("debt: 50 parallel wrong guesses from one IP all get 401; the limit of 10 is not enforced against a burst", async () => {
    const store = new MemoryDriverStore(keyPrefix("test"));
    const out = await Promise.all(Array.from({ length: 50 }, () => guardA2A(req(`Bearer ${WRONG}`), { store })));
    expect(out.filter((r) => r?.status === 401)).toHaveLength(50);
    expect(out.filter((r) => r?.status === 429)).toHaveLength(0);
    expect(await store.peekRateLimit("ratelimit:a2a:1.2.3.4")).toBe(50);
    expect((await guardA2A(req(`Bearer ${A2A}`), { store }))?.status).toBe(429); // only the NEXT request is stopped
  });

  it("sequential: exactly 10 x 401, then 429 for wrong and right secret", async () => {
    const store = new MemoryDriverStore(keyPrefix("test"));
    const seq: number[] = [];
    for (let i = 0; i < A2A_RATE_LIMIT.max + 2; i++) seq.push((await guardA2A(req(`Bearer ${WRONG}`), { store }))!.status);
    expect(seq).toEqual([...Array(10).fill(401), 429, 429]);
  });

  it("NEXT equal to TOKEN in another letter case is rejected: the endpoint is off (503)", () => {
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", A2A.toUpperCase());
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(authorizeA2A(req(`Bearer ${A2A}`))?.status).toBe(503);
    expect(authorizeA2A(req(`Bearer ${A2A.toUpperCase()}`))?.status).toBe(503);
  });

  it("garbage Authorization shapes are a plain 401 that never reaches the store and is not counted", async () => {
    const store = new MemoryDriverStore(keyPrefix("test"));
    for (const h of ["", "Bearer", "Bearer ", "Basic abc", `bearer ${A2A}`, `Bearer ${A2A} x`, `Bearer  ${A2A}x`]) {
      const r = await guardA2A(new Request("http://x", { method: "POST", headers: h ? { authorization: h, "x-vercel-forwarded-for": "9.9.9.9" } : { "x-vercel-forwarded-for": "9.9.9.9" } }), { store });
      expect(r?.status).toBe(401);
    }
    expect(await store.peekRateLimit("ratelimit:a2a:9.9.9.9")).toBe(0);
  });

  it("debt: all requests without a usable IP share one 'noip' bucket (limit 3): an attacker without IP locks out a legitimate client without IP", async () => {
    const store = new MemoryDriverStore(keyPrefix("test"));
    const WRONG = "e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9f0";
    const noIp = (auth: string) => new Request("http://x", { method: "POST", headers: { authorization: auth } });
    for (let i = 0; i < 3; i++) await guardA2A(noIp(`Bearer ${WRONG}`), { store });
    expect((await guardA2A(noIp(`Bearer ${A2A}`), { store }))?.status).toBe(429);
  });
});

describe("A2A request parsing and continuation hostility", () => {
  const seen: AgentTaskInput[] = [];
  const agent: Agent = {
    id: "waze",
    keywords: [],
    card: () => {
      throw new Error("unused");
    },
    handle: async (input) => {
      seen.push(input);
      return { agent: "waze", status: "completed", speech: "ok", clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=x", label: "x" }], toolCalls: [{ name: "n", arguments: { a: "secret addr" }, result: "r", ok: true }] };
    },
  };
  const rpc = (body: unknown) => handleA2ARequest(agent, new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  beforeEach(() => {
    seen.length = 0;
  });

  it.each([
    ["body null", "null"],
    ["body array", "[]"],
    ["body number", "5"],
    ["params null", { jsonrpc: "2.0", id: 1, method: "message/send", params: null }],
    ["message null", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: null } }],
    ["parts object", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: { 0: { kind: "text", text: "x" } } } } }],
    ["parts with nulls and numbers", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [null, 5, "s", { kind: "text", text: 7 }] } } }],
    ["id is an object", { jsonrpc: "2.0", id: { a: 1 }, method: "message/send", params: { message: { parts: [] } } }],
  ])("%s: never throws, never reaches the agent", async (_n, body) => {
    const res = await rpc(body);
    expect(res.jsonrpc).toBe("2.0");
    expect("error" in res).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("driverId is fixed to the owner whatever the body says; contextId is bounded; public artifact has 3 keys", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      driverId: "drv_" + "Z".repeat(22),
      params: {
        driverId: "drv_" + "Z".repeat(22),
        message: {
          contextId: "c".repeat(129),
          driverId: "drv_" + "Z".repeat(22),
          parts: [
            { kind: "text", text: "vai pra Rua A" },
            { kind: "data", data: { driverId: "drv_" + "Z".repeat(22), continuation: { driverId: "drv_" + "Z".repeat(22), pendingLabel: "casa" } } },
          ],
        },
      },
    });
    expect(seen[0].driverId).toBe(TEST_OWNER_ID);
    expect(seen[0].contextId).not.toBe("c".repeat(129));
    expect("result" in res && Object.keys(res.result!.artifacts[0].parts[0].data).sort()).toEqual(["agent", "speech", "status"]);
    expect(JSON.stringify(res)).not.toMatch(/secret addr|waze\.com|toolCalls|clientActions/);
  });

  it("non-JSON-safe continuation sizes: exactly 2048 bytes passes, 2049 does not, multibyte counts bytes", async () => {
    const mk = (n: number) => ({ p: "x".repeat(n) });
    const overhead = JSON.stringify(mk(0)).length;
    await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "a" }, { kind: "data", data: { continuation: mk(2048 - overhead) } }] } } });
    await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "a" }, { kind: "data", data: { continuation: mk(2049 - overhead) } }] } } });
    await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "a" }, { kind: "data", data: { continuation: { p: "é".repeat(1100) } } }] } } });
    expect(seen.map((s) => s.continuation !== undefined)).toEqual([true, false, false]);
  });

  it("real waze agent: hostile continuation shapes are ignored (no pendingLabel write, model sees the plain prompt)", async () => {
    const { parseContinuation } = await import("@/agents/waze/tools");
    for (const hostile of [
      { pendingLabel: "__proto__" },
      { pendingLabel: ["casa"] },
      { pendingLabel: "Casa" },
      { awaitingDestination: "true" },
      { awaitingDestination: 1 },
      "casa",
      5,
      [],
      { agent: "waze", state: { pendingLabel: "casa" } }, // orchestrator envelope sent to the agent by mistake
      JSON.parse('{"__proto__": {"pendingLabel": "casa"}}'),
    ]) {
      expect(parseContinuation(hostile)).toBeUndefined();
    }
    // Both keys: pendingLabel wins (precedence), still a closed shape.
    expect(parseContinuation({ pendingLabel: "casa", awaitingDestination: true, extra: 1 })).toEqual({ pendingLabel: "casa" });
  });
});

describe("hostile bodies and cookies on /api/orchestrator (after auth)", () => {
  useHarness({ spotify: true, addressBook: true, env: { FINN_SESSION_SECRET: SESSION_SECRET } });

  it.each([
    ["string", "x"],
    ["number", 5],
    ["array", []],
    ["envelope with agent object", { agent: {}, state: {} }],
    ["envelope with proto agent", JSON.parse('{"agent":"__proto__","state":{"pendingLabel":"casa"}}')],
    ["unknown agent", { agent: "admin", state: { pendingLabel: "casa" } }],
  ])("hostile continuation (%s) never 500s and never writes an address", async (_n, continuation) => {
    llm.scripts.waze = { turns: [say("Pra onde?")] };
    llm.scripts.spotify = { turns: [say("Pronto.")] };
    const res = await post({ transcript: "toca rock", continuation }, TEST_TOKEN);
    expect(res.status).toBe(200);
    expect(await getAddressBook(TEST_OWNER_ID, {}).get("casa")).toBeUndefined();
  });

  it("forged waze continuation + keywordless transcript: runs the waze agent and may overwrite the caller's OWN book only", async () => {
    const { token } = await newDriver("B");
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "Lugar Qualquer, 1" }), say("Certo.")] };
    await post({ transcript: "bom dia", continuation: { agent: "waze", state: { pendingLabel: "casa" } } }, token);
    expect(llm.callsFor("waze").length).toBeGreaterThan(0);
    expect(await getAddressBook(TEST_OWNER_ID, {}).get("casa")).toBeUndefined();
  });

  it("JSON body 'null' is 400 and a malformed %-escape in the Spotify cookie is ignored (no unhandled exception)", async () => {
    const nullBody = await orchestratorPOST(
      new Request("http://x/api/orchestrator", { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body: "null" }),
    );
    expect(nullBody.status).toBe(400);
    llm.scripts.spotify = { turns: [say("Pronto.")] };
    const badCookie = await post({ transcript: "toca rock" }, TEST_TOKEN, { cookie: "finn_spotify_rt=%E0%A4%A" });
    expect(badCookie.status).toBe(200);
  });
});
