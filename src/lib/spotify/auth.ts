import { UserFacingError } from "@/lib/agent-runtime";
import { MissingEnvError, requireEnv } from "@/lib/env";

export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
];

/** Refresh this long before Spotify's stated expiry to absorb clock skew and latency. */
const EXPIRY_MARGIN_MS = 60_000;

export const NOT_CONFIGURED_SPEECH = "O Spotify ainda não está configurado.";
export const AUTH_FAILED_SPEECH = "Perdi o acesso ao seu Spotify.";
export const UNREACHABLE_SPEECH = "Não consegui falar com o Spotify agora.";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;
let pendingRefresh: Promise<string> | undefined;
// Spotify may rotate the refresh token; keep the newest for this instance's lifetime.
let rotatedRefreshToken: string | undefined;

/** Clears the in-memory access token (tests, or after a 401). */
export function resetSpotifyTokenCache(): void {
  cachedToken = undefined;
  pendingRefresh = undefined;
  rotatedRefreshToken = undefined;
}

function spotifyEnv(name: string): string {
  try {
    return requireEnv(name);
  } catch (err) {
    if (err instanceof MissingEnvError) {
      console.error(`[spotify] ${err.message}`);
      throw new UserFacingError(NOT_CONFIGURED_SPEECH, { cause: err });
    }
    throw err;
  }
}

function basicAuthHeader(): string {
  const id = spotifyEnv("SPOTIFY_CLIENT_ID");
  const secret = spotifyEnv("SPOTIFY_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** POSTs a grant to the accounts service; failures become UserFacingErrors. */
async function requestToken(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const authorization = basicAuthHeader();
  let res: Response;
  try {
    res = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error("[spotify] token request failed", err);
    throw new UserFacingError(UNREACHABLE_SPEECH, { cause: err });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const cause = new Error(`Spotify token endpoint returned ${res.status}: ${body.slice(0, 300)}`);
    console.error(`[spotify] ${cause.message}`);
    // 400 invalid_grant / 401 invalid_client: credentials or refresh token are bad.
    const speech = res.status === 400 || res.status === 401 ? AUTH_FAILED_SPEECH : UNREACHABLE_SPEECH;
    throw new UserFacingError(speech, { cause });
  }

  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) {
    throw new UserFacingError(AUTH_FAILED_SPEECH, {
      cause: new Error("Spotify token response has no access_token"),
    });
  }
  return json;
}

async function refreshAccessToken(signal?: AbortSignal): Promise<string> {
  const refreshToken = rotatedRefreshToken ?? spotifyEnv("SPOTIFY_REFRESH_TOKEN");
  const json = await requestToken(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    signal,
  );
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    rotatedRefreshToken = json.refresh_token;
    console.warn("[spotify] refresh token was rotated; update SPOTIFY_REFRESH_TOKEN if it stops working");
  }
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000 - EXPIRY_MARGIN_MS,
  };
  return json.access_token;
}

/**
 * Returns a valid access token, refreshing via the stored refresh token when
 * the cached one is missing, near expiry, or `forceRefresh` is set (after a 401).
 * Concurrent callers share one in-flight refresh.
 */
export async function getAccessToken(
  opts: { forceRefresh?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  if (opts.forceRefresh) cachedToken = undefined;
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;

  if (!pendingRefresh) {
    pendingRefresh = refreshAccessToken(opts.signal).finally(() => {
      pendingRefresh = undefined;
    });
  }
  return pendingRefresh;
}

/** Authorization-code grant, used once by the OAuth callback to obtain the refresh token. */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  return requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}
