import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const req = (body: unknown, token = "s3cret") =>
  new Request("http://x/api/realtime/session", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/realtime/session", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    vi.stubEnv("OPENAI_API_KEY", "sk-server-only");
    vi.stubEnv("ENABLE_GPT_LIVE", "1");
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("requires the Finn bearer token", async () => {
    const res = await POST(req({ sdp: "v=0" }, "wrong"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 403 when GPT-Live-1 is disabled by default", async () => {
    vi.stubEnv("ENABLE_GPT_LIVE", undefined);
    const res = await POST(req({ sdp: "v=0 offer" }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing SDP offer", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req("nope"))).status).toBe(400);
  });

  it("exchanges the offer with GPT-Live and returns only the session id and answer", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }, { status: 201 }),
    );

    const res = await POST(req({ sdp: "v=0 offer" }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ sessionId: "live_123", sdp: "v=0 answer" });
    expect(JSON.stringify(body)).not.toContain("sk-server-only");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-server-only");
    const sent = JSON.parse(init?.body as string);
    expect(sent.transport).toEqual({ type: "webrtc", sdp: "v=0 offer" });
    expect(sent.session).toMatchObject({ model: "gpt-live-1", delegation: { type: "client" } });
  });

  it("hides upstream errors behind a generic 502", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "secret detail" } }, { status: 403 }));
    const res = await POST(req({ sdp: "v=0 offer" }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret detail");
  });

  it("returns 503 when the OpenAI key is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await POST(req({ sdp: "v=0 offer" }))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
