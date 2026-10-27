/**
 * Test-only fake of the Spotify accounts + Web API, installed as a `fetch`
 * replacement that routes by URL. Never imported by app code.
 */
import type { Playlist } from "./playlists";

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

export interface FakeSpotifyOptions {
  playlists?: Playlist[];
  pageSize?: number;
  /** Runs first; return a Response to override the default behavior for that call. */
  override?: (call: RecordedCall, index: number) => Response | undefined;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });

export function spotifyError(status: number, message: string, reason?: string): Response {
  return json({ error: { status, message, ...(reason ? { reason } : {}) } }, status);
}

export function createFakeSpotify(opts: FakeSpotifyOptions = {}) {
  const { playlists = [], pageSize = 50, override } = opts;
  const calls: RecordedCall[] = [];
  let tokens = 0;

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers);
    const call: RecordedCall = {
      method: (init.method ?? "GET").toUpperCase(),
      url,
      authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : null,
    };
    calls.push(call);

    const overridden = override?.(call, calls.length - 1);
    if (overridden) return overridden;

    const { origin, pathname, searchParams } = new URL(url);
    if (origin === "https://accounts.spotify.com" && pathname === "/api/token") {
      return json({ access_token: `access-${++tokens}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (origin === "https://api.spotify.com" && pathname === "/v1/me/playlists") {
      const offset = Number(searchParams.get("offset") ?? 0);
      const items = playlists.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      return json({
        items,
        next:
          nextOffset < playlists.length
            ? `https://api.spotify.com/v1/me/playlists?offset=${nextOffset}&limit=50`
            : null,
      });
    }
    if (origin === "https://api.spotify.com" && pathname.startsWith("/v1/me/player/")) {
      return new Response(null, { status: 204 });
    }
    return json({ error: { status: 404, message: `unrouted ${url}` } }, 404);
  };

  const find = (method: string, pathPrefix: string) =>
    calls.filter((c) => c.method === method && c.url.startsWith(pathPrefix));

  return { fetch, calls, find };
}

export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const API = "https://api.spotify.com/v1";

export function stubSpotifyEnv(stubEnv: (name: string, value: string) => unknown): void {
  stubEnv("SPOTIFY_CLIENT_ID", "client-id");
  stubEnv("SPOTIFY_CLIENT_SECRET", "client-secret");
  stubEnv("SPOTIFY_REFRESH_TOKEN", "refresh-token");
}

/** 64 hex, 16 distinct chars: accepted as FINN_TOKEN_ENC_KEY. */
export const TEST_ENC_KEY = "0123456789abcdef".repeat(4);
/** Another valid secret, different from TEST_ENC_KEY. */
export const OTHER_TEST_KEY = "fedcba9876543210".repeat(4);

/**
 * Test-only: arms the token vault with TEST_ENC_KEY and an in-memory store (prefix finn:development:),
 * installed as the process-wide store. Call `restore()` (setDriverStoreForTests(undefined)) in afterEach.
 */
export async function useTestTokenVault(stubEnv: (name: string, value: string) => unknown) {
  const { MemoryDriverStore, setDriverStoreForTests } = await import("../driver");
  stubEnv("FINN_TOKEN_ENC_KEY", TEST_ENC_KEY);
  const store = new MemoryDriverStore("finn:development:");
  setDriverStoreForTests(store);
  const { saveSpotifyRefreshToken } = await import("./token-vault");
  return {
    store,
    connect: (driverId: string, refreshToken: string) => saveSpotifyRefreshToken(driverId, refreshToken, { store }),
    restore: () => setDriverStoreForTests(undefined),
  };
}
