import { afterEach, describe, expect, it, vi } from "vitest";
import { GptLiveSession } from "./live-session";
import { DayLimitedError, RateLimitedError, UnauthorizedError, UnavailableError, type VoiceSessionHandlers } from "./voice-session";

/** Just enough WebRTC for `connect()` to reach the HTTP exchange. */
class FakePeerConnection {
  localDescription = { sdp: "v=0" };
  iceGatheringState = "complete";
  connectionState = "new";
  addEventListener() {}
  addTrack() {}
  createDataChannel() {
    return { addEventListener() {}, readyState: "connecting", close() {} };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

/** Connects against a stubbed `/api/realtime/session` answer and returns what `connect()` rejected with. */
async function connectWith(response: Response | (() => Response)) {
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("MediaStream", class {});
  const fetchImpl = vi.fn(async () => (typeof response === "function" ? response() : response));
  vi.stubGlobal("fetch", fetchImpl);
  const session = new GptLiveSession({
    micTrack: {} as MediaStreamTrack,
    micStream: {} as MediaStream,
    getToken: () => "v1.token",
    handlers: {} as VoiceSessionHandlers,
  });
  const error = await session.connect().then(
    () => null,
    (e: unknown) => e,
  );
  return { error, fetchImpl };
}

const body = (status: number, scope?: unknown) =>
  new Response(JSON.stringify(scope === undefined ? { error: "x" } : { error: "x", scope }), { status });

describe("GptLiveSession.connect: 429 and 503 from /api/realtime/session", () => {
  it("429 with scope 'day' is DayLimitedError", async () => {
    expect((await connectWith(body(429, "day"))).error).toBeInstanceOf(DayLimitedError);
  });

  it.each([
    ["burst", body(429, "burst")],
    ["no scope", body(429)],
    ["DAY", body(429, "DAY")],
    ["an object", body(429, { day: true })],
    ["a non-JSON body", new Response("<html>", { status: 429 })],
    ["no body", new Response(null, { status: 429 })],
  ])("429 with %s is RateLimitedError, never DayLimitedError", async (_n, res) => {
    const { error } = await connectWith(res);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).not.toBeInstanceOf(DayLimitedError);
  });

  it("503 is UnavailableError, with or without scope 'day' in the body", async () => {
    expect((await connectWith(body(503))).error).toBeInstanceOf(UnavailableError);
    const withDay = (await connectWith(body(503, "day"))).error;
    expect(withDay).toBeInstanceOf(UnavailableError);
    expect(withDay).not.toBeInstanceOf(DayLimitedError);
  });

  it.each([403, 500, 502])("%i (even with scope 'day') is a generic error, not a daily limit", async (status) => {
    const { error } = await connectWith(body(status, "day"));
    expect(error).toBeInstanceOf(Error);
    for (const type of [DayLimitedError, RateLimitedError, UnavailableError, UnauthorizedError]) expect(error).not.toBeInstanceOf(type);
  });

  it("401 stays UnauthorizedError", async () => {
    expect((await connectWith(body(401, "day"))).error).toBeInstanceOf(UnauthorizedError);
  });

  it("sends the Bearer token to the realtime route and nothing about the limit in the error", async () => {
    const { fetchImpl, error } = await connectWith(body(429, "day"));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe("/api/realtime/session");
    expect(new Headers(calls[0][1].headers).get("authorization")).toBe("Bearer v1.token");
    expect((error as Error).message).not.toMatch(/token|scope/i);
  });
});
