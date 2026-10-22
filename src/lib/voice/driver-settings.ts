import type { DriverContext } from "@/lib/contracts/a2a";
import { DRIVER_SETTINGS_STORAGE_KEY } from "./config";

export interface DriverSettings {
  casa?: string;
  trabalho?: string;
  spotifyRefreshToken?: string;
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

    let spotifyToken = parsed.spotifyRefreshToken;
    if (!spotifyToken && typeof window !== "undefined" && typeof window.location !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const paramToken =
        searchParams.get("spotify_refresh_token") ||
        searchParams.get("spotify_token") ||
        hashParams.get("spotify_refresh_token");
      if (paramToken) {
        spotifyToken = paramToken;
      }
    }

    const settings: DriverSettings = {
      casa: typeof parsed.casa === "string" ? parsed.casa : undefined,
      trabalho: typeof parsed.trabalho === "string" ? parsed.trabalho : undefined,
      spotifyRefreshToken: typeof spotifyToken === "string" ? spotifyToken : undefined,
      ttsMode: parsed.ttsMode === "openai" ? "openai" : "native",
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
  } catch (err) {
    console.warn("[driver-settings] failed to save to storage", err);
  }
  return updated;
}

export function saveDictatedAddress(label: "casa" | "trabalho", address: string, getStorage = defaultStorage): void {
  if (!label || !address) return;
  saveDriverSettings({ [label]: address.trim() }, getStorage);
}

export function clearDriverSettings(getStorage = defaultStorage): void {
  memorySettings = { ...DEFAULT_SETTINGS };
  try {
    getStorage()?.removeItem(DRIVER_SETTINGS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getDriverContext(getStorage = defaultStorage): DriverContext | undefined {
  const settings = getDriverSettings(getStorage);
  const savedAddresses: Partial<Record<"casa" | "trabalho", string>> = {};
  if (settings.casa?.trim()) savedAddresses.casa = settings.casa.trim();
  if (settings.trabalho?.trim()) savedAddresses.trabalho = settings.trabalho.trim();

  const hasAddresses = Object.keys(savedAddresses).length > 0;
  const hasSpotify = Boolean(settings.spotifyRefreshToken?.trim());

  if (!hasAddresses && !hasSpotify) return undefined;
  return {
    ...(hasSpotify ? { spotifyRefreshToken: settings.spotifyRefreshToken?.trim() } : {}),
    ...(hasAddresses ? { savedAddresses } : {}),
  };
}
