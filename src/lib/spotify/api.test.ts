import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "@/lib/agent-runtime";
import { TEST_OWNER_ID } from "../../../tests/helpers/owner";
import {
  NO_DEVICE_SPEECH,
  PREMIUM_REQUIRED_SPEECH,
  SpotifyHttpError,
  spotifyRequest,
} from "./api";
import {
  AUTH_FAILED_SPEECH,
  NOT_CONFIGURED_SPEECH,
  resetSpotifyTokenCache,
  UNREACHABLE_SPEECH,
} from "./auth";
import { controlPlayback, playContext } from "./player";
import { listPlaylists, PLAYLISTS_URL } from "./playlists";
import {
  API,
  createFakeSpotify,
  json,
  spotifyError,
  stubSpotifyEnv,
  TOKEN_URL,
  useTestTokenVault,
  type FakeSpotifyOptions,
} from "./testing";

const OWNER = { driverId: TEST_OWNER_ID };

function install(opts?: FakeSpotifyOptions) {
  const fake = createFakeSpotify(opts);
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  return fake;
}

async function speechOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UserFacingError);
  return (err as UserFacingError).speech;
}

beforeEach(() => {
  resetSpotifyTokenCache();
  stubSpotifyEnv(vi.stubEnv);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("access token", () => {
  it("uses the refresh-token grant with Basic client credentials and caches the result", async () => {
    const fake = install();
    await spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER });
    await spotifyRequest("/me/player/next", { method: "POST", ...OWNER });

    const tokenCalls = fake.find("POST", TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(tokenCalls[0].body ?? ""))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-token",
    });
    expect(fake.find("PUT", `${API}/me/player/pause`)[0].authorization).toBe("Bearer access-1");
    expect(fake.find("POST", `${API}/me/player/next`)[0].authorization).toBe("Bearer access-1");
  });

  it("refreshes again once the cached token is near expiry", async () => {
    const fake = install({
      override: (call) =>
        call.url === TOKEN_URL
          ? json({ access_token: "short", token_type: "Bearer", expires_in: 30 })
          : undefined,
    });
    await spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER });
    await spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER });
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
  });

  it("turns a missing env var into a spoken error without calling Spotify", async () => {
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", "");
    const fake = install();
    expect(await speechOf(spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER }))).toBe(
      NOT_CONFIGURED_SPEECH,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("reports a revoked refresh token (invalid_grant) as lost access", async () => {
    install({
      override: (call) =>
        call.url === TOKEN_URL
          ? json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400)
          : undefined,
    });
    expect(await speechOf(spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER }))).toBe(
      AUTH_FAILED_SPEECH,
    );
  });
});

describe("spotifyRequest errors", () => {
  it("on 401 refreshes the token and retries once (UC6)", async () => {
    const fake = install({
      override: (call) =>
        call.url.startsWith(API) && call.authorization === "Bearer access-1"
          ? spotifyError(401, "The access token expired")
          : undefined,
    });
    await spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER });

    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
    expect(fake.find("PUT", `${API}/me/player/pause`).map((c) => c.authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
  });

  it("gives up with a spoken error after a second 401", async () => {
    const fake = install({
      override: (call) => (call.url.startsWith(API) ? spotifyError(401, "Invalid token") : undefined),
    });
    expect(await speechOf(spotifyRequest("/me/player/pause", { method: "PUT", ...OWNER }))).toBe(
      AUTH_FAILED_SPEECH,
    );
    expect(fake.find("PUT", `${API}/me/player/pause`)).toHaveLength(2);
  });

  it("asks to open Spotify on a device on 404 / NO_ACTIVE_DEVICE", async () => {
    install({
      override: (call) =>
        call.url.startsWith(API)
          ? spotifyError(404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE")
          : undefined,
    });
    expect(await speechOf(controlPlayback("play", OWNER))).toBe(NO_DEVICE_SPEECH);
  });

  it("treats NO_ACTIVE_DEVICE with another status the same way", async () => {
    install({
      override: (call) =>
        call.url.startsWith(API) ? spotifyError(403, "No device", "NO_ACTIVE_DEVICE") : undefined,
    });
    expect(await speechOf(controlPlayback("skip", OWNER))).toBe(NO_DEVICE_SPEECH);
  });

  it("explains that playback control needs Premium", async () => {
    install({
      override: (call) =>
        call.url.startsWith(API) ? spotifyError(403, "Premium required", "PREMIUM_REQUIRED") : undefined,
    });
    expect(await speechOf(controlPlayback("pause", OWNER))).toBe(PREMIUM_REQUIRED_SPEECH);
  });

  it("keeps technical details out of speech but in the cause", async () => {
    install({
      override: (call) => (call.url.startsWith(API) ? spotifyError(500, "Server exploded") : undefined),
    });
    const err = await controlPlayback("pause", OWNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).speech).toBe(UNREACHABLE_SPEECH);
    expect((err as UserFacingError).cause).toBeInstanceOf(SpotifyHttpError);
    expect(String((err as UserFacingError).cause)).toContain("Server exploded");
    expect(console.error).toHaveBeenCalled();
  });

  it("turns network failures into a spoken error", async () => {
    install({
      override: (call) => {
        if (call.url.startsWith(API)) throw new TypeError("fetch failed");
        return undefined;
      },
    });
    expect(await speechOf(controlPlayback("pause", OWNER))).toBe(UNREACHABLE_SPEECH);
  });

  it("passes the abort signal through and rethrows aborts as-is", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const err = await controlPlayback("pause", OWNER, controller.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
  });
});

describe("Spotify operations", () => {
  it("lists every playlist following `next`", async () => {
    const playlists = Array.from({ length: 120 }, (_, i) => ({ id: `id${i}`, name: `Playlist ${i}` }));
    const fake = install({ playlists });
    expect(await listPlaylists(OWNER)).toEqual(playlists);
    const pages = fake.find("GET", `${API}/me/playlists`);
    expect(pages).toHaveLength(3);
    expect(pages[0].url).toBe(PLAYLISTS_URL);
  });

  it("skips null items in a playlist page", async () => {
    install({
      override: (call) =>
        call.url === PLAYLISTS_URL
          ? json({ items: [null, { id: "a", name: "A", extra: 1 }], next: null })
          : undefined,
    });
    expect(await listPlaylists(OWNER)).toEqual([{ id: "a", name: "A" }]);
  });

  it("plays a playlist context", async () => {
    const fake = install();
    await playContext("spotify:playlist:abc", OWNER);
    const [call] = fake.find("PUT", `${API}/me/player/play`);
    expect(JSON.parse(call.body ?? "")).toEqual({ context_uri: "spotify:playlist:abc" });
  });

  it.each([
    ["play", "PUT", `${API}/me/player/play`],
    ["pause", "PUT", `${API}/me/player/pause`],
    ["skip", "POST", `${API}/me/player/next`],
  ] as const)("maps %s to %s %s without a body", async (action, method, url) => {
    const fake = install();
    await controlPlayback(action, OWNER);
    const calls = fake.calls.filter((c) => c.url.startsWith(API));
    expect(calls).toEqual([expect.objectContaining({ method, url, body: null })]);
  });

  describe("a connected driver uses their own stored refresh token", () => {
    const B = { driverId: "drv_" + "B".repeat(22) };

    it("requests the access token with the stored token and caches it per driverId", async () => {
      const vault = await useTestTokenVault(vi.stubEnv);
      try {
        await vault.connect(B.driverId, "custom-driver-token");
        const fake = install();
        const { getAccessToken } = await import("./auth");

        const token1 = await getAccessToken(B);
        expect(token1).toBeTypeOf("string");
        const tokenCalls = fake.find("POST", TOKEN_URL);
        expect(tokenCalls).toHaveLength(1);
        expect(tokenCalls[0].body).toContain("refresh_token=custom-driver-token");

        expect(await getAccessToken(B)).toBe(token1);
        expect(fake.find("POST", TOKEN_URL)).toHaveLength(1);

        resetSpotifyTokenCache();
        expect(await getAccessToken(B)).toBeTypeOf("string");
        expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
      } finally {
        vault.restore();
      }
    });

    it("spotifyRequest uses the stored token", async () => {
      const vault = await useTestTokenVault(vi.stubEnv);
      try {
        await vault.connect(B.driverId, "user-456-token");
        const fake = install();
        await spotifyRequest("/me/player/pause", { method: "PUT", ...B });
        const tokenCalls = fake.find("POST", TOKEN_URL);
        expect(tokenCalls).toHaveLength(1);
        expect(tokenCalls[0].body).toContain("refresh_token=user-456-token");
      } finally {
        vault.restore();
      }
    });
  });
});
