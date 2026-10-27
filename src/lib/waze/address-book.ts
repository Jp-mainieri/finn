/**
 * The waze-agent's saved places ("casa", "trabalho").
 *
 * The spec puts these in the waze-agent's OWN Neuralake memory (not the
 * orchestrator's, not Cross Memory). Neuralake's per-agent memory mechanism is
 * not publicly documented yet (TODO `neuralake-memory` in
 * src/lib/neuralake/client.ts), so the agent only depends on `AddressBook` and
 * gets it from `getAddressBook()`; a Neuralake-backed (or any durable KV)
 * implementation replaces `InProcessAddressBook` there without touching the
 * agent.
 *
 * Current implementation: seeded from the optional env `WAZE_SAVED_ADDRESSES`
 * (JSON `{"casa":"…","trabalho":"…"}`) plus an in-process Map for addresses the
 * driver dictates. LIMITATION: on Vercel, in-process writes live only as long
 * as the function instance — a cold start (or another instance) forgets them
 * and falls back to the env seed. Put long-lived addresses in the env.
 */
import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";
import { isSavedLabel, type SavedLabel } from "./labels";

export interface AddressBook {
  get(label: SavedLabel): Promise<string | undefined>;
  set(label: SavedLabel, address: string): Promise<void>;
}

export class InProcessAddressBook implements AddressBook {
  private readonly addresses: Map<SavedLabel, string>;

  constructor(seed: Partial<Record<SavedLabel, string>> = {}) {
    this.addresses = new Map(Object.entries(seed) as [SavedLabel, string][]);
  }

  async get(label: SavedLabel): Promise<string | undefined> {
    return this.addresses.get(label);
  }

  async set(label: SavedLabel, address: string): Promise<void> {
    this.addresses.set(label, address);
  }
}

/** Parses `WAZE_SAVED_ADDRESSES`; invalid JSON or entries are logged and ignored. */
export function parseSavedAddresses(raw: string): Partial<Record<SavedLabel, string>> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parse error is deliberately not logged: its message can quote part of the address.
    console.warn("[waze] WAZE_SAVED_ADDRESSES is not valid JSON; ignoring it");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn("[waze] WAZE_SAVED_ADDRESSES must be a JSON object; ignoring it");
    return {};
  }

  const seed: Partial<Record<SavedLabel, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const address = typeof value === "string" ? value.trim() : "";
    if (isSavedLabel(key) && address) seed[key] = address;
    else console.warn(`[waze] ignoring WAZE_SAVED_ADDRESSES entry "${key}"`);
  }
  return seed;
}

let ownerBook: AddressBook | undefined;

/**
 * Address book of ONE driver. Only the owner (LEGACY_OWNER_DRIVER_ID) gets the book seeded from
 * WAZE_SAVED_ADDRESSES; anyone else gets an empty book of their own. No driver can reach another's.
 * (Interim for delivery 3 step 1: per-driver persistence arrives in step 2.)
 */
export function getAddressBook(driverId: string): AddressBook {
  if (driverId !== LEGACY_OWNER_DRIVER_ID) return new InProcessAddressBook();
  ownerBook ??= new InProcessAddressBook(parseSavedAddresses(optionalEnv("WAZE_SAVED_ADDRESSES", "")));
  return ownerBook;
}

/** Drops the cached owner book (and its in-process writes); the next get re-reads the env. For tests. */
export function resetAddressBook(): void {
  ownerBook = undefined;
}
