import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDriverSettings,
  getDriverContext,
  getDriverSettings,
  saveDictatedAddress,
  saveDriverSettings,
} from "./driver-settings";
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
    const settings = getDriverSettings(getStorage);
    expect(settings).toEqual({
      ttsMode: "native",
      voiceProvider: "stt-tts",
      casa: undefined,
      trabalho: undefined,
      spotifyRefreshToken: undefined,
    });
    expect(getDriverContext(getStorage)).toBeUndefined();
  });

  it("persists settings and returns updated values", () => {
    saveDriverSettings(
      {
        casa: "Av. Paulista, 1000",
        ttsMode: "openai",
      },
      getStorage,
    );

    const settings = getDriverSettings(getStorage);
    expect(settings.casa).toBe("Av. Paulista, 1000");
    expect(settings.ttsMode).toBe("openai");
    expect(settings.voiceProvider).toBe("stt-tts");

    const raw = JSON.parse(storage.getItem(DRIVER_SETTINGS_STORAGE_KEY) || "{}");
    expect(raw.casa).toBe("Av. Paulista, 1000");
    expect(raw.ttsMode).toBe("openai");
  });

  it("produces valid DriverContext with saved addresses and spotify token", () => {
    saveDriverSettings(
      {
        casa: "Rua Augusta, 500",
        trabalho: "Faria Lima, 2000",
        spotifyRefreshToken: "sp-refresh-abc",
      },
      getStorage,
    );

    const ctx = getDriverContext(getStorage);
    expect(ctx).toEqual({
      spotifyRefreshToken: "sp-refresh-abc",
      savedAddresses: {
        casa: "Rua Augusta, 500",
        trabalho: "Faria Lima, 2000",
      },
    });
  });

  it("saves dictated address correctly", () => {
    saveDictatedAddress("casa", "Rua das Flores, 123", getStorage);
    const settings = getDriverSettings(getStorage);
    expect(settings.casa).toBe("Rua das Flores, 123");

    saveDictatedAddress("trabalho", "Av. Brasil, 456", getStorage);
    const ctx = getDriverContext(getStorage);
    expect(ctx?.savedAddresses?.casa).toBe("Rua das Flores, 123");
    expect(ctx?.savedAddresses?.trabalho).toBe("Av. Brasil, 456");
  });

  it("works with in-memory fallback when storage is undefined", () => {
    clearDriverSettings(() => undefined);
    saveDriverSettings({ casa: "Rua Teste, 1" }, () => undefined);
    expect(getDriverSettings(() => undefined).casa).toBe("Rua Teste, 1");
  });
});
