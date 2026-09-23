import type { ClientAction } from "@/lib/contracts/client-events";

/**
 * Executing `ClientAction`s on the phone.
 *
 * iOS decision for `open_url` (Waze deep link):
 * - The action arrives from a delegation event, not a user gesture, so
 *   `window.open` is killed by the popup blocker, and Universal Links only
 *   hand off to the Waze app reliably from a real tap on a link.
 * - Leaving the page suspends it (mic, WebRTC and Porcupine stop), so the
 *   confirmation must be spoken *before* anything navigates.
 * So: (1) the `speech` goes to GPT-Live first; (2) a big on-screen link with the
 *   action `label` appears immediately; it is a plain `<a href>` so a tap is a
 *   genuine user navigation that iOS can hand to the Waze app; (3) once the
 *   assistant has gone quiet, the voice session is closed gracefully and a
 *   top-level `location.assign(url)` is attempted (not a popup, so not blocked).
 *   If iOS keeps the PWA on screen, the button is still there.
 */

export interface PendingAction {
  id: string;
  type: "open_url";
  url: string;
  label: string;
}

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

/** Validates actions and gives each one a UI label; unsafe or unknown actions are dropped. */
export function toPendingActions(actions: readonly ClientAction[], makeId: () => string): PendingAction[] {
  const pending: PendingAction[] = [];
  for (const action of actions) {
    if (action?.type !== "open_url" || typeof action.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(action.url);
    } catch {
      continue;
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) continue;
    pending.push({
      id: makeId(),
      type: "open_url",
      url: url.toString(),
      label: action.label?.trim() || defaultLabel(url),
    });
  }
  return pending;
}

function defaultLabel(url: URL): string {
  return /(^|\.)waze\.com$/.test(url.hostname) ? "Abrir no Waze" : "Abrir link";
}

export interface Navigator {
  assign(url: string): void;
}

/** Best-effort automatic open; the on-screen link stays as the fallback. */
export function openPendingAction(action: PendingAction, nav: Navigator): boolean {
  try {
    nav.assign(action.url);
    return true;
  } catch (err) {
    console.warn("[voice] could not open client action automatically", err);
    return false;
  }
}
