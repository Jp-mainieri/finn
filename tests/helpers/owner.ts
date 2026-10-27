/**
 * The owner of the test world: a valid driverId, set as FINN_OWNER_DRIVER_ID when this module is imported.
 * Tests that exercise the legacy mapping or the "no owner" state change the env themselves (and restore it).
 * Not the legacy id on purpose: the legacy id is only an owner while FINN_LEGACY_TOKEN_ENABLED=1 and no variable exists.
 */
export const TEST_OWNER_ID = "drv_OWNERownerOWNERownerOW";
process.env.FINN_OWNER_DRIVER_ID = TEST_OWNER_ID;
