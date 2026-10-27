/**
 * The waze-agent's saved places ("casa", "trabalho"), ONE book per driver.
 *
 * Contract: docs/contratos/isolamento-por-motorista.md (passo 2).
 * - `getAddressBook(driverId)` is the only way agents get a book; the id comes from the server.
 * - Storage: Redis hash `finn:<env>:driver-addr:<driverId>` = { casa, trabalho }. Same prefix rule,
 *   same fail-closed rule and same generic `DriverStoreUnavailableError` as the driver store:
 *   outside development/test, missing Redis variables throw; they never fall back to memory.
 * - The owner (LEGACY_OWNER_DRIVER_ID) reads Redis first and, when empty, the read-only seed from
 *   WAZE_SAVED_ADDRESSES. The seed is never written back.
 * - Addresses are personal data kept as plain text under the driver's own key (accepted risk).
 * Never log an address or an SDK error from here.
 */
import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { hashToRecord, resolveDriverBackend } from "@/lib/driver";
import { DriverStoreUnavailableError, assertPrefix, isValidDriverId, keys } from "@/lib/driver/store";
import { isSavedLabel, type SavedLabel } from "./labels";

export interface AddressBook {
  get(label: SavedLabel): Promise<string | undefined>;
  set(label: SavedLabel, address: string): Promise<void>;
}

export const MAX_ADDRESS_LENGTH = 200;

/** The value is not storable (empty, too long, control characters). The agent asks again. */
export class InvalidAddressError extends Error {
  constructor() {
    super("Invalid address");
    this.name = "InvalidAddressError";
  }
}

// Control chars (C0, DEL, C1), which also covers NUL, newline and the ESC of ANSI sequences.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Trims; 1..200 characters, no control characters. Throws InvalidAddressError (never echoes the value). */
export function normalizeAddress(raw: unknown): string {
  if (typeof raw !== "string") throw new InvalidAddressError();
  const t = raw.trim();
  if (t.length < 1 || t.length > MAX_ADDRESS_LENGTH || CONTROL_RE.test(t)) throw new InvalidAddressError();
  return t;
}

function readable(value: unknown): string | undefined {
  try {
    return normalizeAddress(value);
  } catch {
    return undefined; // corrupt or foreign value in the hash: treated as "not saved"
  }
}

/** In-memory book (tests and local dev without Redis). `backing` may be shared between books: keys isolate drivers. */
export class MemoryAddressBook implements AddressBook {
  private readonly key: string;

  constructor(
    driverId: string,
    prefix: string = "finn:test:",
    private readonly backing: Map<string, Partial<Record<SavedLabel, string>>> = new Map(),
  ) {
    assertPrefix(prefix);
    this.key = keys.driverAddr(prefix, driverId);
  }

  async get(label: SavedLabel): Promise<string | undefined> {
    if (!isSavedLabel(label)) return undefined;
    return readable(this.backing.get(this.key)?.[label]);
  }

  async set(label: SavedLabel, address: string): Promise<void> {
    if (!isSavedLabel(label)) throw new InvalidAddressError();
    const value = normalizeAddress(address);
    this.backing.set(this.key, { ...this.backing.get(this.key), [label]: value });
  }
}

/** Minimal surface of the @upstash/redis client used here (tests inject the real SDK over a fake fetch). */
export interface AddressRedis {
  hgetall(key: string): Promise<unknown>;
  hset(key: string, value: Record<string, string>): Promise<unknown>;
}

export class UpstashAddressBook implements AddressBook {
  private readonly key: string;

  constructor(
    private readonly redis: AddressRedis,
    prefix: string,
    driverId: string,
  ) {
    assertPrefix(prefix);
    this.key = keys.driverAddr(prefix, driverId);
  }

  /** Any Redis failure becomes a generic, secret-free error. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new DriverStoreUnavailableError();
    }
  }

  async get(label: SavedLabel): Promise<string | undefined> {
    if (!isSavedLabel(label)) return undefined;
    const record = await this.call(async () => hashToRecord(await this.redis.hgetall(this.key)));
    return readable(record?.[label]);
  }

  async set(label: SavedLabel, address: string): Promise<void> {
    if (!isSavedLabel(label)) throw new InvalidAddressError();
    const value = normalizeAddress(address); // outside call(): invalid input is not "Redis unavailable"
    await this.call(() => this.redis.hset(this.key, { [label]: value }));
  }
}

/** Owner only: reads the inner book and, when it has nothing, the read-only env seed. Writes go to the inner book. */
export class SeededAddressBook implements AddressBook {
  constructor(
    private readonly inner: AddressBook,
    private readonly seed: Partial<Record<SavedLabel, string>>,
  ) {}

  async get(label: SavedLabel): Promise<string | undefined> {
    return (await this.inner.get(label)) ?? this.seed[label];
  }

  async set(label: SavedLabel, address: string): Promise<void> {
    await this.inner.set(label, address);
  }
}

/** Parses `WAZE_SAVED_ADDRESSES`; invalid JSON or entries are logged (without values) and ignored. */
export function parseSavedAddresses(raw: string): Partial<Record<SavedLabel, string>> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parse error is deliberately not logged: its message can quote part of the address.
    console.warn("[waze] WAZE_SAVED_ADDRESSES is not valid JSON; ignoring it");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn("[waze] WAZE_SAVED_ADDRESSES must be a JSON object; ignoring it");
    return {};
  }

  const seed: Partial<Record<SavedLabel, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const address = readable(value);
    if (isSavedLabel(key) && address) seed[key] = address;
    else console.warn(`[waze] ignoring WAZE_SAVED_ADDRESSES entry "${key}"`);
  }
  return seed;
}

// Local dev without Redis only (relaxed environments). One map for the process; keys isolate drivers.
const devMemory = new Map<string, Partial<Record<SavedLabel, string>>>();

type Env = Record<string, string | undefined>;

/**
 * Address book of ONE driver. Throws (fail closed) for an id that is neither a valid driverId nor the
 * owner, and when production has no Redis variables. Callers treat any throw as "store unavailable".
 */
export function getAddressBook(driverId: string, env: Env = process.env): AddressBook {
  const isOwner = driverId === LEGACY_OWNER_DRIVER_ID;
  if (!isOwner && !isValidDriverId(driverId)) throw new Error("Invalid driverId");
  const { prefix, redis } = resolveDriverBackend(env);
  const base: AddressBook = redis
    ? new UpstashAddressBook(redis, prefix, driverId)
    : new MemoryAddressBook(driverId, prefix, devMemory);
  return isOwner ? new SeededAddressBook(base, parseSavedAddresses(env.WAZE_SAVED_ADDRESSES ?? "")) : base;
}

/** Clears the dev in-memory books. For tests. */
export function resetAddressBook(): void {
  devMemory.clear();
}
