import { b64, makeWav } from "../../../../../tests/helpers/wav";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const jsonReq = (body: unknown, token = "s3cret") =>
  new Request("http://x/api/realtime/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const formReq = (formData: FormData, token = "s3cret") =>
  new Request("http://x/api/realtime/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: formData,
  });

describe("POST /api/realtime/transcribe", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
    vi.stubEnv("GROQ_API_KEY", "groq-key-123");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-123");
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
    const res = await POST(jsonReq({ audio: "AQID" }, "wrong-token"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON or missing audio field", async () => {
    const res1 = await POST(jsonReq({}, "s3cret"));
    expect(res1.status).toBe(400);

    const res2 = await POST(jsonReq("invalid json", "s3cret"));
    expect(res2.status).toBe(400);

    const res3 = await POST(
      new Request("http://x/api/realtime/transcribe", {
        method: "POST",
        headers: { authorization: "Bearer s3cret", "content-type": "text/plain" },
        body: "hello",
      }),
    );
    expect(res3.status).toBe(400);
  });

  it("returns 503 when neither Groq nor OpenAI is configured", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await POST(jsonReq({ audio: b64(makeWav()) }));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers Groq when GROQ_API_KEY is present and transcribes JSON audio", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "  Toca a playlist do Finn  " }, { status: 200 }),
    );

    const res = await POST(jsonReq({ audio: b64(makeWav()) }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ text: "Toca a playlist do Finn", provider: "groq" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer groq-key-123");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("falls back to OpenAI when GROQ_API_KEY is missing", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Leva pra casa" }, { status: 200 }),
    );

    const res = await POST(jsonReq({ audio: b64(makeWav()) }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ text: "Leva pra casa", provider: "openai" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-openai-123");
  });

  it("forces OpenAI if STT_PROVIDER is explicitly set to openai", async () => {
    vi.stubEnv("STT_PROVIDER", "openai");
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Pausa a música" }, { status: 200 }),
    );

    const res = await POST(jsonReq({ audio: b64(makeWav()) }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.provider).toBe("openai");
  });

  it("supports multipart/form-data upload", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Próxima faixa" }, { status: 200 }),
    );

    const form = new FormData();
    form.append("file", new Blob([makeWav()], { type: "audio/wav" }), "audio.wav");

    const res = await POST(formReq(form));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.text).toBe("Próxima faixa");
  });

  it("returns 502 on upstream error", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "rate limit" }, { status: 429 }),
    );

    const res = await POST(jsonReq({ audio: b64(makeWav()) }));
    expect(res.status).toBe(502);
  });
});
