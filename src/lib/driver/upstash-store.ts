import {
  DriverStoreUnavailableError,
  assertPrefix,
  isValidDriverId,
  keys,
  normalizeLabel,
  validateInviteInput,
  validateWindowSeconds,
  type Driver,
  type DriverStore,
} from "./store";
import { assertPepper, generateDriverId, generateInviteCode, getInvitePepper, hashInviteCode, normalizeInviteCode } from "./invite";

/**
 * Minimal surface of the @upstash/redis client used here (tests may inject a mock).
 * Results are `unknown` on purpose: the real client, built with
 * `automaticDeserialization: false`, returns HGETALL as a FLAT ARRAY
 * ["field","value",...] while other clients return an object. Both are handled and
 * every reply is validated before use.
 */
export interface RedisLike {
  hgetall(key: string): Promise<unknown>;
  hset(key: string, value: Record<string, string>): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

// Atomic redeem in ONE script (also the only round-trip, on every path, so success and
// every failure cost the same): check state, increment uses and create the driver.
// KEYS: invite, driver, drivers index. ARGV: now(ms), driverId, createdAt. Returns {1, label} on success, {0} otherwise.
export const REDEEM_SCRIPT = `
local inv = redis.call('HMGET', KEYS[1], 'maxUses', 'uses', 'expiresAt', 'revoked', 'label')
if not inv[1] or not inv[5] then return {0} end
if inv[4] == '1' then return {0} end
if tonumber(inv[2]) >= tonumber(inv[1]) then return {0} end
if tonumber(inv[3]) <= tonumber(ARGV[1]) then return {0} end
local idx = redis.call('TYPE', KEYS[3])['ok']
if idx ~= 'set' and idx ~= 'none' then return redis.error_reply('WRONGTYPE drivers index') end
redis.call('HINCRBY', KEYS[1], 'uses', 1)
redis.call('HSET', KEYS[2], 'driverId', ARGV[2], 'label', inv[5], 'status', 'active', 'tokenVersion', '1', 'createdAt', ARGV[3])
redis.call('SADD', KEYS[3], ARGV[2])
return {1, inv[5]}
`;

// Revoke only if it exists (HSET alone would create a stray hash). Returns 1 if it existed, 0 if not.
export const REVOKE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) return 1 end
return 0
`;

// Atomic tokenVersion bump, only for an existing ACTIVE driver (no phantom hash).
export const ROTATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('HGET', KEYS[1], 'status') == 'active' then
  redis.call('HINCRBY', KEYS[1], 'tokenVersion', 1)
  return 1
end
return 0
`;

// INCR + EXPIRE atomically; also repairs a counter that lost its TTL.
export const RATELIMIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n
`;

/** HGETALL reply (flat array or object) -> record of strings; null when empty/missing. */
export function hashToRecord(raw: unknown): Record<string, string> | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    if (raw.length % 2 !== 0) throw new DriverStoreUnavailableError();
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i];
      const v = raw[i + 1];
      if (typeof k !== "string" || (typeof v !== "string" && typeof v !== "number")) throw new DriverStoreUnavailableError();
      out[k] = String(v);
    }
    return out;
  }
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number") throw new DriverStoreUnavailableError();
      out[k] = String(v);
    }
    return Object.keys(out).length ? out : null;
  }
  throw new DriverStoreUnavailableError();
}

function toDriver(h: Record<string, string>, expectedId: string): Driver | null {
  if (h.driverId !== expectedId || !isValidDriverId(h.driverId)) return null;
  if (typeof h.label !== "string") return null;
  if (h.status !== "active" && h.status !== "revoked") return null;
  const tokenVersion = Number(h.tokenVersion);
  const createdAt = Number(h.createdAt);
  if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 0 || !Number.isFinite(createdAt)) return null;
  const d: Driver = { driverId: h.driverId, label: h.label, status: h.status, tokenVersion, createdAt };
  if (h.spotifyUserId) d.spotifyUserId = h.spotifyUserId;
  return d;
}

export class UpstashDriverStore implements DriverStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
    pepper?: string,
  ) {
    assertPrefix(prefix);
    if (pepper !== undefined) assertPepper(pepper);
    this.pepper = pepper;
  }

  /** Injected pepper (tests) or, lazily, FINN_INVITE_PEPPER. Only invite operations need it. */
  private readonly pepper: string | undefined;
  private inviteHash(code: string): string {
    return hashInviteCode(code, this.pepper ?? getInvitePepper());
  }

  /** Every Redis access goes through here: any failure becomes a generic, secret-free error. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new DriverStoreUnavailableError();
    }
  }

  async createDriver(input: { label: string }): Promise<Driver> {
    const label = normalizeLabel(input.label);
    const driver: Driver = { driverId: generateDriverId(), label, status: "active", tokenVersion: 1, createdAt: this.now() };
    // Index first: an id without a hash is skipped by listDrivers, a hash without an id would be invisible.
    await this.call(() => this.redis.sadd(keys.driversIndex(this.prefix), driver.driverId));
    await this.call(() =>
      this.redis.hset(keys.driver(this.prefix, driver.driverId), {
        driverId: driver.driverId,
        label,
        status: driver.status,
        tokenVersion: String(driver.tokenVersion),
        createdAt: String(driver.createdAt),
      }),
    );
    return driver;
  }

  async listDrivers(): Promise<Driver[]> {
    return (await this.listDriversDetailed()).drivers;
  }

  async listDriversDetailed(): Promise<{ drivers: Driver[]; skipped: number }> {
    const raw = await this.call(() => this.redis.smembers(keys.driversIndex(this.prefix)));
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw new DriverStoreUnavailableError();
    const ids = raw as string[];
    const read = await Promise.all(
      ids.map(async (id) => {
        if (!isValidDriverId(id)) return null;
        const hash = await this.call(() => this.redis.hgetall(keys.driver(this.prefix, id))); // network failure still throws
        try {
          const h = hashToRecord(hash);
          return h ? toDriver(h, id) : null;
        } catch {
          return null; // corrupt hash (odd field count, bad types): skipped, not fatal
        }
      }),
    );
    const drivers = read.filter((d): d is Driver => d !== null).sort((a, b) => a.createdAt - b.createdAt);
    return { drivers, skipped: ids.length - drivers.length };
  }

  async getDriver(driverId: string): Promise<Driver | null> {
    if (!isValidDriverId(driverId)) return null;
    const raw = await this.call(() => this.redis.hgetall(keys.driver(this.prefix, driverId)));
    const h = hashToRecord(raw);
    return h ? toDriver(h, driverId) : null;
  }

  async revokeDriver(driverId: string): Promise<void> {
    if (!isValidDriverId(driverId)) return;
    const r = await this.call(() => this.redis.eval(REVOKE_SCRIPT, [keys.driver(this.prefix, driverId)], ["status", "revoked"]));
    if (r !== 0 && r !== 1) throw new DriverStoreUnavailableError();
  }

  async rotateSessions(driverId: string): Promise<void> {
    if (!isValidDriverId(driverId)) return;
    const r = await this.call(() => this.redis.eval(ROTATE_SCRIPT, [keys.driver(this.prefix, driverId)], []));
    if (r !== 0 && r !== 1) throw new DriverStoreUnavailableError();
  }

  async createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }> {
    const v = validateInviteInput(input, this.now());
    const code = generateInviteCode();
    // Pepper problems are validated OUTSIDE call(): they must never read as "Redis unavailable".
    const inviteKey = keys.invite(this.prefix, this.inviteHash(code));
    await this.call(() =>
      this.redis.hset(inviteKey, {
        label: v.label,
        maxUses: String(v.maxUses),
        uses: "0",
        expiresAt: String(v.expiresAt),
        createdAt: String(this.now()),
        revoked: "0",
      }),
    );
    return { code };
  }

  async redeemInvite(code: string): Promise<Driver | null> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return null;
    const driverId = generateDriverId();
    const now = this.now();
    const inviteKey = keys.invite(this.prefix, this.inviteHash(normalized));
    // Single EVAL, never retried by the client (retries are disabled in createRedisClient).
    const res = await this.call(() =>
      this.redis.eval(REDEEM_SCRIPT, [inviteKey, keys.driver(this.prefix, driverId), keys.driversIndex(this.prefix)], [String(now), driverId, String(now)]),
    );
    if (!Array.isArray(res) || res.length < 1) throw new DriverStoreUnavailableError();
    if (res[0] === 0) return null;
    if (res[0] !== 1 || typeof res[1] !== "string") throw new DriverStoreUnavailableError();
    return { driverId, label: res[1], status: "active", tokenVersion: 1, createdAt: now };
  }

  async revokeInvite(code: string): Promise<boolean> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return false;
    const inviteKey = keys.invite(this.prefix, this.inviteHash(normalized)); // outside call(), see createInvite
    const r = await this.call(() => this.redis.eval(REVOKE_SCRIPT, [inviteKey], ["revoked", "1"]));
    if (r !== 0 && r !== 1) throw new DriverStoreUnavailableError();
    return r === 1;
  }

  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    validateWindowSeconds(windowSeconds);
    const redisKey = keys.rateLimit(this.prefix, key);
    const n = await this.call(() => this.redis.eval(RATELIMIT_SCRIPT, [redisKey], [String(windowSeconds)]));
    // Missing/non-numeric reply (e.g. null from an aborted request) must never read as "0 hits".
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new DriverStoreUnavailableError();
    return n;
  }
}
