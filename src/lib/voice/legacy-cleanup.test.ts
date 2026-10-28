import { describe, expect, it, vi } from "vitest";
import { DRIVER_SETTINGS_STORAGE_KEY } from "./config";
import { purgeLegacyDriverSettings, scrubSpotifyTokenFromUrl } from "./legacy-cleanup";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("purgeLegacyDriverSettings", () => {
  it("removes the Spotify refresh token and the typed addresses, keeps the other preferences", () => {
    const storage = memoryStorage({
      [DRIVER_SETTINGS_STORAGE_KEY]: JSON.stringify({
        ttsMode: "openai",
        voiceProvider: "stt-tts",
        spotifyRefreshToken: "sp-secret",
        casa: "Rua A, 1",
        trabalho: "Av B, 2",
        savedAddresses: { casa: "x" },
      }),
    });
    purgeLegacyDriverSettings(storage);
    const raw = storage.data.get(DRIVER_SETTINGS_STORAGE_KEY)!;
    expect(JSON.parse(raw)).toEqual({ ttsMode: "openai", voiceProvider: "stt-tts" });
    expect(raw).not.toContain("sp-secret");
    expect(raw).not.toContain("Rua A");
  });

  it("runs once: a clean blob is not rewritten and a second pass changes nothing", () => {
    const storage = memoryStorage({
      [DRIVER_SETTINGS_STORAGE_KEY]: JSON.stringify({ ttsMode: "native", casa: "Rua A, 1" }),
    });
    purgeLegacyDriverSettings(storage);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    purgeLegacyDriverSettings(storage);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("removes an unreadable or non-object blob and leaves an empty storage alone", () => {
    const bad = memoryStorage({ [DRIVER_SETTINGS_STORAGE_KEY]: "{not json sp-secret" });
    purgeLegacyDriverSettings(bad);
    expect(bad.data.has(DRIVER_SETTINGS_STORAGE_KEY)).toBe(false);

    const arr = memoryStorage({ [DRIVER_SETTINGS_STORAGE_KEY]: "[1]" });
    purgeLegacyDriverSettings(arr);
    expect(arr.data.has(DRIVER_SETTINGS_STORAGE_KEY)).toBe(false);

    const empty = memoryStorage();
    purgeLegacyDriverSettings(empty);
    expect(empty.setItem).not.toHaveBeenCalled();
  });

  it("survives blocked or missing storage and does not touch other keys", () => {
    expect(() => purgeLegacyDriverSettings(undefined)).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(() => purgeLegacyDriverSettings(throwing)).not.toThrow();

    const storage = memoryStorage({ "finn.apiToken": "v1.session", [DRIVER_SETTINGS_STORAGE_KEY]: "{}" });
    purgeLegacyDriverSettings(storage);
    expect(storage.data.get("finn.apiToken")).toBe("v1.session");
  });
});

describe("purgeLegacyDriverSettings when the rewrite fails", () => {
  it("falls back to removing the whole blob if setItem throws (a secret must not stay)", () => {
    const storage = memoryStorage({
      [DRIVER_SETTINGS_STORAGE_KEY]: JSON.stringify({ ttsMode: "openai", spotifyRefreshToken: "sp-secret" }),
    });
    storage.setItem.mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => purgeLegacyDriverSettings(storage)).not.toThrow();
    expect(storage.data.has(DRIVER_SETTINGS_STORAGE_KEY)).toBe(false);
  });
});

describe("scrubSpotifyTokenFromUrl", () => {
  const run = (search: string, hash = "") => {
    const history = { replaceState: vi.fn() };
    const done = scrubSpotifyTokenFromUrl({ search, hash, pathname: "/" }, history);
    return { done, history };
  };

  it.each([
    ["?spotify_refresh_token=AQD-secret"],
    ["?a=1&spotify_token=AQD-secret"],
  ])("strips %s from the address bar without ever reading the value", (search) => {
    const { done, history } = run(search);
    expect(done).toBe(true);
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/");
    expect(JSON.stringify(history.replaceState.mock.calls)).not.toContain("AQD-secret");
  });

  it("strips the hash form too", () => {
    const { done, history } = run("", "#spotify_refresh_token=AQD-secret");
    expect(done).toBe(true);
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/");
  });

  it("leaves a normal URL alone", () => {
    const { done, history } = run("?utm=1", "#top");
    expect(done).toBe(false);
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("a throwing history does not break startup", () => {
    const history = {
      replaceState: () => {
        throw new Error("denied");
      },
    };
    expect(scrubSpotifyTokenFromUrl({ search: "?spotify_token=x", hash: "", pathname: "/" }, history)).toBe(false);
  });
});
