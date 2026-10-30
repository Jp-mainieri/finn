import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserFacingError } from "@/lib/agent-runtime";
import { NO_DEVICE_SPEECH } from "./api";
import { resetSpotifyTokenCache } from "./auth";
import { controlPlayback, pickDevice, playContext, type SpotifyDevice } from "./player";
import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
const OWNER = { driverId: LEGACY_OWNER_DRIVER_ID };
import { createFakeSpotify, json, spotifyError, stubSpotifyEnv, type RecordedCall } from "./testing";

const device = (id: string, type: string, extra: Partial<SpotifyDevice> = {}): SpotifyDevice => ({
  id,
  name: id,
  type,
  is_active: false,
  is_restricted: false,
  ...extra,
});

const NO_DEVICE = () => spotifyError(404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");

/** Player calls without device_id fail as "no active device"; the devices endpoint returns `devices`. */
function install(devices: SpotifyDevice[] | Response) {
  const fake = createFakeSpotify({
    override: (call: RecordedCall) => {
      const url = new URL(call.url);
      if (url.pathname === "/v1/me/player/devices") return Array.isArray(devices) ? json({ devices }) : devices;
      if (url.pathname.startsWith("/v1/me/player/") && !url.searchParams.has("device_id")) return NO_DEVICE();
      return undefined;
    },
  });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  return fake;
}

async function speechOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(UserFacingError);
  return (err as UserFacingError).speech;
}

describe("pickDevice", () => {
  it("prefers the active device, then the phone, then a computer", () => {
    expect(pickDevice([device("pc", "Computer"), device("tv", "TV"), device("phone", "Smartphone")])?.id).toBe("phone");
    expect(pickDevice([device("tv", "TV"), device("pc", "Computer")])?.id).toBe("pc");
    expect(pickDevice([device("phone", "Smartphone"), device("tv", "TV", { is_active: true })])?.id).toBe("tv");
  });

  it("skips restricted devices and devices without an id", () => {
    expect(
      pickDevice([device("phone", "Smartphone", { is_restricted: true }), { ...device("x", "Computer"), id: null }]),
    ).toBeUndefined();
  });
});

describe("no active device fallback", () => {
  beforeEach(() => {
    resetSpotifyTokenCache();
    stubSpotifyEnv(vi.stubEnv);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("plays the playlist on the phone when nothing is active", async () => {
    const fake = install([device("pc-1", "Computer"), device("phone-1", "Smartphone")]);
    await playContext("spotify:playlist:abc", OWNER);
    const plays = fake.find("PUT", "https://api.spotify.com/v1/me/player/play");
    expect(plays.map((c) => c.url)).toEqual([
      "https://api.spotify.com/v1/me/player/play",
      "https://api.spotify.com/v1/me/player/play?device_id=phone-1",
    ]);
    expect(JSON.parse(plays[1].body!)).toEqual({ context_uri: "spotify:playlist:abc" });
  });

  it("resumes on an available device", async () => {
    const fake = install([device("phone-1", "Smartphone")]);
    await controlPlayback("play", OWNER);
    expect(fake.find("PUT", "https://api.spotify.com/v1/me/player/play?device_id=phone-1")).toHaveLength(1);
  });

  it("keeps the friendly error when no device is available", async () => {
    install([]);
    expect(await speechOf(playContext("spotify:playlist:abc", OWNER))).toBe(NO_DEVICE_SPEECH);
  });

  it("keeps the friendly error when the device lookup fails (e.g. missing scope)", async () => {
    install(spotifyError(403, "Insufficient client scope"));
    expect(await speechOf(playContext("spotify:playlist:abc", OWNER))).toBe(NO_DEVICE_SPEECH);
  });

  it("does not look up devices for pause or skip", async () => {
    const fake = install([device("phone-1", "Smartphone")]);
    expect(await speechOf(controlPlayback("pause", OWNER))).toBe(NO_DEVICE_SPEECH);
    expect(fake.find("GET", "https://api.spotify.com/v1/me/player/devices")).toHaveLength(0);
  });
});
