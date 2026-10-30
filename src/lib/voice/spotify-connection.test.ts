import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SPOTIFY_MESSAGES,
  consentHref,
  disconnect,
  fetchConnection,
  isSpotifyConsentUrl,
  startConnect,
} from "./spotify-connection";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fetchOf = (...r: Array<Response | Error>) => {
  const f = vi.fn<typeof fetch>();
  for (const x of r) {
    if (x instanceof Error) f.mockRejectedValueOnce(x);
    else f.mockResolvedValueOnce(x);
  }
  return f;
};
const o = (f: ReturnType<typeof fetchOf>) => ({ fetchImpl: f });
const bearer = (f: ReturnType<typeof fetchOf>) => new Headers(f.mock.calls[0][1]?.headers).get("authorization");
const ERROR = { status: "error", message: SPOTIFY_MESSAGES.error };

describe("fetchConnection", () => {
  it("connected / not connected, with the Bearer token", async () => {
    const yes = fetchOf(json({ connected: true }));
    expect(await fetchConnection("v1.t", o(yes))).toEqual({ status: "connected" });
    expect(bearer(yes)).toBe("Bearer v1.t");
    expect(yes.mock.calls[0][0]).toBe("/api/spotify/connection");
    expect(await fetchConnection("v1.t", o(fetchOf(json({ connected: false }))))).toEqual({ status: "disconnected" });
  });

  it("503, network and bad body become the short fixed message; 401 becomes 'unauthorized'", async () => {
    expect(await fetchConnection("t", o(fetchOf(json({}, 503))))).toEqual(ERROR);
    expect(await fetchConnection("t", o(fetchOf(json({}, 401))))).toEqual({ status: "unauthorized" });
    expect(await fetchConnection("t", o(fetchOf(new TypeError("x"))))).toEqual(ERROR);
    expect(await fetchConnection("t", o(fetchOf(json({ connected: "yes" }))))).toEqual(ERROR);
  });

  it("without a token it does not call the server", async () => {
    const f = fetchOf();
    expect(await fetchConnection(null, o(f))).toEqual({ status: "unknown" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("disconnect", () => {
  it("DELETE; a driver ends up disconnected", async () => {
    const f = fetchOf(json({ connected: false }));
    expect(await disconnect("t", o(f))).toEqual({ status: "disconnected" });
    expect(f.mock.calls[0][1]?.method).toBe("DELETE");
  });
  it("the owner stays connected through the server token", async () => {
    expect(await disconnect("t", o(fetchOf(json({ connected: true }))))).toEqual({ status: "owner" });
  });
  it("503 is a fixed message, 401 is 'unauthorized'", async () => {
    expect(await disconnect("t", o(fetchOf(json({}, 503))))).toEqual(ERROR);
    expect(await disconnect("t", o(fetchOf(json({}, 401))))).toEqual({ status: "unauthorized" });
  });
});

describe("consent URL allow-list", () => {
  it.each([
    "https://accounts.spotify.com/authorize?client_id=x&state=y",
    "https://accounts.spotify.com/authorize",
  ])("accepts %s", (u) => expect(isSpotifyConsentUrl(u)).toBe(true));

  it.each([
    "http://accounts.spotify.com/authorize",
    "https://evil.example/authorize",
    "https://accounts.spotify.com.evil.example/authorize",
    "https://evil.example/?https://accounts.spotify.com/",
    "https://user:pw@accounts.spotify.com/authorize",
    "https://accounts.spotify.com:8443/authorize",
    "https://sub.accounts.spotify.com/authorize",
    "javascript:alert(1)",
    "//accounts.spotify.com/authorize",
    "/authorize",
    "",
    "not a url",
    // same host, but not the consent page
    "https://accounts.spotify.com/",
    "https://accounts.spotify.com/login",
    "https://accounts.spotify.com/authorize/../login",
    "https://accounts.spotify.com/api/token",
    "https://accounts.spotify.com/authorized",
  ])("rejects %s", (u) => expect(isSpotifyConsentUrl(u)).toBe(false));

  it("rejects non-strings", () => {
    for (const v of [undefined, null, 1, {}, ["https://accounts.spotify.com/authorize"]]) expect(isSpotifyConsentUrl(v)).toBe(false);
  });

  it("returns the canonical parsed href, not the raw string", () => {
    expect(consentHref("HTTPS://ACCOUNTS.SPOTIFY.COM:443/authorize?state=s")).toBe("https://accounts.spotify.com/authorize?state=s");
    expect(consentHref(" https://accounts.spotify.com/authorize")).toBe("https://accounts.spotify.com/authorize");
  });
});

describe("startConnect", () => {
  const URL_OK = "https://accounts.spotify.com/authorize?state=abc";

  it("POSTs with Bearer and navigates (same window, via the callback) to the consent URL", async () => {
    const f = fetchOf(json({ url: URL_OK }));
    const navigate = vi.fn();
    expect(await startConnect("v1.t", navigate, o(f))).toEqual({ status: "loading" });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(URL_OK);
    expect(f.mock.calls[0][0]).toBe("/api/spotify/connect");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(bearer(f)).toBe("Bearer v1.t");
  });

  it("navigates with the parsed href, not the raw string", async () => {
    const navigate = vi.fn();
    await startConnect("t", navigate, o(fetchOf(json({ url: "HTTPS://ACCOUNTS.SPOTIFY.COM:443/authorize?state=s" }))));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://accounts.spotify.com/authorize?state=s");
  });

  it("does not navigate to a tampered URL", async () => {
    for (const url of ["https://evil.example/x", "http://accounts.spotify.com/a", "https://accounts.spotify.com/login", "javascript:alert(1)", 42, undefined]) {
      const navigate = vi.fn();
      expect(await startConnect("t", navigate, o(fetchOf(json({ url }))))).toEqual(ERROR);
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it("403 = the owner: 'does not apply', not an error, no navigation", async () => {
    const navigate = vi.fn();
    expect(await startConnect("t", navigate, o(fetchOf(json({ error: "x" }, 403))))).toEqual({ status: "owner" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("429, 503 and network are short fixed messages; 401 is 'unauthorized'; never navigate", async () => {
    const navigate = vi.fn();
    expect(await startConnect("t", navigate, o(fetchOf(json({}, 429))))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.rateLimited });
    expect(await startConnect("t", navigate, o(fetchOf(json({}, 503))))).toEqual(ERROR);
    expect(await startConnect("t", navigate, o(fetchOf(json({}, 401))))).toEqual({ status: "unauthorized" });
    expect(await startConnect("t", navigate, o(fetchOf(new TypeError("x"))))).toEqual(ERROR);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("deadline and cancellation (N1, B3)", () => {
  afterEach(() => vi.useRealTimers());
  const hang = () => vi.fn<typeof fetch>(() => new Promise<Response>(() => {})); // ignores its signal on purpose

  it.each([
    ["connection", (f: typeof fetch, timeoutMs: number) => fetchConnection("t", { fetchImpl: f, timeoutMs })],
    ["disconnect", (f: typeof fetch, timeoutMs: number) => disconnect("t", { fetchImpl: f, timeoutMs })],
    ["connect", (f: typeof fetch, timeoutMs: number) => startConnect("t", vi.fn(), { fetchImpl: f, timeoutMs })],
  ])("a hanging %s request ends as the fixed error", async (_n, call) => {
    vi.useFakeTimers();
    const p = call(hang(), 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual(ERROR);
  });

  it("cancelling (sign out) ends the request and never navigates", async () => {
    const navigate = vi.fn();
    const abort = new AbortController();
    let release!: (r: Response) => void;
    const f = vi.fn<typeof fetch>(() => new Promise<Response>((r) => (release = r)));
    const p = startConnect("t", navigate, { fetchImpl: f, signal: abort.signal });
    abort.abort();
    release(json({ url: "https://accounts.spotify.com/authorize?state=s" }));
    expect(await p).toEqual(ERROR);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("no secrets on the phone", () => {
  it("never writes to localStorage or logs anything", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem, removeItem: vi.fn() });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      await fetchConnection("t", o(fetchOf(json({ connected: true }))));
      await startConnect("t", vi.fn(), o(fetchOf(json({ url: "https://accounts.spotify.com/authorize?state=s" }))));
      await disconnect("t", o(fetchOf(json({ connected: false }))));
      expect(setItem).not.toHaveBeenCalled();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      spies.forEach((s) => s.mockRestore());
    }
  });
});
