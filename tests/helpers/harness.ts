/**
 * Per-test setup shared by the acceptance suites: env, scripted model, fake
 * Spotify, and state resets. Call `useHarness()` inside a describe block.
 *
 * Every test file must also mock the Neuralake client (vi.mock is hoisted per
 * file, so it can't live here):
 *
 *   vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
 *     getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
 *   }));
 */
import { afterEach, beforeEach, vi } from "vitest";
import { TEST_TOKEN } from "./http";
import { llm } from "./llm";
import { resetAddressBook, resetSpotifyTokenCache } from "./modules";
import { installFakeSpotify, type FakeSpotify, type FakeSpotifyCredentials } from "./spotify-fake";
import { resetTimeline } from "./timeline";

export const SPOTIFY_CREDS: FakeSpotifyCredentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  refreshToken: "test-refresh-token",
};

export function stubBaseEnv(extra: Record<string, string | undefined> = {}): void {
  vi.stubEnv("FINN_API_TOKEN", TEST_TOKEN);
  vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1"); // /api/orchestrator uses authorizeDriver; the shared token is legacy
  vi.stubEnv("FINN_USE_MOCKS", "1");
  vi.stubEnv("SPOTIFY_CLIENT_ID", SPOTIFY_CREDS.clientId);
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", SPOTIFY_CREDS.clientSecret);
  vi.stubEnv("SPOTIFY_REDIRECT_URI", "https://finn.test/api/spotify/callback");
  vi.stubEnv("SPOTIFY_REFRESH_TOKEN", SPOTIFY_CREDS.refreshToken);
  vi.stubEnv("WAZE_SAVED_ADDRESSES", undefined);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

export interface HarnessOptions {
  /** Test needs the real spotify-agent: reset its token cache (fails pre-merge with a clear message). */
  spotify?: boolean;
  /** Test needs a clean waze address book (fails pre-merge with a clear message). */
  addressBook?: boolean;
  env?: Record<string, string | undefined>;
}

export interface Harness {
  spotify: FakeSpotify;
}

export function useHarness(opts: HarnessOptions = {}): Harness {
  const h = {} as Harness;
  beforeEach(async () => {
    stubBaseEnv(opts.env);
    llm.reset();
    resetTimeline();
    h.spotify = installFakeSpotify(SPOTIFY_CREDS);
    if (opts.spotify) await resetSpotifyTokenCache();
    if (opts.addressBook) await resetAddressBook();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  return h;
}
