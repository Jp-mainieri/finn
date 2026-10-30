/**
 * Client for the Spotify connection custody routes (the refresh token lives on the server;
 * the phone only learns "connected or not"). Pure: fetch, navigation, deadline and
 * cancellation come in as parameters.
 */
import { withTimeout } from "./request-timeout";

export const SPOTIFY_CONNECT_PATH = "/api/spotify/connect";
export const SPOTIFY_CONNECTION_PATH = "/api/spotify/connection";

export const SPOTIFY_MESSAGES = {
  error: "Não consegui falar com o Spotify agora. Tente de novo.",
  notApplicable: "Esta conta usa o Spotify do servidor.",
  rateLimited: "Muitas tentativas, tente de novo em instantes.",
} as const;

export type SpotifyState =
  | { status: "unknown" }
  | { status: "loading" }
  | { status: "connected" }
  | { status: "disconnected" }
  /** Owner: the server token is used, nothing to connect or disconnect. */
  | { status: "owner" }
  /** The server refused the session (401): the controller sends the driver back to the invite screen. */
  | { status: "unauthorized" }
  | { status: "error"; message: string };

export interface SpotifyRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const ERROR: SpotifyState = { status: "error", message: SPOTIFY_MESSAGES.error };
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
  return status === 401 ? { status: "unauthorized" } : ERROR;
}

/** Runs one request; timeout, cancel and network failure all end as the fixed error state. */
async function run(
  options: SpotifyRequestOptions,
  call: (fetchImpl: typeof fetch, signal: AbortSignal) => Promise<SpotifyState>,
): Promise<SpotifyState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await withTimeout((signal) => call(fetchImpl, signal), { timeoutMs: options.timeoutMs, signal: options.signal });
  } catch {
    return ERROR;
  }
}

/** GET /api/spotify/connection */
export async function fetchConnection(token: string | null, options: SpotifyRequestOptions = {}): Promise<SpotifyState> {
  if (!token) return { status: "unknown" };
  return run(options, async (fetchImpl, signal) => {
    const res = await fetchImpl(SPOTIFY_CONNECTION_PATH, { headers: auth(token), cache: "no-store", signal });
    if (!res.ok) return errorFor(res.status);
    const connected = await readConnected(res);
    if (connected === null) return ERROR;
    return { status: connected ? "connected" : "disconnected" };
  });
}

/** DELETE /api/spotify/connection. Still connected afterwards = the owner (server token stays). */
export async function disconnect(token: string | null, options: SpotifyRequestOptions = {}): Promise<SpotifyState> {
  if (!token) return { status: "unknown" };
  return run(options, async (fetchImpl, signal) => {
    const res = await fetchImpl(SPOTIFY_CONNECTION_PATH, { method: "DELETE", headers: auth(token), cache: "no-store", signal });
    if (!res.ok) return errorFor(res.status);
    const connected = await readConnected(res);
    if (connected === null) return ERROR;
    return { status: connected ? "owner" : "disconnected" };
  });
}

/**
 * The canonical href when `value` is https on accounts.spotify.com/authorize (no credentials,
 * default port), else null. Navigation uses the parsed href, never the raw string.
 */
export function consentHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    const ok =
      u.protocol === "https:" &&
      u.hostname === "accounts.spotify.com" &&
      !u.username &&
      !u.password &&
      u.port === "" &&
      u.pathname === "/authorize";
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

export const isSpotifyConsentUrl = (value: unknown): value is string => consentHref(value) !== null;

/**
 * POST /api/spotify/connect, then same-window navigation to the consent URL.
 * 403 = the owner, "does not apply" (state `owner`, not an error). Returns the state to show.
 */
export async function startConnect(
  token: string | null,
  navigate: (url: string) => void,
  options: SpotifyRequestOptions = {},
): Promise<SpotifyState> {
  if (!token) return { status: "unknown" };
  return run(options, async (fetchImpl, signal) => {
    const res = await fetchImpl(SPOTIFY_CONNECT_PATH, { method: "POST", headers: auth(token), cache: "no-store", signal });
    if (res.status === 403) return { status: "owner" };
    if (res.status === 429) return { status: "error", message: SPOTIFY_MESSAGES.rateLimited };
    if (!res.ok) return errorFor(res.status);
    const href = consentHref(((await res.json().catch(() => null)) as { url?: unknown } | null)?.url);
    if (!href) return ERROR;
    if (signal.aborted) return ERROR; // cancelled while the body was being read: do not navigate
    navigate(href);
    return { status: "loading" };
  });
}
