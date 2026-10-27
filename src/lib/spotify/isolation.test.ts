import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "@/lib/agent-runtime";
import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { DriverStoreUnavailableError } from "@/lib/driver";
import { spotifyRequest } from "./api";
import {
  ACCOUNT_UNAVAILABLE_SPEECH,
  CONNECT_SPOTIFY_SPEECH,
  NOT_CONFIGURED_SPEECH,
  evictSpotifyAccessToken,
  getAccessToken,
  resetSpotifyTokenCache,
} from "./auth";
import { listPlaylists } from "./playlists";
import { decryptToken, encryptToken } from "./token-crypto";
import { loadSpotifyRefreshToken, tokenAad } from "./token-vault";
import { createFakeSpotify, json, stubSpotifyEnv, TEST_ENC_KEY, TOKEN_URL, useTestTokenVault } from "./testing";

const OWNER = { driverId: LEGACY_OWNER_DRIVER_ID };
const B = { driverId: "drv_" + "B".repeat(22) };
const C = { driverId: "drv_" + "C".repeat(22) };
const SERVER_RT = "refresh-token"; // value set by stubSpotifyEnv

function install(override?: Parameters<typeof createFakeSpotify>[0]) {
  const fake = createFakeSpotify(override);
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  return fake;
}

const tokenBodies = (fake: ReturnType<typeof createFakeSpotify>) => fake.find("POST", TOKEN_URL).map((c) => c.body ?? "");

let vault: Awaited<ReturnType<typeof useTestTokenVault>>;
beforeEach(async () => {
  resetSpotifyTokenCache();
  stubSpotifyEnv(vi.stubEnv);
  vault = await useTestTokenVault(vi.stubEnv);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vault.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Spotify token isolation (non-owner never reaches the server token)", () => {
  it("non-owner not connected: 'Conecte seu Spotify', no network call at all", async () => {
    const fake = install();
    const err = await getAccessToken({ ...B }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).speech).toBe(CONNECT_SPOTIFY_SPEECH);
    expect(fake.calls).toHaveLength(0);
  });

  it("non-owner with a failing own token fails; SPOTIFY_REFRESH_TOKEN is never tried", async () => {
    await vault.connect(B.driverId, "b-own-token");
    const fake = install({ override: (c) => (c.url === TOKEN_URL ? json({ error: "invalid_grant" }, 400) : undefined) });
    await expect(spotifyRequest("/me/player/pause", { method: "PUT", ...B })).rejects.toBeInstanceOf(UserFacingError);
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
    await vault.connect(B.driverId, "b-own-token");
    const bToken = await getAccessToken({ ...B });
    expect(bToken).not.toBe(ownerToken);
    expect(await getAccessToken({ ...OWNER })).toBe(ownerToken);
    expect(tokenBodies(fake).filter((b) => b.includes(SERVER_RT))).toHaveLength(1);
  });

  it("a stored blob whose value equals the server token still stays out of the owner's cache", async () => {
    const fake = install();
    await getAccessToken({ ...OWNER });
    await vault.connect(B.driverId, SERVER_RT);
    const t = await getAccessToken({ ...B });
    expect(t).not.toBe("access-1");
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
  });

  it("the owner ignores a blob stored under the owner id: the server token is used", async () => {
    // a residual blob under the legacy id (the vault itself refuses to write one)
    await expect(vault.connect(OWNER.driverId, "owner-blob-token")).rejects.toThrow();
    await vault.store.setSpotifyBlob(
      OWNER.driverId,
      encryptToken("owner-blob-token", Buffer.from(TEST_ENC_KEY, "hex"), tokenAad(OWNER.driverId)),
    );
    const fake = install();
    await getAccessToken({ ...OWNER });
    const bodies = tokenBodies(fake);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`refresh_token=${SERVER_RT}`);
    expect(bodies[0]).not.toContain("owner-blob-token");
  });

  it("access-token cache is per driverId: two drivers in parallel each get their own token and their own refresh", async () => {
    await vault.connect(B.driverId, "b-own-token");
    await vault.connect(C.driverId, "c-own-token");
    const fake = install({
      override: (c) => {
        if (c.url !== TOKEN_URL) return undefined;
        const rt = new URLSearchParams(c.body ?? "").get("refresh_token");
        return json({ access_token: `access-for-${rt}`, token_type: "Bearer", expires_in: 3600 });
      },
    });
    const [b1, c1, b2, c2] = await Promise.all([
      getAccessToken({ ...B }),
      getAccessToken({ ...C }),
      getAccessToken({ ...B }),
      getAccessToken({ ...C }),
    ]);
    expect([b1, b2]).toEqual(["access-for-b-own-token", "access-for-b-own-token"]);
    expect([c1, c2]).toEqual(["access-for-c-own-token", "access-for-c-own-token"]);
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2); // one in-flight refresh per driver
    // warm cache: still no new refresh, and still not crossed
    expect(await getAccessToken({ ...C })).toBe("access-for-c-own-token");
    expect(await getAccessToken({ ...B })).toBe("access-for-b-own-token");
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
  });

  it("a rotated refresh token is stored again, encrypted, with a fresh IV, and used on the next refresh", async () => {
    await vault.connect(B.driverId, "b-old");
    const before = await vault.store.getSpotifyBlob(B.driverId);
    let n = 0;
    const fake = install({
      override: (c) =>
        c.url === TOKEN_URL
          ? json({ access_token: `a${++n}`, token_type: "Bearer", expires_in: 3600, ...(n === 1 ? { refresh_token: "b-new" } : {}) })
          : undefined,
    });
    await getAccessToken({ ...B });
    const after = await vault.store.getSpotifyBlob(B.driverId);
    expect(after).not.toBe(before);
    expect(after).not.toContain("b-new");
    expect(decryptToken(after, Buffer.from(TEST_ENC_KEY, "hex"), tokenAad(B.driverId))).toBe("b-new");
    expect(await loadSpotifyRefreshToken(B.driverId)).toBe("b-new");
    await getAccessToken({ ...B, forceRefresh: true });
    expect(tokenBodies(fake)[1]).toContain("refresh_token=b-new");
  });

  it("evicting a driver drops only that driver's cached access token", async () => {
    await vault.connect(B.driverId, "b-own-token");
    await vault.connect(C.driverId, "c-own-token");
    const fake = install();
    await getAccessToken({ ...B });
    await getAccessToken({ ...C });
    evictSpotifyAccessToken(B.driverId);
    await getAccessToken({ ...C });
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(2);
    await getAccessToken({ ...B });
    expect(fake.find("POST", TOKEN_URL)).toHaveLength(3);
  });

  it("a blob that does not decrypt (tampered) reads as 'not connected', no network", async () => {
    await vault.connect(B.driverId, "b-own-token");
    const blob = (await vault.store.getSpotifyBlob(B.driverId)) as string;
    const parts = blob.split(".");
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("AA") ? "BB" : "AA");
    await vault.store.setSpotifyBlob(B.driverId, parts.join("."));
    const fake = install();
    await expect(getAccessToken({ ...B })).rejects.toMatchObject({ speech: CONNECT_SPOTIFY_SPEECH });
    expect(fake.calls).toHaveLength(0);
  });

  it("without a valid FINN_TOKEN_ENC_KEY a non-owner hears 'not configured' and nothing is read from the store", async () => {
    vi.stubEnv("FINN_TOKEN_ENC_KEY", "");
    const getSpotifyBlob = vi.spyOn(vault.store, "getSpotifyBlob");
    const fake = install();
    await expect(getAccessToken({ ...B })).rejects.toMatchObject({ speech: NOT_CONFIGURED_SPEECH });
    expect(getSpotifyBlob).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    // the owner is not affected by the vault
    await expect(getAccessToken({ ...OWNER })).resolves.toBeTypeOf("string");
  });

  it("store down: a short spoken error, no network, no log with the SDK error", async () => {
    vi.spyOn(vault.store, "getSpotifyBlob").mockRejectedValue(new DriverStoreUnavailableError());
    const fake = install();
    const err = await getAccessToken({ ...B }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).speech).toBe(ACCOUNT_UNAVAILABLE_SPEECH);
    expect((err as UserFacingError).cause).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("listPlaylists as a non-connected driver never calls Spotify", async () => {
    const fake = install({ playlists: [{ id: "p", name: "Dono" }] });
    await expect(listPlaylists(B)).rejects.toBeInstanceOf(UserFacingError);
    expect(fake.calls).toHaveLength(0);
  });
});
