import type { ToolExecutor, ToolOutput } from "@/lib/agent-runtime";
import type { AddressBook } from "@/lib/waze/address-book";
import { wazeDeepLink } from "@/lib/waze/deep-link";
import { isSavedLabel, toSavedLabel, type SavedLabel } from "@/lib/waze/labels";

/**
 * State round-tripped through the PWA when the agent waits for the driver:
 * - `pendingLabel`: asked for the full address of a saved place
 * - `awaitingDestination`: asked where to go
 */
export type WazeContinuation = { pendingLabel: SavedLabel } | { awaitingDestination: true };

export function parseContinuation(state: unknown): WazeContinuation | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const { pendingLabel, awaitingDestination } = state as Record<string, unknown>;
  if (isSavedLabel(pendingLabel)) return { pendingLabel };
  if (awaitingDestination === true) return { awaitingDestination: true };
  return undefined;
}

/** What the model sees after a navigation was set (never the URL). */
export interface NavigateResult {
  navigating_to: string;
  saved_place?: true;
  address_saved_now?: true;
}

const LABEL_TEXT: Record<SavedLabel, string> = { casa: "casa", trabalho: "o trabalho" };

function navigate(address: string, target: string, result: NavigateResult): ToolOutput {
  return {
    result,
    clientActions: [{ type: "open_url", url: wazeDeepLink(address), label: `Navegar para ${target}` }],
  };
}

/**
 * Builds the `navigate_to` executor for one turn. A pending label from the
 * previous turn is consumed by the first call, so the answer is saved once.
 */
export function createNavigateTo(book: AddressBook, continuation?: WazeContinuation): ToolExecutor {
  let pendingLabel = continuation && "pendingLabel" in continuation ? continuation.pendingLabel : undefined;

  return async (args) => {
    const destination =
      typeof args.destination === "string" ? args.destination.replace(/\s+/g, " ").trim() : "";
    if (!destination) {
      return { result: { needs_destination: true }, continuation: { awaitingDestination: true } };
    }

    const label = toSavedLabel(destination);

    // Driver's answer to "qual o endereço da sua casa?" (unless they repeated the label itself).
    if (pendingLabel && !label) {
      const answered = pendingLabel;
      pendingLabel = undefined;
      await book.set(answered, destination);
      return navigate(destination, LABEL_TEXT[answered], {
        navigating_to: answered,
        saved_place: true,
        address_saved_now: true,
      });
    }

    if (label) {
      const saved = await book.get(label);
      if (!saved) return { result: { needs_address: label }, continuation: { pendingLabel: label } };
      return navigate(saved, LABEL_TEXT[label], { navigating_to: label, saved_place: true });
    }

    return navigate(destination, destination, { navigating_to: destination });
  };
}
