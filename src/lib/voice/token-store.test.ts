import { describe, expect, it } from "vitest";
import { statusText, wakeWordNotice } from "./status";
import { TokenStore } from "./token-store";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const throwing = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("TokenStore", () => {
  it("persists, trims and clears the token", () => {
    const storage = memoryStorage();
    const store = new TokenStore(() => storage);
    expect(store.get()).toBeNull();
    store.set("  abc  ");
    expect(new TokenStore(() => storage).get()).toBe("abc");
    store.clear();
    expect(store.get()).toBeNull();
    expect(storage.getItem("finn.apiToken")).toBeNull();
  });

  it("keeps working in memory when storage throws or is missing", () => {
    const store = new TokenStore(() => throwing);
    store.set("abc");
    expect(store.get()).toBe("abc");
    store.clear();
    expect(store.get()).toBeNull();

    const noStorage = new TokenStore(() => undefined);
    noStorage.set("xyz");
    expect(noStorage.get()).toBe("xyz");
  });
});

describe("status", () => {
  const snap = (state: Parameters<typeof statusText>[0]["state"], activity = "listening" as const) => ({
    state,
    activity,
    pendingWork: 0,
  });

  it("tells the driver what to do", () => {
    expect(statusText(snap("listening-wake"), true).title).toBe("Diga “Finn”");
    expect(statusText(snap("listening-wake"), false).title).toBe("Toque para falar");
    expect(statusText({ ...snap("in-conversation"), activity: "thinking" }, true).title).toBe("Pensando…");
    expect(statusText({ ...snap("in-conversation"), activity: "speaking" }, true).title).toBe("Falando…");
    expect(statusText(snap("in-conversation"), true).title).toBe("Ouvindo…");
    expect(
      statusText({ ...snap("error"), error: { kind: "mic-denied", message: "Sem microfone." } }, true),
    ).toEqual({ title: "Sem microfone.", tone: "error" });
  });

  it("shows a notice only when the wake word is unavailable", () => {
    expect(wakeWordNotice(null)).toBeNull();
    expect(wakeWordNotice({ available: "loading" })).toBeNull();
    expect(wakeWordNotice({ available: true })).toBeNull();
    expect(wakeWordNotice({ available: false, reason: "missing-files" })).toMatch(/não configurada/);
  });
});
