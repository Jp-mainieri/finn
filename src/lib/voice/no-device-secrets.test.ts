import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for the PWA invariants (contract pwa-convite-e-dono.md, invariant 4):
 * the phone keeps only the session token. The client code must not mention the removed
 * fields (legacy-cleanup.ts is the one place that names them, to delete them) and no
 * console.* call may mention a secret-bearing name.
 */
const ROOTS = [join(process.cwd(), "src/lib/voice"), join(process.cwd(), "src/components")];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

const files = ROOTS.flatMap(sources);

describe("PWA client source", () => {
  it("scans real files", () => expect(files.length).toBeGreaterThan(10));

  it("does not handle a Spotify refresh token, saved addresses or driverContext", () => {
    const banned = /spotifyRefreshToken|savedAddresses|driverContext|DriverContext|save_address|spotify_refresh_token|saveDictatedAddress/;
    const hits = files.filter((f) => !f.endsWith("legacy-cleanup.ts") && banned.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("no console.* call mentions a token, invite code, driverId or secret", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (/console\.(log|info|warn|error|debug)\(/.test(line) && /token|invite|driverId|secret|Bearer/i.test(line)) {
          offenders.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
