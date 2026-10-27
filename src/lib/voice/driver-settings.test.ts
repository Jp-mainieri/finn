import { beforeEach, describe, expect, it } from "vitest";
import { clearDriverSettings, getDriverSettings, saveDriverSettings } from "./driver-settings";
import { DRIVER_SETTINGS_STORAGE_KEY } from "./config";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("driver-settings", () => {
  let storage: ReturnType<typeof memoryStorage>;
  const getStorage = () => storage;

  beforeEach(() => {
    storage = memoryStorage();
    clearDriverSettings(getStorage);
  });

  it("returns default settings when storage is empty", () => {
    expect(getDriverSettings(getStorage)).toEqual({ ttsMode: "native", voiceProvider: "stt-tts" });
  });

  it("persists the voice preferences", () => {
    saveDriverSettings({ ttsMode: "openai" }, getStorage);
    expect(getDriverSettings(getStorage).ttsMode).toBe("openai");
    expect(JSON.parse(storage.getItem(DRIVER_SETTINGS_STORAGE_KEY) || "{}")).toEqual({
      ttsMode: "openai",
      voiceProvider: "stt-tts",
    });
  });

  it("never reads or writes a Spotify refresh token or addresses, even if an old blob has them", () => {
    storage.setItem(
      DRIVER_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ttsMode: "openai", spotifyRefreshToken: "sp-secret", casa: "Rua A, 1", trabalho: "Av B, 2" }),
    );
    const settings = getDriverSettings(getStorage);
    expect(settings).toEqual({ ttsMode: "openai", voiceProvider: "stt-tts" });

    // Saving rewrites the blob from the typed settings only.
    saveDriverSettings({ ttsMode: "native" }, getStorage);
    const raw = storage.getItem(DRIVER_SETTINGS_STORAGE_KEY)!;
    expect(raw).not.toContain("sp-secret");
    expect(raw).not.toContain("Rua A");
    expect(raw).not.toContain("spotifyRefreshToken");
  });

  it("does not take a Spotify token from the URL", () => {
    // The old build read ?spotify_refresh_token= and #spotify_refresh_token=; that path is gone.
    const settings = getDriverSettings(getStorage);
    expect(Object.keys(settings).sort()).toEqual(["ttsMode", "voiceProvider"]);
  });

  it("clears the stored settings", () => {
    saveDriverSettings({ ttsMode: "openai" }, getStorage);
    clearDriverSettings(getStorage);
    expect(storage.getItem(DRIVER_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(getDriverSettings(getStorage).ttsMode).toBe("native");
  });
});
