import { spotifyRequest } from "./api";

export interface Playlist {
  id: string;
  name: string;
}

export const PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists?limit=50";

/** Hard stop on pagination (50 per page) so a huge library can't blow the latency budget. */
const MAX_PAGES = 10;

interface PlaylistPage {
  items: ({ id: string; name: string } | null)[];
  next: string | null;
}

/** All of the user's playlists (owned + followed), following `next` links. */
export async function listPlaylists(
  signal?: AbortSignal,
  refreshToken?: string,
): Promise<Playlist[]> {
  const playlists: Playlist[] = [];
  let url: string | null = PLAYLISTS_URL;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data: PlaylistPage | null = await spotifyRequest<PlaylistPage>(url, {
      signal,
      refreshToken,
    });
    for (const item of data?.items ?? []) {
      if (item?.id && item.name) playlists.push({ id: item.id, name: item.name });
    }
    url = data?.next ?? null;
  }
  return playlists;
}

export function playlistUri(id: string): string {
  return `spotify:playlist:${id}`;
}
