import { UserFacingError } from "@/lib/agent-runtime";
import { getOwnerDriverId, isOwner as isOwnerDriver } from "@/lib/auth";
import { MissingEnvError, requireEnv } from "@/lib/env";
import { getDriverStore } from "@/lib/driver";
import { fetchSpotifyProfile, SPOTIFY_HTTP_TIMEOUT_MS } from "./profile";
import { loadSpotifyRefreshToken, saveRotatedSpotifyRefreshToken, TokenVaultDisabledError } from "./token-vault";

export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  // Lists devices so playback can start on the phone when none is active.
  "user-read-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
];

/** Refresh this long before Spotify's stated expiry to absorb clock skew and latency. */
const EXPIRY_MARGIN_MS = 60_000;

export const NOT_CONFIGURED_SPEECH = "O Spotify ainda não está configurado.";
export const AUTH_FAILED_SPEECH = "Perdi o acesso ao seu Spotify.";
export const CONNECT_SPOTIFY_SPEECH = "Conecte seu Spotify.";
export const UNREACHABLE_SPEECH = "Não consegui falar com o Spotify agora.";
export const ACCOUNT_UNAVAILABLE_SPEECH = "Não consegui acessar sua conta do Spotify agora.";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  /** Which source minted it. An entry is only served while the driver is still of that kind (owner or not). */
  owner: boolean;
}

// Access tokens live in memory per driverId (never keyed by a refresh token), one in-flight refresh per driver.
const accessTokens = new Map<string, CachedToken>();
const pendingRefresh = new Map<string, Promise<string>>();
// Spotify may rotate the OWNER's server refresh token; keep the newest for this instance's lifetime.
let ownerRotatedRefreshToken: string | undefined;
// Bumped by evict: a refresh that started before it must not repopulate the cache (disconnect, reconnect).
const epochs = new Map<string, number>();
let ownerSpotifyUserId: string | undefined;
const MAX_CACHED_DRIVERS = 200;

/** Clears every in-memory access token (tests). */
export function resetSpotifyTokenCache(): void {
  accessTokens.clear();
  pendingRefresh.clear();
  epochs.clear();
  ownerRotatedRefreshToken = undefined;
  ownerSpotifyUserId = undefined;
}

/** Forgets the cached access token of one driver (disconnect, reconnect). Other instances keep theirs until it expires (<= 1 h). */
export function evictSpotifyAccessToken(driverId: string): void {
  accessTokens.delete(driverId);
  pendingRefresh.delete(driverId);
  epochs.set(driverId, (epochs.get(driverId) ?? 0) + 1);
}

function spotifyEnv(name: string): string {
  try {
    return requireEnv(name);
  } catch (err) {
    if (err instanceof MissingEnvError) {
      console.error(`[spotify] ${err.message}`);
      throw new UserFacingError(NOT_CONFIGURED_SPEECH);
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
    // No detail on purpose: nothing from the SDK, the network or the response is logged or kept.
    console.error("[spotify] token request failed");
    throw new UserFacingError(UNREACHABLE_SPEECH);
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    console.error(`[spotify] token endpoint returned ${res.status}`);
    // 400 invalid_grant / 401 invalid_client: credentials or refresh token are bad.
    const speech = res.status === 400 || res.status === 401 ? AUTH_FAILED_SPEECH : UNREACHABLE_SPEECH;
    throw new UserFacingError(speech);
  }

  let json: TokenResponse;
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    throw new UserFacingError(UNREACHABLE_SPEECH);
  }
  if (!json.access_token) {
    throw new UserFacingError(AUTH_FAILED_SPEECH);
  }
  return json;
}

/**
 * Who is asking: only the server-proven driverId. The refresh token is never an input; it is
 * read from the server (the owner's SPOTIFY_REFRESH_TOKEN, or the driver's encrypted blob).
 */
export interface SpotifyIdentity {
  driverId: string;
}

function accessFrom(json: TokenResponse, owner: boolean): CachedToken {
  return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 - EXPIRY_MARGIN_MS, owner };
}

/** The driver's own refresh token from the vault. Absent, undecryptable or vault off: the driver hears a fixed phrase. */
async function driverRefreshToken(driverId: string): Promise<string> {
  let token: string | null;
  try {
    token = await loadSpotifyRefreshToken(driverId);
  } catch (err) {
    // Neither the SDK error nor anything else is kept or logged.
    throw new UserFacingError(err instanceof TokenVaultDisabledError ? NOT_CONFIGURED_SPEECH : ACCOUNT_UNAVAILABLE_SPEECH);
  }
  if (!token) throw new UserFacingError(CONNECT_SPOTIFY_SPEECH);
  return token;
}

async function refreshFor(driverId: string, signal?: AbortSignal): Promise<string> {
  const epoch = epochs.get(driverId) ?? 0;
  const isOwner = isOwnerDriver(driverId);
  // Owner: the server token, ignoring anything a client could send. Others: only their own blob, no fallback.
  const refreshToken = isOwner
    ? (ownerRotatedRefreshToken ?? spotifyEnv("SPOTIFY_REFRESH_TOKEN"))
    : await driverRefreshToken(driverId);
  const json = await requestToken({ grant_type: "refresh_token", refresh_token: refreshToken }, signal);
  let stillConnected = true;
  if (isOwner) {
    if (json.refresh_token && json.refresh_token !== refreshToken) {
      ownerRotatedRefreshToken = json.refresh_token;
      console.warn("[spotify] refresh token was rotated; update SPOTIFY_REFRESH_TOKEN if it stops working");
    }
  } else {
    try {
      if (json.refresh_token && json.refresh_token !== refreshToken) {
        // Re-encrypted with a fresh IV, and only if the blob still exists (SET XX): never resurrects a disconnected driver.
        stillConnected = await saveRotatedSpotifyRefreshToken(driverId, json.refresh_token);
      } else {
        stillConnected = await getDriverStore().hasSpotifyBlob(driverId);
      }
    } catch {
      stillConnected = false; // cannot tell: hand out this access token but do not cache it
      console.warn("[spotify] could not confirm or store the refresh token");
    }
  }
  // Cache only if nothing evicted this driver meanwhile (disconnect, reconnect) and the connection still exists.
  if (!stillConnected || (epochs.get(driverId) ?? 0) !== epoch) return json.access_token;
  if (accessTokens.size >= MAX_CACHED_DRIVERS && !accessTokens.has(driverId)) {
    const now = Date.now();
    for (const [k, v] of accessTokens) if (v.expiresAt <= now) accessTokens.delete(k);
    if (accessTokens.size >= MAX_CACHED_DRIVERS) {
      const first = accessTokens.keys().next().value;
      if (first !== undefined) accessTokens.delete(first);
    }
  }
  accessTokens.set(driverId, accessFrom(json, isOwner));
  return json.access_token;
}

/**
 * Returns a valid access token, refreshing when the cached one is missing, near expiry, or
 * `forceRefresh` is set (after a 401). Concurrent callers of the SAME driver share one refresh.
 *
 * Isolation: `driverId` is required and comes from the server (never from the client); the cache
 * and the in-flight map are keyed by it.
 * - Owner (getOwnerDriverId): SPOTIFY_REFRESH_TOKEN of the server.
 * - Anyone else: only their own encrypted token. Not connected means "Conecte seu Spotify"; a
 *   failing token fails. SPOTIFY_REFRESH_TOKEN is never used.
 */
export async function getAccessToken(opts: { driverId: string; forceRefresh?: boolean; signal?: AbortSignal }): Promise<string> {
  const { driverId } = opts;
  if (opts.forceRefresh) accessTokens.delete(driverId);
  const cached = accessTokens.get(driverId);
  if (cached && cached.owner !== isOwnerDriver(driverId)) {
    // The owner changed inside this process (env change): a token minted from the server account must not
    // outlive the ownership, and a guest's token is not the owner's.
    accessTokens.delete(driverId);
    pendingRefresh.delete(driverId);
  } else if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  let pending = pendingRefresh.get(driverId);
  if (!pending) {
    const p: Promise<string> = refreshFor(driverId, opts.signal).finally(() => {
      // Only the entry of THIS refresh: an evict may have let a newer one take the slot.
      if (pendingRefresh.get(driverId) === p) pendingRefresh.delete(driverId);
    });
    pending = p;
    pendingRefresh.set(driverId, p);
  }
  return pending;
}

/** Authorization-code grant, used once by the OAuth callback to obtain the refresh token. */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  try {
    return await requestToken(
      { grant_type: "authorization_code", code, redirect_uri: redirectUri },
      AbortSignal.timeout(SPOTIFY_HTTP_TIMEOUT_MS),
    );
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError(UNREACHABLE_SPEECH); // timeout or abort: generic, no detail kept
  }
}

/**
 * Spotify account id (lowercase) of the owner, from SPOTIFY_REFRESH_TOKEN, cached in memory once known.
 * Null when the server has no owner token (the owner check is then skipped). Throws when the token exists but the
 * lookup fails: callers fail closed.
 */
export async function getOwnerSpotifyUserId(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (!env.SPOTIFY_REFRESH_TOKEN?.trim()) return null;
  // The server token has an owner or nobody reaches it: with a token present and no owner, fail closed
  // (callers refuse) instead of reading it for a lookup.
  const ownerDriverId = getOwnerDriverId(env);
  if (!ownerDriverId) throw new Error("no owner configured");
  if (ownerSpotifyUserId) return ownerSpotifyUserId;
  // Both the owner's refresh and /v1/me are bounded (5 s each); an abort is just a failure to the caller (no log, no detail).
  const accessToken = await getAccessToken({ driverId: ownerDriverId, signal: AbortSignal.timeout(SPOTIFY_HTTP_TIMEOUT_MS) });
  const profile = await fetchSpotifyProfile(accessToken);
  if (!profile) throw new Error("owner profile unavailable");
  ownerSpotifyUserId = profile.id;
  return profile.id;
}
