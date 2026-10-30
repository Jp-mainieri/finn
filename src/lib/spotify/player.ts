import { UserFacingError } from "@/lib/agent-runtime";
import { SpotifyHttpError, spotifyRequest } from "./api";
import type { SpotifyIdentity } from "./auth";

export type PlaybackAction = "play" | "pause" | "skip";

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
}

/** Preference when no device is active: in the car the phone is the one that matters. */
const DEVICE_TYPE_RANK = ["smartphone", "computer"];

function isNoDeviceError(err: unknown): boolean {
  return (
    err instanceof UserFacingError &&
    err.cause instanceof SpotifyHttpError &&
    (err.cause.status === 404 || err.cause.reason === "NO_ACTIVE_DEVICE")
  );
}

/** Picks the device to wake up, or undefined when none can take commands. */
export function pickDevice(devices: SpotifyDevice[]): SpotifyDevice | undefined {
  const usable = devices.filter((d) => d.id && !d.is_restricted);
  const rank = (d: SpotifyDevice) => {
    if (d.is_active) return -1;
    const i = DEVICE_TYPE_RANK.indexOf(d.type.toLowerCase());
    return i === -1 ? DEVICE_TYPE_RANK.length : i;
  };
  return usable.sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Runs a player command; if Spotify says there's no active device, looks up the
 * driver's available devices (needs scope user-read-playback-state) and retries
 * on the best one. Any failure in that fallback surfaces the original error.
 */
async function withDeviceFallback(
  run: (deviceId?: string) => Promise<unknown>,
  who: SpotifyIdentity,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await run();
    return;
  } catch (err) {
    if (!isNoDeviceError(err)) throw err;
    let device: SpotifyDevice | undefined;
    try {
      const res = await spotifyRequest<{ devices?: SpotifyDevice[] }>("/me/player/devices", {
        ...who,
        signal,
      });
      device = pickDevice(res?.devices ?? []);
    } catch (lookupErr) {
      if (signal?.aborted) throw lookupErr;
      console.warn("[spotify] device lookup failed; keeping the no-device error", lookupErr);
    }
    if (!device?.id) throw err;
    await run(device.id);
  }
}

function withDeviceId(path: string, deviceId?: string): string {
  return deviceId ? `${path}?device_id=${encodeURIComponent(deviceId)}` : path;
}

/** Starts a context (e.g. `spotify:playlist:<id>`), waking a device if none is active. */
export async function playContext(
  contextUri: string,
  who: SpotifyIdentity,
  signal?: AbortSignal,
): Promise<void> {
  await withDeviceFallback(
    (deviceId) =>
      spotifyRequest(withDeviceId("/me/player/play", deviceId), {
        method: "PUT",
        body: { context_uri: contextUri },
        ...who,
        signal,
      }),
    who,
    signal,
  );
}

export async function controlPlayback(
  action: PlaybackAction,
  who: SpotifyIdentity,
  signal?: AbortSignal,
): Promise<void> {
  switch (action) {
    case "play":
      await withDeviceFallback(
        (deviceId) =>
          spotifyRequest(withDeviceId("/me/player/play", deviceId), {
            method: "PUT",
            ...who,
            signal,
          }),
        who,
        signal,
      );
      return;
    // Nothing is playing without an active device, so pause/skip keep the plain error.
    case "pause":
      await spotifyRequest("/me/player/pause", { method: "PUT", ...who, signal });
      return;
    case "skip":
      await spotifyRequest("/me/player/next", { method: "POST", ...who, signal });
      return;
  }
}
