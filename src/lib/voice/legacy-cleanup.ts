import { DRIVER_SETTINGS_STORAGE_KEY } from "./config";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Fields older builds kept on the phone and that must never be stored there again. */
const REMOVED_FIELDS = ["spotifyRefreshToken", "casa", "trabalho", "savedAddresses"] as const;

/**
 * One-shot cleanup of `finn.driverSettings`: drops the Spotify refresh token and the typed
 * addresses, keeps the remaining preferences (voice etc.). Idempotent (a clean blob is not
 * rewritten), so running it on every load is the same as running it once. An unreadable
 * blob is removed. Never logs anything (the old value may be a secret).
 */
export function purgeLegacyDriverSettings(storage: KeyValueStorage | undefined): void {
  try {
    const raw = storage?.getItem(DRIVER_SETTINGS_STORAGE_KEY);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      storage?.removeItem(DRIVER_SETTINGS_STORAGE_KEY);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      storage?.removeItem(DRIVER_SETTINGS_STORAGE_KEY);
      return;
    }
    const clean: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    let changed = false;
    for (const field of REMOVED_FIELDS) {
      if (field in clean) {
        delete clean[field];
        changed = true;
      }
    }
    if (changed) {
      try {
        storage?.setItem(DRIVER_SETTINGS_STORAGE_KEY, JSON.stringify(clean));
      } catch {
        // Could not rewrite (quota): dropping the whole blob is better than keeping a secret.
        storage?.removeItem(DRIVER_SETTINGS_STORAGE_KEY);
      }
    }
  } catch {
    // storage blocked: nothing was readable, nothing to clean
  }
}

/**
 * Old builds received `?spotify_refresh_token=` (or `#...`, `spotify_token`) in the URL after the
 * OAuth callback. Strip it from the address bar and history entry. The value is never extracted,
 * read into a variable or stored: only the presence of the parameter name is tested.
 */
export function scrubSpotifyTokenFromUrl(
  location: Pick<Location, "search" | "hash" | "pathname">,
  history: Pick<History, "replaceState">,
): boolean {
  if (!/spotify_refresh_token|spotify_token/.test(`${location.search}${location.hash}`)) return false;
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    return false;
  }
  return true;
}
