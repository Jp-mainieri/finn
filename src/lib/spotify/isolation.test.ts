import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "@/lib/agent-runtime";
import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { spotifyRequest } from "./api";
import { CONNECT_SPOTIFY_SPEECH, getAccessToken, resetSpotifyTokenCache } from "./auth";
import { listPlaylists } from "./playlists";
import { createFakeSpotify, json, stubSpotifyEnv, TOKEN_URL } from "./testing";

const OWNER = { driverId: LEGACY_OWNER_DRIVER_ID };
const B = { driverId: "drv_" + "B".repeat(22) };
const SERVER_RT = "refresh-token"; // value set by stubSpotifyEnv

function install(override?: Parameters<typeof createFakeSpotify>[0]) {
  const fake = createFakeSpotify(override);
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  return fake;
}

const tokenBodies = (fake: ReturnType<typeof createFakeSpotify>) => fake.find("POST", TOKEN_URL).map((c) => c.body ?? "");

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

describe("Spotify token isolation (non-owner never reaches the server token)", () => {
  it("non-owner without own token: 'Conecte seu Spotify', no network call at all", async () => {
    const fake = install();
    const err = await getAccessToken({ ...B }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).speech).toBe(CONNECT_SPOTIFY_SPEECH);
    expect(fake.calls).toHaveLength(0);
    // also whitespace-only token counts as none
    await expect(getAccessToken({ ...B, refreshToken: "   " })).rejects.toBeInstanceOf(UserFacingError);
    expect(fake.calls).toHaveLength(0);
  });

  it("non-owner with a failing own token fails; SPOTIFY_REFRESH_TOKEN is never tried", async () => {
    const fake = install({ override: (c) => (c.url === TOKEN_URL ? json({ error: "invalid_grant" }, 400) : undefined) });
    await expect(spotifyRequest("/me/player/pause", { method: "PUT", ...B, refreshToken: "b-own-token" })).rejects.toBeInstanceOf(
      UserFacingError,
    );
    const bodies = tokenBodies(fake);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toContain("refresh_token=b-own-token");
      expect(body).not.toContain(SERVER_RT);
    }
  });

  it("non-owner never reads the owner's warm access-token cache", async () => {
    const fake = install();
    const ownerToken = await getAccessToken({ ...OWNER });
    expect(ownerToken).toBe("access-1");
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(1);

    await expect(getAccessToken({ ...B })).rejects.toBeInstanceOf(UserFacingError);
    // with its own token it gets its own access token, not the cached owner one
    const bToken = await getAccessToken({ ...B, refreshToken: "b-own-token" });
    expect(bToken).not.toBe(ownerToken);
    // the owner's cache is untouched and nothing of B went through the server refresh token
    expect(await getAccessToken({ ...OWNER })).toBe(ownerToken);
    expect(tokenBodies(fake).filter((b) => b.includes(SERVER_RT))).toHaveLength(1);
  });

  it("non-owner presenting the exact server token value still stays out of the owner caches", async () => {
    const fake = install();
    await getAccessToken({ ...OWNER });
    const t = await getAccessToken({ ...B, refreshToken: SERVER_RT });
    expect(t).not.toBe("access-1");
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
  });

  it("owner with a failing own token does not fall back to the server token (and the reverse)", async () => {
    const fake = install({
      override: (c) => (c.url === TOKEN_URL && (c.body ?? "").includes("owner-own") ? json({ error: "invalid_grant" }, 400) : undefined),
    });
    await expect(getAccessToken({ ...OWNER, refreshToken: "owner-own" })).rejects.toBeInstanceOf(UserFacingError);
    expect(tokenBodies(fake).every((b) => !b.includes(SERVER_RT))).toBe(true);

    const fake2 = install({ override: (c) => (c.url === TOKEN_URL ? json({ error: "invalid_grant" }, 400) : undefined) });
    await expect(getAccessToken({ ...OWNER, refreshToken: SERVER_RT })).rejects.toBeInstanceOf(UserFacingError);
    expect(fake2.find("POST", TOKEN_URL)).toHaveLength(1);
  });

  it("owner without own token uses the server token", async () => {
    const fake = install();
    await getAccessToken({ ...OWNER });
    expect(tokenBodies(fake)[0]).toContain(`refresh_token=${SERVER_RT}`);
  });

  it("listPlaylists as non-owner without token never calls Spotify", async () => {
    const fake = install({ playlists: [{ id: "p", name: "Dono" }] });
    await expect(listPlaylists(B)).rejects.toBeInstanceOf(UserFacingError);
    expect(fake.calls).toHaveLength(0);
  });
});
