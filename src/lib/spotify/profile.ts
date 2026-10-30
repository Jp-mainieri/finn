/**
 * GET /v1/me with a freshly obtained access token: who is on the other side of the consent.
 * Short timeout, generic failure (null), no log, the response body is never kept beyond id and a label.
 */
export const SPOTIFY_ME_URL = "https://api.spotify.com/v1/me";
export const SPOTIFY_HTTP_TIMEOUT_MS = 5000;

export interface SpotifyProfile {
  /** Lowercased account id (the key of `spotify-index:`). */
  id: string;
  /** What the driver sees on the success page (display name or id); NOT escaped. */
  label: string;
}

const ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export async function fetchSpotifyProfile(accessToken: string, timeoutMs = SPOTIFY_HTTP_TIMEOUT_MS): Promise<SpotifyProfile | null> {
  try {
    const res = await fetch(SPOTIFY_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json()) as { id?: unknown; display_name?: unknown };
    if (typeof body?.id !== "string" || !ID_RE.test(body.id)) return null;
    const id = body.id.toLowerCase();
    const name = typeof body.display_name === "string" ? body.display_name.replace(CONTROL_RE, "").trim().slice(0, 64) : "";
    return { id, label: name || id };
  } catch {
    return null;
  }
}
