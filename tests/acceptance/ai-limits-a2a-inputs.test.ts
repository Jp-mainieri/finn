/**
 * M3 correction round: A2A joins the per-driver ceilings, and the input-size caps of /api/orchestrator and
 * /api/realtime/transcribe. Fake store, injected clock, stubbed fetch/orchestrate/agent: no network, no paid service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestOwner, TEST_OWNER_ID } from "../helpers/owner";
import { TEST_A2A_TOKEN } from "../helpers/http";
import { b64, makeWav, pwaBytes, type WavOpts } from "../helpers/wav";
import { encodeWav16kMono } from "@/lib/voice/stt-tts-session";
import { AI_LIMITS, aiDayKey, resetAiLimitsForTests, saoPauloDay } from "@/lib/ai-limits";
import { DriverStoreUnavailableError, keyPrefix, MemoryDriverStore, setDriverStoreForTests } from "@/lib/driver";

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
  /** A WAV of exactly `total` bytes (48 kHz mono, so a whole MB stays under the 20 s limit). */
  const wavOf = (total: number) => makeWav({ rate: 48000, dataBytes: total - 44 });
  const json = (total: number, headers: Record<string, string> = {}) =>
    transcribePOST(
      new Request("http://x/api/realtime/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LEGACY}`, ...headers },
        body: JSON.stringify({ audio: b64(wavOf(total)), mimeType: "audio/wav" }),
      }),
    );
  const form = (total: number) => {
    const fd = new FormData();
    fd.append("file", new File([wavOf(total)], "a.wav", { type: "audio/wav" }));
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
    expect((await json(100, { "content-length": String(Math.floor(MB * 1.5) + 1) })).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refused audio counts toward the ceiling", async () => {
    await json(MB + 1);
    expect(store.ai().length).toBe(1);
  });
});

describe("A2A transcript cap", () => {
  const withText = (text: string) =>
    a2aPOST(
      new Request("http://x/api/agents/waze", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TEST_A2A_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { parts: [{ kind: "text", text }] } } }),
      }),
      { params: Promise.resolve({ agent: "waze" }) } as never,
    );

  it("is checked by the real handler: 2000 passes, 2001 is a -32602 with the request id and no agent call", async () => {
    const real = await vi.importActual<typeof import("@/lib/a2a-server")>("@/lib/a2a-server");
    const agent = { handle: vi.fn(async () => ({ agent: "waze", status: "completed", speech: "ok", clientActions: [], toolCalls: [] })) };
    const call = (text: string) =>
      real.handleA2ARequest(
        agent as never,
        new Request("http://x", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { parts: [{ kind: "text", text }] } } }),
        }),
      );
    expect("error" in (await call("a".repeat(2000)))).toBe(false);
    expect(agent.handle).toHaveBeenCalledTimes(1);
    const over = await call("a".repeat(2001));
    expect(over).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32602 } });
    expect(agent.handle).toHaveBeenCalledTimes(1);
    // trimmed text, and several parts are summed
    expect("error" in (await call(`   ${"a".repeat(2000)}   `))).toBe(false);
    const parts = await real.handleA2ARequest(
      agent as never,
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "message/send",
          params: { message: { parts: [{ kind: "text", text: "a".repeat(1000) }, { kind: "text", text: "b".repeat(1000) }] } },
        }),
      }),
    );
    expect(parts).toMatchObject({ error: { code: -32602 } }); // 1000 + space + 1000 = 2001
  });

  it("the route still counts the refused request", async () => {
    expect((await withText("x")).status).toBe(200);
    expect(store.ai().length).toBe(1);
  });
});

describe("owner fail-open: PWA routes keep it, A2A does not", () => {
  it("counter down (DriverStoreUnavailableError): orchestrator passes for the owner, A2A is 503 without the agent", async () => {
    store.incrementRateLimit = async (k: string) => {
      store.incs.push(k);
      throw new DriverStoreUnavailableError();
    };
    expect((await orch("toca rock")).status).toBe(200);
    expect(h.orchestrate).toHaveBeenCalledTimes(1);
    const res = await a2a();
    expect(res.status).toBe(503);
    expect(h.a2a).not.toHaveBeenCalled();
  });
});

describe("transcribe accepts only WAV PCM of at most 20 s", () => {
  const sent = (bytes: Uint8Array, o: { mimeType?: string; name?: string; type?: string; multipart?: boolean } = {}) => {
    if (o.multipart) {
      const fd = new FormData();
      fd.append("file", new File([bytes as BlobPart], o.name ?? "a.wav", { type: o.type ?? "audio/wav" }));
      return transcribePOST(
        new Request("http://x/api/realtime/transcribe", { method: "POST", headers: { authorization: `Bearer ${LEGACY}` }, body: fd }),
      );
    }
    return transcribePOST(
      new Request("http://x/api/realtime/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LEGACY}` },
        body: JSON.stringify({ audio: b64(bytes), mimeType: o.mimeType ?? "audio/wav" }),
      }),
    );
  };
  const forwarded = () => {
    const form = fetchMock.mock.calls[0][1].body as FormData;
    const file = form.get("file") as File;
    return { name: file.name, type: file.type, size: file.size };
  };
  const MODES = [{ multipart: false }, { multipart: true }];

  describe.each(MODES)("multipart=$multipart", ({ multipart }) => {
    it("what the PWA sends passes: 12 s utterance and the ~15 s manual buffer (real encoder)", async () => {
      const chunk = (frames: number) => Array.from({ length: frames }, () => new Int16Array(512).fill(5));
      for (const frames of [Math.ceil(12000 / 32) + 5, 470]) {
        fetchMock.mockClear();
        expect((await sent(encodeWav16kMono(chunk(frames)), { multipart })).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    });

    it("20 s passes, 20 s plus one sample is 400 and the service is not called", async () => {
      expect((await sent(makeWav({ dataBytes: pwaBytes(20) }), { multipart })).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockClear();
      const res = await sent(makeWav({ dataBytes: pwaBytes(20) + 2 }), { multipart });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("the boundary follows rate, channels and bits (8 kHz 8-bit mono, 48 kHz stereo 16-bit)", async () => {
      const a: WavOpts = { rate: 8000, bits: 8 };
      expect((await sent(makeWav({ ...a, dataBytes: 8000 * 20 }), { multipart })).status).toBe(200);
      expect((await sent(makeWav({ ...a, dataBytes: 8000 * 20 + 1 }), { multipart })).status).toBe(400);
      const b: WavOpts = { rate: 11025, channels: 2, bits: 16 };
      expect((await sent(makeWav({ ...b, dataBytes: 11025 * 4 * 20 }), { multipart })).status).toBe(200);
      expect((await sent(makeWav({ ...b, dataBytes: 11025 * 4 * 20 + 4 }), { multipart })).status).toBe(400);
    });

    it("opus/webm/ogg/mp3 are 415 even with a forged WAV mimeType and name; the service is not called", async () => {
      const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Uint8Array(500)]);
      const ogg = new Uint8Array([...Buffer.from("OggS"), ...new Uint8Array(500)]);
      const mp3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, ...new Uint8Array(500)]);
      for (const bytes of [webm, ogg, mp3, new Uint8Array([1, 2, 3]), new Uint8Array(100)]) {
        const res = await sent(bytes, { multipart, mimeType: "audio/wav", type: "audio/wav", name: "voice.wav" });
        expect(res.status).toBe(415);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a RIFF/WAVE that is not integer PCM is 415", async () => {
      expect((await sent(makeWav({ format: 3, bits: 32 }), { multipart })).status).toBe(415); // IEEE float
      expect((await sent(makeWav({ format: 0x11 }), { multipart })).status).toBe(415); // ADPCM
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("forged mimeType, name and type never reach the provider: always audio.wav / audio/wav", async () => {
      const res = await sent(makeWav(), { multipart, mimeType: "audio/webm;codecs=opus", name: "../../evil.webm", type: "audio/webm" });
      expect(res.status).toBe(200);
      expect(forwarded()).toMatchObject({ name: "audio.wav", type: "audio/wav" });
    });

    it("malformed WAVs are 400: truncated, zero or absurd parameters, fmt missing or after data", async () => {
      const ok = makeWav();
      const cases: Uint8Array[] = [
        ok.slice(0, 12), // RIFF/WAVE and nothing else
        ok.slice(0, 20), // fmt chunk cut short
        ok.slice(0, 44), // no audio at all
        makeWav({ rate: 0 }),
        makeWav({ channels: 0 }),
        makeWav({ bits: 0 }),
        makeWav({ channels: 3 }),
        makeWav({ rate: 4_000_000_000 }),
        makeWav({ rate: 1 }),
        makeWav({ bits: 12 }),
      ];
      const noFmt = ok.slice(); // rename "fmt " so the data chunk comes first
      noFmt.set(Buffer.from("junk"), 12);
      cases.push(noFmt);
      for (const bytes of cases) expect((await sent(bytes, { multipart })).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a lying data chunk: declared larger than the file is 400; declared small over a long file is measured by the real bytes", async () => {
      expect((await sent(makeWav({ dataBytes: 3200, declared: 640_000 }), { multipart })).status).toBe(400);
      expect((await sent(makeWav({ dataBytes: 3200, declared: 0xffffffff }), { multipart })).status).toBe(400);
      expect((await sent(makeWav({ dataBytes: pwaBytes(25), declared: 1000 }), { multipart })).status).toBe(400);
      expect((await sent(makeWav({ dataBytes: pwaBytes(25), declared: 0 }), { multipart })).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("every refused request still counts toward the ceiling", async () => {
      await sent(new Uint8Array([1, 2, 3]), { multipart }); // 415
      await sent(makeWav({ dataBytes: pwaBytes(21) }), { multipart }); // 400
      expect(store.ai().length).toBe(2);
    });
  });
});
