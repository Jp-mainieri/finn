import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST, splitIntoTtsChunks } from "./route";

const req = (body: unknown, token = "s3cret") =>
  new Request("http://x/api/realtime/tts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/realtime/tts", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-tts-secret");
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("requires bearer auth", async () => {
    const res = await POST(req({ text: "Olá" }, "bad-token"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid text", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ text: "   " }))).status).toBe(400);
    expect((await POST(req({ text: "a".repeat(1201) }))).status).toBe(400);
    expect((await POST(req("bad json"))).status).toBe(400);
  });

  it("returns 503 if OPENAI_API_KEY is not set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await POST(req({ text: "Tudo bem?" }));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls OpenAI audio speech endpoint and returns MP3 bytes", async () => {
    const mockAudioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer;
    fetchMock.mockResolvedValueOnce(
      new Response(mockAudioBytes, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );

    const res = await POST(req({ text: "Indo para o trabalho.", voice: "nova" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = await res.arrayBuffer();
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0xff, 0xfb, 0x90, 0x64]));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-tts-secret");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "nova",
      input: "Indo para o trabalho.",
      response_format: "mp3",
    });
  });

  it("returns 502 on upstream error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad gateway" }), { status: 500 }),
    );

    const res = await POST(req({ text: "Olá" }));
    expect(res.status).toBe(502);
  });

  describe("splitIntoTtsChunks", () => {
    it("keeps short text as a single chunk", () => {
      expect(splitIntoTtsChunks("Olá, tudo bem?")).toEqual(["Olá, tudo bem?"]);
    });

    it("splits text longer than maxChunkLen along sentence boundaries", () => {
      const text =
        "Iniciando trajeto para a Avenida Paulista. O tempo estimado de viagem é de 35 minutos com trânsito moderado na Marginal Pinheiros. Boa viagem e dirija com cuidado!";
      const chunks = splitIntoTtsChunks(text, 80);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(80);
      }
      expect(chunks.join(" ")).toBe(text);
    });

    it("splits long single sentences along clause or word boundaries", () => {
      const longSentence = "A".repeat(50) + ", " + "B".repeat(50) + ", " + "C".repeat(50);
      const chunks = splitIntoTtsChunks(longSentence, 80);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(80);
      }
    });

    it("returns empty array for empty or whitespace text", () => {
      expect(splitIntoTtsChunks("   ")).toEqual([]);
    });
  });
});
