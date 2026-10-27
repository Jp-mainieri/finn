import { describe, expect, it, vi } from "vitest";
import {
  SPOTIFY_MESSAGES,
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
const bearer = (f: ReturnType<typeof fetchOf>) => new Headers(f.mock.calls[0][1]?.headers).get("authorization");

describe("fetchConnection", () => {
  it("connected / not connected, with the Bearer token", async () => {
    const yes = fetchOf(json({ connected: true }));
    expect(await fetchConnection("v1.t", yes)).toEqual({ status: "connected" });
    expect(bearer(yes)).toBe("Bearer v1.t");
    expect(yes.mock.calls[0][0]).toBe("/api/spotify/connection");
    expect(await fetchConnection("v1.t", fetchOf(json({ connected: false })))).toEqual({ status: "disconnected" });
  });

  it("errors (503, 401, network, bad body) become short fixed messages", async () => {
    expect(await fetchConnection("t", fetchOf(json({}, 503)))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.error });
    expect(await fetchConnection("t", fetchOf(json({}, 401)))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.unauthorized });
    expect(await fetchConnection("t", fetchOf(new TypeError("x")))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.error });
    expect(await fetchConnection("t", fetchOf(json({ connected: "yes" })))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.error });
  });

  it("without a token it does not call the server", async () => {
    const f = fetchOf();
    expect(await fetchConnection(null, f)).toEqual({ status: "unknown" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("disconnect", () => {
  it("DELETE; a driver ends up disconnected", async () => {
    const f = fetchOf(json({ connected: false }));
    expect(await disconnect("t", f)).toEqual({ status: "disconnected" });
    expect(f.mock.calls[0][1]?.method).toBe("DELETE");
  });
  it("the owner stays connected through the server token", async () => {
    expect(await disconnect("t", fetchOf(json({ connected: true })))).toEqual({ status: "owner" });
  });
  it("errors are fixed messages", async () => {
    expect(await disconnect("t", fetchOf(json({}, 503)))).toMatchObject({ status: "error", message: SPOTIFY_MESSAGES.error });
  });
});

describe("isSpotifyConsentUrl", () => {
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
  ])("rejects %s", (u) => expect(isSpotifyConsentUrl(u)).toBe(false));

  it("rejects non-strings", () => {
    for (const v of [undefined, null, 1, {}, ["https://accounts.spotify.com/authorize"]]) expect(isSpotifyConsentUrl(v)).toBe(false);
  });
});

describe("startConnect", () => {
  const URL_OK = "https://accounts.spotify.com/authorize?state=abc";

  it("POSTs with Bearer and navigates (same window, via the callback) to the consent URL", async () => {
    const f = fetchOf(json({ url: URL_OK }));
    const navigate = vi.fn();
    expect(await startConnect("v1.t", navigate, f)).toEqual({ status: "loading" });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(URL_OK);
    expect(f.mock.calls[0][0]).toBe("/api/spotify/connect");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(bearer(f)).toBe("Bearer v1.t");
  });

  it("does not navigate to a tampered URL", async () => {
    for (const url of ["https://evil.example/x", "http://accounts.spotify.com/a", "javascript:alert(1)", 42, undefined]) {
      const navigate = vi.fn();
      const r = await startConnect("t", navigate, fetchOf(json({ url })));
      expect(r).toEqual({ status: "error", message: SPOTIFY_MESSAGES.error });
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it("403 = the owner: 'does not apply', not an error, no navigation", async () => {
    const navigate = vi.fn();
    expect(await startConnect("t", navigate, fetchOf(json({ error: "x" }, 403)))).toEqual({ status: "owner" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("429, 503, 401 and network are short fixed messages, no navigation", async () => {
    const navigate = vi.fn();
    expect(await startConnect("t", navigate, fetchOf(json({}, 429)))).toMatchObject({ status: "error" });
    expect(await startConnect("t", navigate, fetchOf(json({}, 503)))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.error });
    expect(await startConnect("t", navigate, fetchOf(json({}, 401)))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.unauthorized });
    expect(await startConnect("t", navigate, fetchOf(new TypeError("x")))).toEqual({ status: "error", message: SPOTIFY_MESSAGES.error });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("no secrets on the phone", () => {
  it("never writes to localStorage or logs anything", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem, removeItem: vi.fn() });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      await fetchConnection("t", fetchOf(json({ connected: true })));
      await startConnect("t", vi.fn(), fetchOf(json({ url: "https://accounts.spotify.com/authorize?state=s" })));
      await disconnect("t", fetchOf(json({ connected: false })));
      expect(setItem).not.toHaveBeenCalled();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      spies.forEach((s) => s.mockRestore());
    }
  });
});
