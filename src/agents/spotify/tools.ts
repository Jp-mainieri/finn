import type { ToolExecutor } from "@/lib/agent-runtime";
import type { AgentTaskInput } from "@/lib/contracts/a2a";
import { findBestMatch } from "@/lib/spotify/fuzzy";
import { controlPlayback, playContext, type PlaybackAction } from "@/lib/spotify/player";
import { listPlaylists, playlistUri, type Playlist } from "@/lib/spotify/playlists";

const PLAYBACK_ACTIONS: readonly PlaybackAction[] = ["play", "pause", "skip"];

// One fetch per turn: UC5 calls list_playlists and then play_playlist with the same input.
const playlistsByTurn = new WeakMap<AgentTaskInput, Promise<Playlist[]>>();

function playlistsFor(input: AgentTaskInput): Promise<Playlist[]> {
  let pending = playlistsByTurn.get(input);
  if (!pending) {
    pending = listPlaylists(input.signal, input.driverContext?.spotifyRefreshToken);
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
      return {
        result: { found: false, requested, suggestions: match.suggestions.map((p) => p.name) },
      };
    }
    const { id, name } = match.item;
    await playContext(playlistUri(id), input.signal, input.driverContext?.spotifyRefreshToken);
    return { result: { found: true, playlist: { id, name } } };
  },

  toggle_playback: async (args, input) => {
    const action = args.action as PlaybackAction;
    if (!PLAYBACK_ACTIONS.includes(action)) {
      return { result: { ok: false, error: `action must be one of ${PLAYBACK_ACTIONS.join(", ")}` } };
    }
    await controlPlayback(action, input.signal, input.driverContext?.spotifyRefreshToken);
    return { result: { ok: true, action } };
  },
};
