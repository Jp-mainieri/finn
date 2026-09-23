import { TOKEN_STORAGE_KEY } from "./config";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * FINN_API_TOKEN kept on the phone. Storage can be missing or throw (private
 * mode, blocked site data), so every access is guarded; an in-memory copy keeps
 * the current visit working either way.
 */
export class TokenStore {
  private memory: string | null = null;

  constructor(private readonly storage: () => KeyValueStorage | undefined = defaultStorage) {}

  get(): string | null {
    try {
      const stored = this.storage()?.getItem(TOKEN_STORAGE_KEY);
      if (stored) return stored;
    } catch {
      // fall through to the in-memory copy
    }
    return this.memory;
  }

  set(token: string): void {
    const value = token.trim();
    this.memory = value || null;
    try {
      if (value) this.storage()?.setItem(TOKEN_STORAGE_KEY, value);
      else this.storage()?.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // memory-only for this visit
    }
  }

  clear(): void {
    this.set("");
  }
}

function defaultStorage(): KeyValueStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
