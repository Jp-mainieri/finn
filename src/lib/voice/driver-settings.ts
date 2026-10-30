import { DRIVER_SETTINGS_STORAGE_KEY } from "./config";

/**
 * Preferences kept on the phone. The Spotify refresh token and saved addresses are NOT
 * here any more: the server keeps them per driver (see legacy-cleanup.ts for the old keys).
 */
export interface DriverSettings {
  ttsMode: "native" | "openai";
  voiceProvider: "stt-tts" | "gpt-live";
}

const DEFAULT_SETTINGS: DriverSettings = {
  ttsMode: "native",
  voiceProvider: "stt-tts",
};

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): KeyValueStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

let memorySettings: DriverSettings = { ...DEFAULT_SETTINGS };

export function getDriverSettings(getStorage = defaultStorage): DriverSettings {
  try {
    const raw = getStorage()?.getItem(DRIVER_SETTINGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : memorySettings;
    const settings: DriverSettings = {
      ttsMode: parsed?.ttsMode === "openai" ? "openai" : "native",
      voiceProvider: "stt-tts",
    };
    memorySettings = { ...settings };
    return settings;
  } catch {
    return { ...memorySettings };
  }
}

export function saveDriverSettings(patch: Partial<DriverSettings>, getStorage = defaultStorage): DriverSettings {
  const current = getDriverSettings(getStorage);
  const updated: DriverSettings = {
    ...current,
    ...patch,
    voiceProvider: "stt-tts",
  };
  memorySettings = { ...updated };
  try {
    getStorage()?.setItem(DRIVER_SETTINGS_STORAGE_KEY, JSON.stringify(updated));
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("finn:driverSettingsChanged", { detail: updated }));
    }
  } catch {
    // memory-only for this visit (storage blocked); nothing sensitive to report
  }
  return updated;
}

export function clearDriverSettings(getStorage = defaultStorage): void {
  memorySettings = { ...DEFAULT_SETTINGS };
  try {
    getStorage()?.removeItem(DRIVER_SETTINGS_STORAGE_KEY);
  } catch {
    // ignore
  }
}
