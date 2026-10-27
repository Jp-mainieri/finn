import { MemoryDriverStore, keyPrefix, setDriverStoreForTests, type DriverStore } from "@/lib/driver";

/**
 * The owner of the test world: a valid driverId, set as FINN_OWNER_DRIVER_ID when this module is imported.
 * Tests that exercise the legacy mapping or the "no owner" state change the env themselves (and restore it).
 * Not the legacy id on purpose: the legacy id is only an owner while FINN_LEGACY_TOKEN_ENABLED=1 and no variable exists.
 *
 * A real owner id is only honoured by the legacy token and A2A while that driver is registered and active, so the
 * owner is also registered (active) in the process-wide in-memory store installed at import, and
 * `registerTestOwner(store)` does the same for a store a test builds itself.
 */
export const TEST_OWNER_ID = "drv_OWNERownerOWNERownerOW";
process.env.FINN_OWNER_DRIVER_ID = TEST_OWNER_ID;

/** Puts TEST_OWNER_ID in `store` as an active driver (test-only: reaches into the in-memory map to fix the id). */
export function registerTestOwner<T extends DriverStore>(store: T, status: "active" | "revoked" = "active"): T {
  const drivers = (store as unknown as { drivers: Map<string, unknown> }).drivers;
  drivers.set(TEST_OWNER_ID, { driverId: TEST_OWNER_ID, label: "Dono", status, tokenVersion: 1, createdAt: 0 });
  return store;
}

setDriverStoreForTests(registerTestOwner(new MemoryDriverStore(keyPrefix("development"))));
