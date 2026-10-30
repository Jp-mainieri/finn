import { TOKEN_STORAGE_KEY } from "./config";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const SESSION_RE = /^v1\.[A-Za-z0-9._-]+$/;
const HEADER_SAFE_RE = /^[\x21-\x7E]+$/;

/**
 * Whether a stored value can still be a token. A session token (`v1.`) must have the exact
 * shape; a legacy token is any printable-ASCII string (it goes in an Authorization header, so
 * control or non-Latin-1 characters would make `fetch` throw). Both are capped at 1024.
 */
export function isUsableToken(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  return value.startsWith("v1.") ? SESSION_RE.test(value) : HEADER_SAFE_RE.test(value);
}

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
      if (stored) {
        if (isUsableToken(stored)) return stored;
        // Garbage in storage (tampered, truncated): discard it so the invite screen shows.
        this.memory = null;
        this.storage()?.removeItem(TOKEN_STORAGE_KEY);
        return null;
      }
    } catch {
      // fall through to the in-memory copy
    }
    return this.memory && isUsableToken(this.memory) ? this.memory : null;
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
