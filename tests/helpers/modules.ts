/**
 * The ONLY place the suite touches modules that don't exist on feat/qa yet.
 * They arrive with feat/spotify-agent and feat/waze-agent; adapt here at merge.
 *
 * Specifiers live in variables so `tsc` doesn't try to resolve them (typecheck
 * stays green before the merge); Vitest resolves the "@/" alias at runtime and
 * returns the same module instance the agents use.
 *
 * ASSUMPTIONS (confirm at merge time):
 *  1. `@/lib/spotify/auth` exports `resetSpotifyTokenCache(): void`
 *     (fixed by docs/ARCHITECTURE.md; confirmed by the spotify branch).
 *  2. `@/lib/waze/address-book` exports `resetAddressBook()` (confirmed by the
 *     waze branch; not in the docs). Fallbacks, in order: the other names in
 *     ADDRESS_BOOK_RESET_NAMES, any exported function named /^_*(reset|clear)/i,
 *     an exported object with a reset()/clear() method.
 *  3. The reset either re-reads `WAZE_SAVED_ADDRESSES` or leaves the book
 *     empty; seeded-address tests set the env before the first import instead
 *     of relying on the reset (see waze-seeded.test.ts).
 */

const SPOTIFY_AUTH_MODULE: string = "@/lib/spotify/auth";
const WAZE_ADDRESS_BOOK_MODULE: string = "@/lib/waze/address-book";

const ADDRESS_BOOK_RESET_NAMES = [
  "resetAddressBook",
  "resetAddressBookForTests",
  "__resetAddressBook",
  "resetSavedAddresses",
  "clearAddressBook",
];

export class NotMergedYetError extends Error {
  constructor(what: string, cause?: unknown) {
    super(
      `[pre-merge] ${what}. Expected on feat/qa (Phase 0 stubs); after the merge, fix tests/helpers/modules.ts if the name changed.`,
      { cause },
    );
    this.name = "NotMergedYetError";
  }
}

async function load(specifier: string): Promise<Record<string, unknown>> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new NotMergedYetError(`cannot import ${specifier}`, err);
  }
}

/** Clears the Spotify access-token cache. Throws NotMergedYetError before the merge. */
export async function resetSpotifyTokenCache(): Promise<void> {
  const mod = await load(SPOTIFY_AUTH_MODULE);
  const reset = mod.resetSpotifyTokenCache;
  if (typeof reset !== "function") {
    throw new NotMergedYetError(`${SPOTIFY_AUTH_MODULE} does not export resetSpotifyTokenCache()`);
  }
  await reset();
}

/** Wipes the waze-agent address book. Returns the export used (for diagnostics). */
export async function resetAddressBook(): Promise<string> {
  const mod = await load(WAZE_ADDRESS_BOOK_MODULE);

  const byName = ADDRESS_BOOK_RESET_NAMES.find((n) => typeof mod[n] === "function");
  const byPattern = Object.keys(mod).find(
    (n) => /^_*(reset|clear)/i.test(n) && typeof mod[n] === "function",
  );
  const fnName = byName ?? byPattern;
  if (fnName) {
    await (mod[fnName] as () => unknown)();
    return fnName;
  }

  for (const [name, value] of Object.entries(mod)) {
    const obj = value as { reset?: unknown; clear?: unknown } | null;
    if (obj && typeof obj === "object") {
      const method = typeof obj.reset === "function" ? "reset" : typeof obj.clear === "function" ? "clear" : null;
      if (method) {
        await (obj[method] as () => unknown).call(obj);
        return `${name}.${method}`;
      }
    }
  }
  throw new NotMergedYetError(
    `${WAZE_ADDRESS_BOOK_MODULE} exports no reset/clear function (exports: ${Object.keys(mod).join(", ") || "none"})`,
  );
}
