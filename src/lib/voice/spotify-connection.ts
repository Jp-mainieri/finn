/**
 * Client for the Spotify connection custody routes (the refresh token lives on the server;
 * the phone only learns "connected or not"). Pure: fetch and navigation come in as parameters.
 */

export const SPOTIFY_CONNECT_PATH = "/api/spotify/connect";
export const SPOTIFY_CONNECTION_PATH = "/api/spotify/connection";

export const SPOTIFY_MESSAGES = {
  error: "Não consegui falar com o Spotify agora. Tente de novo.",
  notApplicable: "Esta conta usa o Spotify do servidor.",
  unauthorized: "Sessão recusada. Entre com um convite de novo.",
} as const;

export type SpotifyState =
  | { status: "unknown" }
  | { status: "loading" }
  | { status: "connected" }
  | { status: "disconnected" }
  /** Owner: the server token is used, nothing to connect or disconnect. */
  | { status: "owner" }
  | { status: "error"; message: string };

const auth = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` });

async function readConnected(res: Response): Promise<boolean | null> {
  try {
    const body = (await res.json()) as { connected?: unknown } | null;
    return typeof body?.connected === "boolean" ? body.connected : null;
  } catch {
    return null;
  }
}

function errorFor(status: number): SpotifyState {
  return { status: "error", message: status === 401 ? SPOTIFY_MESSAGES.unauthorized : SPOTIFY_MESSAGES.error };
}

/** GET /api/spotify/connection */
export async function fetchConnection(token: string | null, fetchImpl: typeof fetch = fetch): Promise<SpotifyState> {
  if (!token) return { status: "unknown" };
  try {
    const res = await fetchImpl(SPOTIFY_CONNECTION_PATH, { headers: auth(token), cache: "no-store" });
    if (!res.ok) return errorFor(res.status);
    const connected = await readConnected(res);
    if (connected === null) return { status: "error", message: SPOTIFY_MESSAGES.error };
    return { status: connected ? "connected" : "disconnected" };
  } catch {
    return { status: "error", message: SPOTIFY_MESSAGES.error };
  }
}

/** DELETE /api/spotify/connection. Still connected afterwards = the owner (server token stays). */
export async function disconnect(token: string | null, fetchImpl: typeof fetch = fetch): Promise<SpotifyState> {
  if (!token) return { status: "unknown" };
  try {
    const res = await fetchImpl(SPOTIFY_CONNECTION_PATH, { method: "DELETE", headers: auth(token), cache: "no-store" });
    if (!res.ok) return errorFor(res.status);
    const connected = await readConnected(res);
    if (connected === null) return { status: "error", message: SPOTIFY_MESSAGES.error };
    return { status: connected ? "owner" : "disconnected" };
  } catch {
    return { status: "error", message: SPOTIFY_MESSAGES.error };
  }
}

/** Only https on accounts.spotify.com, no credentials, default port. Defence against a tampered reply. */
export function isSpotifyConsentUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "accounts.spotify.com" && !u.username && !u.password && u.port === "";
  } catch {
    return false;
  }
}

/**
 * POST /api/spotify/connect, then same-window navigation to the consent URL.
 * 403 = the owner, "does not apply" (state `owner`, not an error). Returns the state to show.
 */
export async function startConnect(
  token: string | null,
  navigate: (url: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyState> {
  if (!token) return { status: "unknown" };
  try {
    const res = await fetchImpl(SPOTIFY_CONNECT_PATH, { method: "POST", headers: auth(token), cache: "no-store" });
    if (res.status === 403) return { status: "owner" };
    if (res.status === 429) return { status: "error", message: "Muitas tentativas, tente de novo em instantes." };
    if (!res.ok) return errorFor(res.status);
    const url = ((await res.json().catch(() => null)) as { url?: unknown } | null)?.url;
    if (!isSpotifyConsentUrl(url)) return { status: "error", message: SPOTIFY_MESSAGES.error };
    navigate(url);
    return { status: "loading" };
  } catch {
    return { status: "error", message: SPOTIFY_MESSAGES.error };
  }
}
