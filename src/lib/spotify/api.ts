import { UserFacingError } from "@/lib/agent-runtime";
import { AUTH_FAILED_SPEECH, getAccessToken, UNREACHABLE_SPEECH } from "./auth";

export const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export const NO_DEVICE_SPEECH = "Abre o Spotify em algum aparelho e me pede de novo.";
export const PREMIUM_REQUIRED_SPEECH = "Pra controlar o Spotify por aqui precisa de uma conta Premium.";
export const RATE_LIMITED_SPEECH = "O Spotify está ocupado agora, tenta de novo daqui a pouco.";

export class SpotifyHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string | undefined,
    body: string,
    url: string,
  ) {
    super(`Spotify ${url} returned ${status}${reason ? ` (${reason})` : ""}: ${body.slice(0, 300)}`);
    this.name = "SpotifyHttpError";
  }
}

export interface SpotifyRequest {
  method?: "GET" | "PUT" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  /** Server-proven driver (never from the client). */
  driverId: string;
}

function send(url: string, token: string, { method = "GET", body, signal }: SpotifyRequest) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
}

async function readError(res: Response, url: string): Promise<SpotifyHttpError> {
  const text = await res.text().catch(() => "");
  let reason: string | undefined;
  try {
    reason = JSON.parse(text)?.error?.reason;
  } catch {
    // Non-JSON error body.
  }
  return new SpotifyHttpError(res.status, reason, text, url);
}

function speechFor(err: SpotifyHttpError): string {
  if (err.status === 404 || err.reason === "NO_ACTIVE_DEVICE") return NO_DEVICE_SPEECH;
  if (err.reason === "PREMIUM_REQUIRED") return PREMIUM_REQUIRED_SPEECH;
  if (err.status === 401) return AUTH_FAILED_SPEECH;
  if (err.status === 429) return RATE_LIMITED_SPEECH;
  return UNREACHABLE_SPEECH;
}

/**
 * Authorized Spotify Web API call. Accepts a path under /v1 or an absolute URL
 * (pagination `next` links). On 401 refreshes the token and retries once.
 * Every failure the driver should hear becomes a UserFacingError; technical
 * details stay in `cause` and the logs. Returns parsed JSON, or null when the
 * response has no body (204 from player endpoints).
 */
export async function spotifyRequest<T = unknown>(
  pathOrUrl: string,
  req: SpotifyRequest,
): Promise<T | null> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${SPOTIFY_API_BASE}${pathOrUrl}`;
  let res: Response;
  try {
    res = await send(url, await getAccessToken({ driverId: req.driverId, signal: req.signal }), req);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      res = await send(
        url,
        await getAccessToken({ driverId: req.driverId, forceRefresh: true, signal: req.signal }),
        req,
      );
    }
  } catch (err) {
    if (err instanceof UserFacingError || req.signal?.aborted) throw err;
    console.error("[spotify] request failed"); // no SDK/network detail
    throw new UserFacingError(UNREACHABLE_SPEECH);
  }

  if (!res.ok) {
    const err = await readError(res, url);
    console.error(`[spotify] API returned ${err.status}${err.reason ? ` (${err.reason})` : ""}`);
    throw new UserFacingError(speechFor(err), { cause: err });
  }

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
