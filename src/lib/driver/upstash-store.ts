import {
  assertPrefix,
  isValidDriverId,
  keys,
  validateInviteInput,
  validateLabel,
  type Driver,
  type DriverStore,
} from "./store";
import { generateDriverId, generateInviteCode, hashInviteCode, normalizeInviteCode } from "./invite";

/**
 * Minimal surface of @upstash/redis used here (lets tests inject a mock).
 * The real client must be built with `automaticDeserialization: false` so hash
 * values come back as raw strings (a label like "1e3" must not become a number).
 */
export interface RedisLike {
  hgetall(key: string): Promise<Record<string, string> | null>;
  hset(key: string, value: Record<string, string>): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

// Atomic redeem: check state, increment uses and create the driver in ONE script,
// so concurrent redeems can never exceed maxUses. Returns 1 on success, 0 otherwise.
export const REDEEM_SCRIPT = `
local inv = redis.call('HMGET', KEYS[1], 'maxUses', 'uses', 'expiresAt', 'revoked')
if not inv[1] then return 0 end
if inv[4] == '1' then return 0 end
if tonumber(inv[2]) >= tonumber(inv[1]) then return 0 end
if tonumber(inv[3]) <= tonumber(ARGV[1]) then return 0 end
redis.call('HINCRBY', KEYS[1], 'uses', 1)
redis.call('HSET', KEYS[2], unpack(ARGV, 2))
return 1
`;

// Revoke only if it exists (HSET alone would create a stray hash).
export const REVOKE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
return 1
`;

// INCR + EXPIRE atomically; also repairs a counter that lost its TTL.
export const RATELIMIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n
`;

function toDriver(h: Record<string, string>): Driver | null {
  const tokenVersion = Number(h.tokenVersion);
  const createdAt = Number(h.createdAt);
  if (!isValidDriverId(h.driverId) || typeof h.label !== "string") return null;
  if (h.status !== "active" && h.status !== "revoked") return null;
  if (!Number.isInteger(tokenVersion) || !Number.isFinite(createdAt)) return null;
  const d: Driver = { driverId: h.driverId, label: h.label, status: h.status, tokenVersion, createdAt };
  if (h.spotifyUserId) d.spotifyUserId = h.spotifyUserId;
  return d;
}

function driverFields(d: Driver): Record<string, string> {
  return {
    driverId: d.driverId,
    label: d.label,
    status: d.status,
    tokenVersion: String(d.tokenVersion),
    createdAt: String(d.createdAt),
  };
}

export class UpstashDriverStore implements DriverStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
  ) {
    assertPrefix(prefix);
  }

  async createDriver(input: { label: string }): Promise<Driver> {
    validateLabel(input.label);
    const driver: Driver = {
      driverId: generateDriverId(),
      label: input.label,
      status: "active",
      tokenVersion: 1,
      createdAt: this.now(),
    };
    await this.redis.hset(keys.driver(this.prefix, driver.driverId), driverFields(driver));
    return driver;
  }

  async getDriver(driverId: string): Promise<Driver | null> {
    if (!isValidDriverId(driverId)) return null;
    const h = await this.redis.hgetall(keys.driver(this.prefix, driverId));
    return h && Object.keys(h).length > 0 ? toDriver(h) : null;
  }

  async revokeDriver(driverId: string): Promise<void> {
    if (!isValidDriverId(driverId)) return;
    await this.redis.eval(REVOKE_SCRIPT, [keys.driver(this.prefix, driverId)], ["status", "revoked"]);
  }

  async createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }> {
    validateInviteInput(input);
    const code = generateInviteCode();
    await this.redis.hset(keys.invite(this.prefix, hashInviteCode(code)), {
      label: input.label,
      maxUses: String(input.maxUses),
      uses: "0",
      expiresAt: String(input.expiresAt),
      createdAt: String(this.now()),
      revoked: "0",
    });
    return { code };
  }

  async redeemInvite(code: string): Promise<Driver | null> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return null;
    const inviteKey = keys.invite(this.prefix, hashInviteCode(normalized));
    // Label is immutable after creation, so reading it before the script is safe.
    const inv = await this.redis.hgetall(inviteKey);
    if (!inv || typeof inv.label !== "string") return null;
    const driver: Driver = {
      driverId: generateDriverId(),
      label: inv.label,
      status: "active",
      tokenVersion: 1,
      createdAt: this.now(),
    };
    const fields = Object.entries(driverFields(driver)).flat();
    const ok = await this.redis.eval(
      REDEEM_SCRIPT,
      [inviteKey, keys.driver(this.prefix, driver.driverId)],
      [String(this.now()), ...fields],
    );
    return Number(ok) === 1 ? driver : null;
  }

  async revokeInvite(code: string): Promise<void> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return;
    await this.redis.eval(REVOKE_SCRIPT, [keys.invite(this.prefix, hashInviteCode(normalized))], ["revoked", "1"]);
  }

  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    const n = await this.redis.eval(RATELIMIT_SCRIPT, [keys.rateLimit(this.prefix, key)], [String(windowSeconds)]);
    return Number(n);
  }
}
