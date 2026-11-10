import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/realtime/tts/route";
import { resolveTtsProvider } from "./tts-providers";

const KEY = "gem-key-SECRET-123";
const req = (body: unknown = { text: "Olá" }) =>
  new Request("http://x/api/realtime/tts", {
    method: "POST",
    headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 9, 9]);
const geminiOk = () =>
  new Response(
    JSON.stringify({
      steps: [
        { type: "user_input", content: [] },
        { type: "model_output", content: [{ type: "audio", data: Buffer.from(wav).toString("base64") }] },
      ],
    }),
    { status: 200 },
  );
const mp3 = () => new Response(new Uint8Array([0xff, 0xfb]).buffer, { status: 200 });

describe("TTS provider selection", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let logs: string[];

  beforeEach(() => {
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

  it("defaults to openai when unset or unknown", () => {
    vi.stubEnv("FINN_TTS_PROVIDER", "");
    expect(resolveTtsProvider()).toBe("openai");
    vi.stubEnv("FINN_TTS_PROVIDER", "azure");
    expect(resolveTtsProvider()).toBe("openai");
  });

  it("unset provider never touches Gemini", async () => {
    vi.stubEnv("FINN_TTS_PROVIDER", "");
    fetchMock.mockResolvedValueOnce(mp3());
    const res = await POST(req());
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.openai.com");
  });

  it("unknown provider value uses openai", async () => {
    vi.stubEnv("FINN_TTS_PROVIDER", "foo");
    fetchMock.mockResolvedValueOnce(mp3());
    await POST(req());
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.openai.com");
  });

  it("gemini happy path returns WAV and sends the documented body", async () => {
    fetchMock.mockResolvedValueOnce(geminiOk());
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(wav);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(KEY);
    const sent = JSON.parse(init?.body as string);
    expect(sent.model).toBe("gemini-3.8-flash-lite-tts");
    expect(sent.generation_config.speech_config).toEqual([{ voice: "Kore" }]);
    expect(sent.response_format).toEqual({ type: "audio" });
    expect(sent.input[0].content[0].text).toBe("Olá");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours GEMINI_TTS_MODEL and GEMINI_TTS_VOICE", async () => {
    vi.stubEnv("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts");
    vi.stubEnv("GEMINI_TTS_VOICE", "Puck");
    fetchMock.mockResolvedValueOnce(geminiOk());
    await POST(req());
    const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(sent.model).toBe("gemini-3.8-flash-tts");
    expect(sent.generation_config.speech_config).toEqual([{ voice: "Puck" }]);
  });

  const failures: [string, () => Response | Promise<Response>][] = [
    ["429", () => new Response(`quota ${KEY}`, { status: 429 })],
    ["500", () => new Response("boom", { status: 500 })],
    ["network", () => Promise.reject(new Error(`net ${KEY}`))],
    ["empty body", () => new Response(JSON.stringify({ steps: [] }), { status: 200 })],
    ["invalid json", () => new Response("not json", { status: 200 })],
  ];
  for (const [name, fail] of failures) {
    it(`gemini ${name} falls back to openai once, without leaking the key`, async () => {
      fetchMock.mockImplementationOnce(async () => fail()).mockResolvedValueOnce(mp3());
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/mpeg");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toContain("api.openai.com");
      expect(logs.join("\n")).not.toContain(KEY);
      expect(await res.text()).not.toContain(KEY);
    });
  }

  it("missing Gemini key falls back without calling Gemini", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    fetchMock.mockResolvedValueOnce(mp3());
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.openai.com");
  });

  it("both providers failing returns an error body without the key", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(`x ${KEY}`, { status: 500 }))
      .mockResolvedValueOnce(new Response("no", { status: 500 }));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });
});
