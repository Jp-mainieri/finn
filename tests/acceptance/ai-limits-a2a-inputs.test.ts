/**
 * M3 correction round: A2A joins the per-driver ceilings, and the input-size caps of /api/orchestrator and
 * /api/realtime/transcribe. Fake store, injected clock, stubbed fetch/orchestrate/agent: no network, no paid service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestOwner, TEST_OWNER_ID } from "../helpers/owner";
import { TEST_A2A_TOKEN } from "../helpers/http";
import { AI_LIMITS, aiDayKey, resetAiLimitsForTests, saoPauloDay } from "@/lib/ai-limits";
import { keyPrefix, MemoryDriverStore, setDriverStoreForTests, signSessionToken } from "@/lib/driver";

const h = vi.hoisted(() => ({ orchestrate: vi.fn(), a2a: vi.fn() }));
vi.mock("@/orchestrator/orchestrate", () => ({ orchestrate: h.orchestrate }));
vi.mock("@/lib/a2a-server", () => ({ handleA2ARequest: h.a2a }));

import { POST as a2aPOST } from "@/app/api/agents/[agent]/route";
import { POST as orchestratorPOST } from "@/app/api/orchestrator/route";
import { POST as transcribePOST } from "@/app/api/realtime/transcribe/route";

const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const LEGACY = "legacy-s3cret-for-ai-limits";
const T0 = Date.UTC(2026, 9, 28, 15, 0, 0);

class SpyStore extends MemoryDriverStore {
  incs: string[] = [];
  async incrementRateLimit(key: string, w: number) {
    this.incs.push(key);
    return super.incrementRateLimit(key, w);
  }
  ai = () => this.incs.filter((k) => k.startsWith("ratelimit:ai:"));
}

let t = T0;
let store: SpyStore;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  t = T0;
  store = registerTestOwner(new SpyStore(keyPrefix("development"), () => t));
  setDriverStoreForTests(store);
  resetAiLimitsForTests(() => t);
  h.orchestrate.mockReset().mockResolvedValue({ contextId: "c", status: "completed", speech: "ok", clientActions: [] });
  h.a2a.mockReset().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: {} });
  fetchMock = vi.fn(async () => Response.json({ text: "oi" }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FINN_SESSION_SECRET", SECRET);
  vi.stubEnv("FINN_API_TOKEN", LEGACY);
  vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
  vi.stubEnv("FINN_A2A_TOKEN", TEST_A2A_TOKEN);
  vi.stubEnv("GROQ_API_KEY", "fake-groq");
  vi.stubEnv("STT_PROVIDER", "");
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAiLimitsForTests();
  setDriverStoreForTests(undefined);
});

const a2a = (token: string | null = TEST_A2A_TOKEN, agent = "waze") =>
  a2aPOST(
    new Request(`http://x/api/agents/${agent}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
    }),
    { params: Promise.resolve({ agent }) } as never,
  );
const orch = (transcript: unknown, token = LEGACY) =>
  orchestratorPOST(
    new Request("http://x/api/orchestrator", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcript }),
    }),
  );

describe("A2A (class a2a)", () => {
  it("has the same ceilings as the orchestrator", () => {
    expect(AI_LIMITS.a2a).toEqual(AI_LIMITS.orchestrator);
  });

  it("failed authentication does not count and never reaches the agent", async () => {
    expect((await a2a(null)).status).toBe(401);
    expect((await a2a("a".repeat(64))).status).toBe(401);
    expect((await a2a("short")).status).toBe(401);
    expect(store.ai()).toEqual([]);
    expect(h.a2a).not.toHaveBeenCalled();
  });

  it("counts as the owner, under its own key, before the agent runs", async () => {
    expect((await a2a()).status).toBe(200);
    expect(store.ai()).toEqual([aiDayKey("a2a", saoPauloDay(t).day, TEST_OWNER_ID)]);
    expect(h.a2a).toHaveBeenCalledTimes(1);
  });

  it("burst: ceiling + 1 is 429 without calling the agent", async () => {
    for (let i = 0; i < AI_LIMITS.a2a.burst; i++) expect((await a2a()).status).toBe(200);
    const res = await a2a();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many requests", scope: "burst" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(h.a2a).toHaveBeenCalledTimes(AI_LIMITS.a2a.burst);
  });

  it("day: ceiling + 1 is 429 scope day without calling the agent", async () => {
    const key = aiDayKey("a2a", saoPauloDay(t).day, TEST_OWNER_ID);
    for (let i = 0; i < AI_LIMITS.a2a.day; i++) await store.incrementRateLimit(key, 90000);
    const res = await a2a();
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBe("day");
    expect(h.a2a).not.toHaveBeenCalled();
  });

  it("does not use up the orchestrator counter (and the other way around)", async () => {
    for (let i = 0; i < AI_LIMITS.a2a.burst + 1; i++) await a2a();
    expect((await a2a()).status).toBe(429);
    expect((await orch("toca rock")).status).toBe(200);
    expect(store.ai().filter((k) => k.includes(":orchestrator:")).length).toBe(1);
    h.a2a.mockClear();
    resetAiLimitsForTests(() => t);
    for (let i = 0; i < AI_LIMITS.orchestrator.burst + 1; i++) await orch("x");
    expect((await orch("x")).status).toBe(429);
    expect((await a2a()).status).toBe(200);
  });

  it("an unknown agent still counts (the ceiling runs before the lookup)", async () => {
    expect((await a2a(TEST_A2A_TOKEN, "nope")).status).toBe(404);
    expect(store.ai().length).toBe(1);
  });
});

describe("orchestrator transcript cap", () => {
  it("2000 characters pass, 2001 is 400 and never reaches the orchestrator; the refused request counts", async () => {
    expect((await orch("a".repeat(2000))).status).toBe(200);
    expect(h.orchestrate).toHaveBeenCalledTimes(1);
    const res = await orch("a".repeat(2001));
    expect(res.status).toBe(400);
    expect(h.orchestrate).toHaveBeenCalledTimes(1);
    expect(store.ai().length).toBe(2);
  });

  it("the cap is on the trimmed text", async () => {
    expect((await orch(`  ${"a".repeat(2000)}   `)).status).toBe(200);
    expect((await orch(`  ${"a".repeat(2001)}   `)).status).toBe(400);
  });

  it("the burst answer comes before the size check", async () => {
    for (let i = 0; i < AI_LIMITS.orchestrator.burst; i++) await orch("a".repeat(2001));
    const res = await orch("a".repeat(2001));
    expect(res.status).toBe(429);
  });
});

describe("transcribe audio cap (1 MB of decoded audio)", () => {
  const MB = 1024 * 1024;
  const json = (bytes: number, headers: Record<string, string> = {}) =>
    transcribePOST(
      new Request("http://x/api/realtime/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LEGACY}`, ...headers },
        body: JSON.stringify({ audio: Buffer.alloc(bytes, 1).toString("base64"), mimeType: "audio/wav" }),
      }),
    );
  const form = (bytes: number) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(bytes)], "a.wav", { type: "audio/wav" }));
    return transcribePOST(
      new Request("http://x/api/realtime/transcribe", {
        method: "POST",
        headers: { authorization: `Bearer ${LEGACY}` },
        body: fd,
      }),
    );
  };

  it("JSON body, no content-length: cap passes, cap + 1 is 413 without calling the service", async () => {
    expect((await json(MB)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await json(MB + 1)).status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("multipart body: cap passes, cap + 1 is 413 without calling the service", async () => {
    expect((await form(MB)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await form(MB + 1)).status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a lying small content-length does not skip the real size check", async () => {
    expect((await json(MB + 1, { "content-length": "100" })).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a declared content-length above 1.5 x cap is refused up front", async () => {
    expect((await json(10, { "content-length": String(Math.floor(MB * 1.5) + 1) })).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refused audio counts toward the ceiling", async () => {
    await json(MB + 1);
    expect(store.ai().length).toBe(1);
  });
});
