import {
  assertPrefix,
  isValidDriverId,
  keys,
  validateInviteInput,
  normalizeLabel,
  validateWindowSeconds,
  type Driver,
  type DriverStore,
} from "./store";
import { generateDriverId, generateInviteCode, hashInviteCode, normalizeInviteCode } from "./invite";

interface InviteRecord {
  label: string;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
}

/** In-memory fake; used by all tests and by local dev without Redis. Clock is injectable. */
export class MemoryDriverStore implements DriverStore {
  private drivers = new Map<string, Driver>();
  private invites = new Map<string, InviteRecord>();
  private counters = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
  ) {
    assertPrefix(prefix);
  }

  /** Test helper: every logical key currently held, fully prefixed. */
  allKeys(): string[] {
    return [
      ...[...this.drivers.keys()].map((id) => keys.driver(this.prefix, id)),
      ...[...this.invites.keys()].map((h) => keys.invite(this.prefix, h)),
      ...[...this.counters.keys()].map((k) => keys.rateLimit(this.prefix, k)),
    ];
  }

  async createDriver(input: { label: string }): Promise<Driver> {
    const label = normalizeLabel(input.label);
    const driver: Driver = {
      driverId: generateDriverId(),
      label,
      status: "active",
      tokenVersion: 1,
      createdAt: this.now(),
    };
    this.drivers.set(driver.driverId, driver);
    return { ...driver };
  }

  async getDriver(driverId: string): Promise<Driver | null> {
    if (!isValidDriverId(driverId)) return null;
    const d = this.drivers.get(driverId);
    return d ? { ...d } : null;
  }

  async revokeDriver(driverId: string): Promise<void> {
    if (!isValidDriverId(driverId)) return;
    const d = this.drivers.get(driverId);
    if (d) d.status = "revoked";
  }

  async createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }> {
    const v = validateInviteInput(input, this.now());
    const code = generateInviteCode();
    this.invites.set(hashInviteCode(code), {
      label: v.label,
      maxUses: v.maxUses,
      uses: 0,
      expiresAt: v.expiresAt,
      createdAt: this.now(),
      revoked: false,
    });
    return { code };
  }

  async redeemInvite(code: string): Promise<Driver | null> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return null;
    const inv = this.invites.get(hashInviteCode(normalized));
    // Check-and-increment has no await in between: atomic on the event loop.
    if (!inv || inv.revoked || inv.uses >= inv.maxUses || inv.expiresAt <= this.now()) return null;
    inv.uses += 1;
    return this.createDriver({ label: inv.label });
  }

  async revokeInvite(code: string): Promise<void> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return;
    const inv = this.invites.get(hashInviteCode(normalized));
    if (inv) inv.revoked = true;
  }

  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    validateWindowSeconds(windowSeconds);
    keys.rateLimit(this.prefix, key);
    const t = this.now();
    const c = this.counters.get(key);
    if (!c || c.resetAt <= t) {
      this.counters.set(key, { n: 1, resetAt: t + windowSeconds * 1000 });
      return 1;
    }
    c.n += 1;
    return c.n;
  }
}
