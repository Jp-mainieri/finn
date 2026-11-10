import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/realtime/tts/route";
import {
  GEMINI_MAX_AUDIO_BYTES,
  GEMINI_MAX_TEXT_CHARS,
  GEMINI_TIMEOUT_MS,
  resolveTtsProvider,
} from "./tts-providers";
import { resetAiLimitsForTests } from "@/lib/ai-limits";

const KEY = "gem-key-SECRET-123";
const req = (body: unknown = { text: "Olá" }, token = "s3cret", headers: Record<string, string> = {}) =>
  new Request("http://x/api/realtime/tts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const wavBytes = (n = 14) => {
  const u = new Uint8Array(n);
  u.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  return u;
};
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const gem = (data: unknown, extra: object = {}) =>
  new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "audio", data }] }], ...extra }), { status: 200 });
const mp3 = () => new Response(new Uint8Array([0xff, 0xfb]).buffer, { status: 200 });

// AbortSignal.timeout usa timer nativo (fake timers nao o alcancam): troca por um sinal que aborta em 20 ms reais.
const shortTimeout = () =>
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const c = new AbortController();
    setTimeout(() => c.abort(new Error("timeout")), 20);
    return c.signal;
  });

describe("tts gemini hardening", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let logs: string[];
  beforeEach(() => {
    resetAiLimitsForTests();
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-oai");
    vi.stubEnv("FINN_TTS_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", KEY);
    vi.stubGlobal("fetch", fetchMock);
    logs = [];
    for (const m of ["error", "warn", "log"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("A1 401 does not call Gemini", async () => {
    expect((await POST(req({ text: "x" }, "bad"))).status).toBe(401);
    expect((await POST(new Request("http://x/api/realtime/tts", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("A1 burst 429 does not call Gemini", async () => {
    fetchMock.mockImplementation(async () => gem(b64(wavBytes())));
    for (let i = 0; i < 20; i++) expect((await POST(req())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    const r = await POST(req());
    expect(r.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
  it("A1 invalid text / body / oversize never reach Gemini", async () => {
    expect((await POST(req({ text: "a".repeat(1201) }))).status).toBe(400);
    expect((await POST(req({ text: 5 }))).status).toBe(400);
    expect((await POST(req("nope"))).status).toBe(400);
    expect((await POST(req({ text: "x" }, "s3cret", { "content-length": "999999" }))).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("A5 text sent verbatim (trimmed) and body voice/model ignored", async () => {
    fetchMock.mockResolvedValueOnce(gem(b64(wavBytes())));
    await POST(req({ text: "  Diga 'sussurrando': olá  ", voice: "Puck", model: "evil", speech_metadata: { x: 1 } }));
    const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(sent.input[0].content[0].text).toBe("Diga 'sussurrando': olá");
    expect(sent.model).toBe("gemini-3.8-flash-lite-tts");
    expect(JSON.stringify(sent)).not.toMatch(/evil|Puck|speech_metadata/);
  });
  it("A6 provider normalisation", () => {
    for (const [v, e] of [[" GEMINI ", "gemini"], ["Gemini", "gemini"], ["", "openai"], ["   ", "openai"], ["gemini2", "openai"], ["OPENAI", "openai"]] as const) {
      vi.stubEnv("FINN_TTS_PROVIDER", v);
      expect(resolveTtsProvider()).toBe(e);
    }
    vi.unstubAllEnvs();
    expect(resolveTtsProvider()).toBe("openai");
  });
  it("T1 fetch carries an abort signal and redirect:error", async () => {
    fetchMock.mockResolvedValueOnce(gem(b64(wavBytes())));
    await POST(req());
    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
  });
  it("T1 hung Gemini aborts on timeout and falls back to openai", async () => {
    const timeoutSpy = shortTimeout();
    {
      fetchMock.mockImplementationOnce(
        (_u, init) =>
          new Promise((_r, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new Error(`aborted ${KEY}`)));
          }),
      );
      fetchMock.mockResolvedValueOnce(mp3());
      const p = POST(req());
      const res = await p;
      expect(res.headers.get("content-type")).toBe("audio/mpeg");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(logs.join("\n")).not.toContain(KEY);
      expect(timeoutSpy).toHaveBeenCalledWith(GEMINI_TIMEOUT_MS);
    }
  });
  it("T1 body stall after 200 aborts and falls back to openai", async () => {
    const timeoutSpy = shortTimeout();
    {
      fetchMock.mockImplementationOnce(async (_u, init) => {
        const stream = new ReadableStream({
          start(ctl) {
            init?.signal?.addEventListener("abort", () => ctl.error(new Error("aborted")));
          },
        });
        return new Response(stream, { status: 200 });
      });
      fetchMock.mockResolvedValueOnce(mp3());
      const p = POST(req());
      expect((await p).headers.get("content-type")).toBe("audio/mpeg");
      expect(timeoutSpy).toHaveBeenCalledWith(GEMINI_TIMEOUT_MS);
    }
  });
  it("T2 non-WAV bytes fall back to openai", async () => {
    fetchMock.mockResolvedValueOnce(gem(b64(new Uint8Array([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0])))).mockResolvedValueOnce(mp3());
    const res = await POST(req());
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("T2 RIFF without WAVE falls back to openai", async () => {
    const u = wavBytes();
    u.set([0x41, 0x56, 0x49, 0x20], 8);
    fetchMock.mockResolvedValueOnce(gem(b64(u))).mockResolvedValueOnce(mp3());
    expect((await POST(req())).headers.get("content-type")).toBe("audio/mpeg");
  });
  it("T2 base64 with junk characters falls back to openai", async () => {
    fetchMock.mockResolvedValueOnce(gem("@@AAAA@@")).mockResolvedValueOnce(mp3());
    expect((await POST(req())).headers.get("content-type")).toBe("audio/mpeg");
  });
  it("T2 all-invalid base64 falls back", async () => {
    fetchMock.mockResolvedValueOnce(gem("@@@@")).mockResolvedValueOnce(mp3());
    expect((await POST(req())).headers.get("content-type")).toBe("audio/mpeg");
  });
  it("A4 shapes: steps not array / content null / data number / data array", async () => {
    for (const body of [{ steps: "x" }, { steps: [null, 1, { type: "model_output", content: null }] }, { steps: [{ type: "model_output", content: [{ type: "audio", data: 5 }, null] }] }, null, []]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 })).mockResolvedValueOnce(mp3());
      const res = await POST(req());
      expect(res.headers.get("content-type")).toBe("audio/mpeg");
    }
  });
  it("T3 audio above the byte cap falls back to openai", async () => {
    fetchMock.mockResolvedValueOnce(gem(b64(wavBytes(GEMINI_MAX_AUDIO_BYTES + 1)))).mockResolvedValueOnce(mp3());
    expect((await POST(req())).headers.get("content-type")).toBe("audio/mpeg");
  });
  it("T3 audio exactly at the byte cap is accepted", async () => {
    fetchMock.mockResolvedValueOnce(gem(b64(wavBytes(GEMINI_MAX_AUDIO_BYTES))));
    const res = await POST(req());
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect((await res.arrayBuffer()).byteLength).toBe(GEMINI_MAX_AUDIO_BYTES);
  });
  it("T3 text above the Gemini char cap goes straight to openai", async () => {
    fetchMock.mockResolvedValueOnce(mp3());
    const res = await POST(req({ text: "a".repeat(GEMINI_MAX_TEXT_CHARS + 1) }));
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.openai.com");
  });
  it("T3 text exactly at the cap still uses Gemini", async () => {
    fetchMock.mockResolvedValueOnce(gem(b64(wavBytes())));
    const res = await POST(req({ text: "a".repeat(GEMINI_MAX_TEXT_CHARS) }));
    expect(res.headers.get("content-type")).toBe("audio/wav");
  });
  it("A2 fetch error carrying key + cause: not logged, not returned", async () => {
    const e = new TypeError("fetch failed", { cause: new Error(`https://x?key=${KEY}`) });
    fetchMock.mockRejectedValueOnce(e).mockResolvedValueOnce(mp3());
    const res = await POST(req());
    expect(logs.join("\n")).not.toContain(KEY);
    expect(await res.text()).not.toContain(KEY);
  });
  it("A5 Gemini 200 that is a text-only reply (model_output text) -> fallback", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }] }), { status: 200 }))
      .mockResolvedValueOnce(mp3());
    expect((await POST(req())).headers.get("content-type")).toBe("audio/mpeg");
  });
});
