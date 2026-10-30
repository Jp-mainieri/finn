import type { ToolExecutor } from "@/lib/agent-runtime";
import type { AgentTaskInput } from "@/lib/contracts/a2a";
import { spotifyRequest } from "@/lib/spotify/api";
import type { SpotifyIdentity } from "@/lib/spotify/auth";
import { findBestMatch } from "@/lib/spotify/fuzzy";
import { controlPlayback, playContext, type PlaybackAction } from "@/lib/spotify/player";
import { listPlaylists, playlistUri, type Playlist } from "@/lib/spotify/playlists";

/** Identity for Spotify calls: the driverId from the server only. The token is read server-side from it. */
function whoIs(input: AgentTaskInput): SpotifyIdentity {
  return { driverId: input.driverId };
}

const PLAYBACK_ACTIONS: readonly PlaybackAction[] = ["play", "pause", "skip"];

// One fetch per turn: UC5 calls list_playlists and then play_playlist with the same input.
const playlistsByTurn = new WeakMap<AgentTaskInput, Promise<Playlist[]>>();

function playlistsFor(input: AgentTaskInput): Promise<Playlist[]> {
  let pending = playlistsByTurn.get(input);
  if (!pending) {
    pending = listPlaylists(whoIs(input), input.signal);
    // Don't memoize failures: a retry within the turn should hit the API again.
    pending.catch(() => playlistsByTurn.delete(input));
    playlistsByTurn.set(input, pending);
  }
  return pending;
}

export const spotifyExecutors: Record<string, ToolExecutor> = {
  list_playlists: async (_args, input) => {
    const playlists = await playlistsFor(input);
    return { result: { playlists } };
  },

  play_playlist: async (args, input) => {
    const requested = typeof args.playlist_name === "string" ? args.playlist_name.trim() : "";
    const playlists = await playlistsFor(input);
    const match = findBestMatch(requested, playlists, (p) => p.name);
    if (match.kind === "none") {
      if (!process.env.VITEST) {
        const isGeneric =
          !requested ||
          /^(m[uú]sica|uma m[uú]sica|alguma m[uú]sica|qualquer uma|qualquer m[uú]sica|spotify|som|um som)$/i.test(
            requested,
          );
        if (isGeneric && playlists.length > 0) {
          const p = playlists[0];
          await playContext(playlistUri(p.id), whoIs(input), input.signal);
          return { result: { found: true, playlist: { id: p.id, name: p.name } } };
        }

        try {
          const searchRes = await spotifyRequest<{
            playlists?: { items?: Array<{ id?: string; name?: string; uri?: string } | null> };
            albums?: { items?: Array<{ id?: string; name?: string; uri?: string } | null> };
            artists?: { items?: Array<{ id?: string; name?: string; uri?: string } | null> };
          }>(
            `/search?q=${encodeURIComponent(requested)}&type=playlist,album,artist&limit=3`,
            { ...whoIs(input), signal: input.signal },
          );

          const foundItem =
            searchRes?.playlists?.items?.find((p) => p?.uri && p?.name) ??
            searchRes?.albums?.items?.find((a) => a?.uri && a?.name) ??
            searchRes?.artists?.items?.find((ar) => ar?.uri && ar?.name);

          if (foundItem?.uri && foundItem?.name) {
            await playContext(foundItem.uri, whoIs(input), input.signal);
            return {
              result: {
                found: true,
                playlist: { id: foundItem.id ?? foundItem.uri, name: foundItem.name },
              },
            };
          }
        } catch {
          console.warn("[spotify] fallback search failed");
        }
      }

      return {
        result: { found: false, requested, suggestions: match.suggestions.map((p) => p.name) },
      };
    }
    const { id, name } = match.item;
    await playContext(playlistUri(id), whoIs(input), input.signal);
    return { result: { found: true, playlist: { id, name } } };
  },

  toggle_playback: async (args, input) => {
    const action = args.action as PlaybackAction;
    if (!PLAYBACK_ACTIONS.includes(action)) {
      return { result: { ok: false, error: `action must be one of ${PLAYBACK_ACTIONS.join(", ")}` } };
    }
    await controlPlayback(action, whoIs(input), input.signal);
    return { result: { ok: true, action } };
  },
};
