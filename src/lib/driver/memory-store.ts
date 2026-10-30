import {
  OAUTH_STATE_TTL_SECONDS,
  assertPrefix,
  assertSpotifyBlob,
  isValidSpotifyUserId,
  generateOAuthState,
  oauthStateHash,
  isValidDriverId,
  keys,
  validateInviteInput,
  normalizeLabel,
  validateWindowSeconds,
  type Driver,
  type DriverStore,
} from "./store";
import { assertPepper, generateDriverId, generateInviteCode, getInvitePepper, hashInviteCode, normalizeInviteCode } from "./invite";

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
  private blobs = new Map<string, string>();
  private spotifyIndex = new Map<string, string>();
  private spotifyAccount = new Map<string, string>();
  private states = new Map<string, { driverId: string; expiresAt: number }>();
  private counters = new Map<string, { n: number; resetAt: number }>();

  constructor(
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

  /** Test helper: every logical key currently held, fully prefixed. */
  allKeys(): string[] {
    return [
      ...[...this.drivers.keys()].map((id) => keys.driver(this.prefix, id)),
      ...[...this.invites.keys()].map((h) => keys.invite(this.prefix, h)),
      ...[...this.blobs.keys()].map((id) => keys.spotifyToken(this.prefix, id)),
      ...[...this.spotifyIndex.keys()].map((u) => keys.spotifyIndex(this.prefix, u)),
      ...[...this.spotifyAccount.keys()].map((d) => keys.spotifyAccount(this.prefix, d)),
      ...[...this.states.keys()].map((h) => keys.oauthState(this.prefix, h)),
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

  async listDrivers(): Promise<Driver[]> {
    return (await this.listDriversDetailed()).drivers;
  }

  async listDriversDetailed(): Promise<{ drivers: Driver[]; skipped: number }> {
    const drivers = [...this.drivers.values()].map((d) => ({ ...d })).sort((a, b) => a.createdAt - b.createdAt);
    return { drivers, skipped: 0 };
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
    await this.deleteSpotifyBlob(driverId);
  }

  async getSpotifyBlob(driverId: string): Promise<string | null> {
    if (!isValidDriverId(driverId)) return null;
    return this.blobs.get(driverId) ?? null;
  }

  async setSpotifyBlob(driverId: string, blob: string): Promise<void> {
    assertSpotifyBlob(blob);
    keys.spotifyToken(this.prefix, driverId); // validates the id
    this.blobs.set(driverId, blob);
  }

  async setSpotifyBlobIfExists(driverId: string, blob: string): Promise<boolean> {
    assertSpotifyBlob(blob);
    keys.spotifyToken(this.prefix, driverId);
    if (!this.blobs.has(driverId)) return false;
    this.blobs.set(driverId, blob);
    return true;
  }

  async hasSpotifyBlob(driverId: string): Promise<boolean> {
    return isValidDriverId(driverId) && this.blobs.has(driverId);
  }

  async deleteSpotifyBlob(driverId: string): Promise<void> {
    if (!isValidDriverId(driverId)) return;
    this.blobs.delete(driverId);
    const uid = this.spotifyAccount.get(driverId);
    if (uid !== undefined && this.spotifyIndex.get(uid) === driverId) this.spotifyIndex.delete(uid);
    this.spotifyAccount.delete(driverId);
  }

  async linkSpotifyAccount(driverId: string, spotifyUserId: string): Promise<"linked" | "conflict"> {
    keys.spotifyIndex(this.prefix, spotifyUserId);
    keys.spotifyAccount(this.prefix, driverId);
    const owner = this.spotifyIndex.get(spotifyUserId);
    if (owner !== undefined && owner !== driverId) return "conflict";
    this.spotifyIndex.set(spotifyUserId, driverId);
    const old = this.spotifyAccount.get(driverId);
    this.spotifyAccount.set(driverId, spotifyUserId);
    if (old !== undefined && old !== spotifyUserId && this.spotifyIndex.get(old) === driverId) this.spotifyIndex.delete(old);
    return "linked";
  }

  async getLinkedDriver(spotifyUserId: string): Promise<string | null> {
    return isValidSpotifyUserId(spotifyUserId) ? (this.spotifyIndex.get(spotifyUserId) ?? null) : null;
  }

  async createOAuthState(driverId: string): Promise<string> {
    if (!isValidDriverId(driverId)) throw new Error("Invalid driverId");
    const state = generateOAuthState();
    this.states.set(oauthStateHash(state) as string, { driverId, expiresAt: this.now() + OAUTH_STATE_TTL_SECONDS * 1000 });
    return state;
  }

  async consumeOAuthState(state: string): Promise<string | null> {
    const hash = oauthStateHash(state);
    if (!hash) return null;
    // get + delete without an await in between: atomic and single use on the event loop.
    const rec = this.states.get(hash);
    this.states.delete(hash);
    return rec && rec.expiresAt > this.now() ? rec.driverId : null;
  }

  async purgeDriverData(driverId: string): Promise<void> {
    await this.deleteSpotifyBlob(driverId);
  }

  async rotateSessions(driverId: string): Promise<void> {
    if (!isValidDriverId(driverId)) return;
    const d = this.drivers.get(driverId);
    if (d && d.status === "active") d.tokenVersion += 1;
  }

  async createInvite(input: { label: string; maxUses: number; expiresAt: number }): Promise<{ code: string }> {
    const v = validateInviteInput(input, this.now());
    const code = generateInviteCode();
    this.invites.set(this.inviteHash(code), {
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
    const inv = this.invites.get(this.inviteHash(normalized));
    // Check-and-increment has no await in between: atomic on the event loop.
    if (!inv || inv.revoked || inv.uses >= inv.maxUses || inv.expiresAt <= this.now()) return null;
    inv.uses += 1;
    return this.createDriver({ label: inv.label });
  }

  async revokeInvite(code: string): Promise<boolean> {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return false;
    const inv = this.invites.get(this.inviteHash(normalized));
    if (!inv) return false;
    inv.revoked = true;
    return true;
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

  async peekRateLimit(key: string): Promise<number> {
    keys.rateLimit(this.prefix, key);
    const c = this.counters.get(key);
    return c && c.resetAt > this.now() ? c.n : 0;
  }
}
