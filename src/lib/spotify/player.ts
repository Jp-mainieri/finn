import { spotifyRequest } from "./api";

export type PlaybackAction = "play" | "pause" | "skip";

/** Starts a context (e.g. `spotify:playlist:<id>`) on the active device. */
export async function playContext(contextUri: string, signal?: AbortSignal): Promise<void> {
  await spotifyRequest("/me/player/play", {
    method: "PUT",
    body: { context_uri: contextUri },
    signal,
  });
}

export async function controlPlayback(action: PlaybackAction, signal?: AbortSignal): Promise<void> {
  switch (action) {
    case "play":
      await spotifyRequest("/me/player/play", { method: "PUT", signal });
      return;
    case "pause":
      await spotifyRequest("/me/player/pause", { method: "PUT", signal });
      return;
    case "skip":
      await spotifyRequest("/me/player/next", { method: "POST", signal });
      return;
  }
}
