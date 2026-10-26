import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDriverStore, keyPrefix } from "@/lib/driver";
import { run, DEFAULT_DAYS } from "../../scripts/lib/admin-cli.mjs";

const PEPPER = "c2b7d95e01f84a36b9d0e7a15c4f8823e6a91b07d3f5c8e24a0b69d1f7c3e5a8";
const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const URL_SECRET = "https://very-secret-host.upstash.example";
const TOKEN_SECRET = "AXsecretRedisTokenValue";
const T0 = 1_800_000_000_000;

function harness(opts: { confirm?: boolean; tty?: boolean; secret?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const created: string[] = [];
  const clock = { t: T0 };
  const store = new MemoryDriverStore(keyPrefix("test"), () => clock.t, PEPPER);
  const confirm = vi.fn(async () => opts.confirm ?? true);
  const readSecret = vi.fn(async () => opts.secret ?? "");
  const env = {
    FINN_INVITE_PEPPER: PEPPER,
    FINN_SESSION_SECRET: SECRET,
    KV_REST_API_URL: URL_SECRET,
    KV_REST_API_TOKEN: TOKEN_SECRET,
  };
  const go = (argv: string[]) =>
    run(argv, {
      env,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      createStore: (e: string) => (created.push(e), store),
      confirm,
      readSecret,
      isTTY: opts.tty ?? true,
      now: () => clock.t,
    }) as Promise<number>;
  const all = () => [...out, ...err].join("\n");
  return { go, out, err, created, store, confirm, readSecret, all, clock };
}

describe("owner CLI", () => {
  it("refuses without --env (and with an invalid one), never touching the store", async () => {
    const h = harness();
    expect(await h.go(["driver:list"])).toBe(2);
    expect(await h.go(["driver:list", "--env", "staging"])).toBe(2);
    expect(await h.go(["invite:create", "--label", "X"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/--env é obrigatório/);
    expect(h.created).toEqual([]);
  });

  it("refuses production without --confirm-production, accepts with it", async () => {
    const h = harness();
    expect(await h.go(["driver:list", "--env", "production"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/--confirm-production/);
    expect(h.created).toEqual([]);
    expect(await h.go(["driver:list", "--env", "production", "--confirm-production"])).toBe(0);
    expect(h.created).toEqual(["production"]);
    // preview/development do not need the extra flag
    expect(await h.go(["driver:list", "--env", "preview"])).toBe(0);
  });

  it("invite:create prints the code exactly once and nothing else; the invite is redeemable and expiresAt is in ms", async () => {
    const h = harness();
    expect(await h.go(["invite:create", "--env", "preview", "--label", "Carro do Zé", "--max-uses", "2", "--days", "3"])).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toMatch(/^FINN-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const code = h.out[0];
    // redeems twice (maxUses 2), not three times
    expect(await h.store.redeemInvite(code)).not.toBeNull();
    expect(await h.store.redeemInvite(code)).not.toBeNull();
    expect(await h.store.redeemInvite(code)).toBeNull();
    // 3 days minus 1 ms is still valid; at 3 days it is expired (milliseconds, not seconds)
    const h2 = harness();
    await h2.go(["invite:create", "--env", "preview", "--label", "L", "--days", "3"]);
    h2.clock.t = T0 + 3 * 86_400_000 - 1;
    expect(await h2.store.redeemInvite(h2.out[0])).not.toBeNull();
    const h3 = harness();
    await h3.go(["invite:create", "--env", "preview", "--label", "L"]);
    h3.clock.t = T0 + DEFAULT_DAYS * 86_400_000;
    expect(await h3.store.redeemInvite(h3.out[0])).toBeNull();
  });

  it("invite:create validates input and reports without echoing secrets", async () => {
    const h = harness();
    expect(await h.go(["invite:create", "--env", "preview"])).toBe(2);
    expect(await h.go(["invite:create", "--env", "preview", "--label", "A", "--days", "0"])).toBe(2);
    expect(await h.go(["invite:create", "--env", "preview", "--label", "A", "--max-uses", "abc"])).toBe(2);
    expect(await h.go(["invite:create", "--env", "preview", "--label", "A", "--days", "999"])).toBe(1);
    expect(h.out).toEqual([]);
  });

  it("never prints pepper, session secret, Redis URL or token, even on failures", async () => {
    const h = harness();
    await h.go(["invite:create", "--env", "preview", "--label", "A"]);
    await h.go(["driver:list", "--env", "preview"]);
    await h.go(["driver:revoke", "--env", "preview", "drv_" + "A".repeat(22)]);
    await h.go(["driver:list"]);
    await h.go(["bogus"]);
    const boom = (msg: string) => async () => {
      throw new Error(msg);
    };
    const leaky = { listDrivers: boom(`connect ${URL_SECRET} ${TOKEN_SECRET} ${PEPPER}`) };
    const out: string[] = [];
    const err: string[] = [];
    expect(await run(["driver:list", "--env", "preview"], { env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s), createStore: () => leaky })).toBe(1);
    const dump = [h.all(), ...out, ...err].join("\n");
    for (const s of [PEPPER, SECRET, URL_SECRET, TOKEN_SECRET]) expect(dump).not.toContain(s);
  });

  it("driver:list shows id, label, status and created-at, no secrets", async () => {
    const h = harness();
    const a = await h.store.createDriver({ label: "Ana" });
    h.clock.t += 1000;
    const b = await h.store.createDriver({ label: "Beto" });
    await h.store.revokeDriver(b.driverId);
    expect(await h.go(["driver:list", "--env", "preview"])).toBe(0);
    expect(h.out).toEqual([
      `${a.driverId}\tAna\tactive\t${new Date(T0).toISOString()}`,
      `${b.driverId}\tBeto\trevoked\t${new Date(T0 + 1000).toISOString()}`,
    ]);
    const empty = harness();
    await empty.go(["driver:list", "--env", "preview"]);
    expect(empty.out).toEqual(["Nenhum motorista."]);
  });

  it("driver:revoke shows the label, asks to confirm, and revokes only after yes", async () => {
    const h = harness({ confirm: false });
    const d = await h.store.createDriver({ label: "Ana" });
    expect(await h.go(["driver:revoke", d.driverId, "--env", "preview"])).toBe(1);
    expect(h.out.join("\n")).toContain('"Ana"');
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect((await h.store.getDriver(d.driverId))!.status).toBe("active");

    const y = harness({ confirm: true });
    const d2 = await y.store.createDriver({ label: "Bia" });
    expect(await y.go(["driver:revoke", d2.driverId, "--env", "preview"])).toBe(0);
    expect((await y.store.getDriver(d2.driverId))!.status).toBe("revoked");
    // --yes skips the prompt
    const z = harness();
    const d3 = await z.store.createDriver({ label: "Caio" });
    expect(await z.go(["driver:revoke", d3.driverId, "--env", "preview", "--yes"])).toBe(0);
    expect(z.confirm).not.toHaveBeenCalled();
  });

  it("driver:rotate bumps tokenVersion after confirmation", async () => {
    const h = harness();
    const d = await h.store.createDriver({ label: "Ana" });
    expect(await h.go(["driver:rotate", d.driverId, "--env", "preview"])).toBe(0);
    expect((await h.store.getDriver(d.driverId))!.tokenVersion).toBe(2);
    await h.store.revokeDriver(d.driverId);
    expect(await h.go(["driver:rotate", d.driverId, "--env", "preview"])).toBe(1);
    expect((await h.store.getDriver(d.driverId))!.tokenVersion).toBe(2);
  });

  it("warns clearly (exit 1, nothing changed, no prompt) for a nonexistent or malformed id", async () => {
    const h = harness();
    const real = await h.store.createDriver({ label: "Ana" });
    const typo = real.driverId.slice(0, -1) + (real.driverId.endsWith("A") ? "B" : "A");
    for (const cmd of ["driver:revoke", "driver:rotate"]) {
      for (const id of [typo, "drv_nope", "../x"]) {
        h.err.length = 0;
        expect(await h.go([cmd, id, "--env", "preview", "--yes"])).toBe(1);
        expect(h.err.join("\n")).toMatch(/não encontrado/);
      }
    }
    expect(h.confirm).not.toHaveBeenCalled();
    expect((await h.store.getDriver(real.driverId))!.status).toBe("active");
    expect((await h.store.getDriver(real.driverId))!.tokenVersion).toBe(1);
  });

  it("default store requires Redis credentials (no silent in-memory fallback)", async () => {
    const err: string[] = [];
    const code = await run(["driver:list", "--env", "development"], { env: {}, out: () => {}, err: (s: string) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/Credenciais do Redis ausentes/);
  });

  it("invite:revoke makes the invite unredeemable (code via argv still works)", async () => {
    const h = harness();
    await h.go(["invite:create", "--env", "preview", "--label", "A"]);
    const code = h.out[0];
    expect(await h.go(["invite:revoke", code, "--env", "preview"])).toBe(0);
    expect(await h.store.redeemInvite(code)).toBeNull();
  });

  it("invite:revoke without an argument asks for the code without echo (readSecret), never echoing it", async () => {
    const h = harness();
    await h.go(["invite:create", "--env", "preview", "--label", "A"]);
    const code = h.out[0];
    const h2 = harness({ secret: code });
    // same store so the invite exists
    const out: string[] = [];
    const err: string[] = [];
    const rc = await run(["invite:revoke", "--env", "preview"], {
      env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s),
      createStore: () => h.store, readSecret: h2.readSecret, isTTY: true,
    });
    expect(rc).toBe(0);
    expect(h2.readSecret).toHaveBeenCalledTimes(1);
    expect([...out, ...err].join("\n")).not.toContain(code);
    expect(await h.store.redeemInvite(code)).toBeNull();
  });

  it("invite:revoke reports 'not found' with exit 1 for an unknown, malformed or empty code", async () => {
    const h = harness();
    expect(await h.go(["invite:revoke", "FINN-ABCD-EFGH", "--env", "preview"])).toBe(1);
    expect(h.err.join("\n")).toMatch(/Convite não encontrado \(confira o código e o --env\/pepper\)/);
    expect(await h.go(["invite:revoke", "nope", "--env", "preview"])).toBe(1);
    const e = harness({ secret: "" });
    expect(await e.go(["invite:revoke", "--env", "preview"])).toBe(2);
  });

  it("without a TTY, driver:revoke/rotate require --yes and change nothing (no prompt, no hang)", async () => {
    const h = harness({ tty: false });
    const d = await h.store.createDriver({ label: "Ana" });
    for (const cmd of ["driver:revoke", "driver:rotate"]) {
      expect(await h.go([cmd, d.driverId, "--env", "preview"])).toBe(1);
      expect(h.err.join("\n")).toMatch(/--yes/);
    }
    expect(h.confirm).not.toHaveBeenCalled();
    expect((await h.store.getDriver(d.driverId))!.status).toBe("active");
    expect(await h.go(["driver:rotate", d.driverId, "--env", "preview", "--yes"])).toBe(0);
    expect((await h.store.getDriver(d.driverId))!.tokenVersion).toBe(2);
  });

  it("driver:list warns how many index entries were skipped", async () => {
    const h = harness();
    const fake = {
      listDriversDetailed: async () => ({ drivers: [], skipped: 3 }),
    };
    const err: string[] = [];
    const out: string[] = [];
    expect(await run(["driver:list", "--env", "preview"], { env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s), createStore: () => fake })).toBe(0);
    expect(err.join("\n")).toMatch(/3 entrada/);
    expect(out).toEqual(["Nenhum motorista."]);
    void h;
  });

  it("a missing or invalid pepper says so, not 'Redis indisponível'", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const bad = { createInvite: async () => { throw new Error("Missing required environment variable: FINN_INVITE_PEPPER"); } };
    expect(await run(["invite:create", "--env", "preview", "--label", "A"], { env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s), createStore: () => bad })).toBe(1);
    expect(err.join("\n")).toMatch(/Pepper ausente ou inválido para este ambiente/);
    expect(err.join("\n")).not.toMatch(/Redis indisponível/);
  });

  describe("--env-file", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
      delete process.env.FINN_TEST_FROM_FILE;
    });

    it("loads variables from the given file (created by this test), without printing them", async () => {
      const dir = mkdtempSync(join(tmpdir(), "finn-envfile-"));
      dirs.push(dir);
      const file = join(dir, "env");
      writeFileSync(file, "FINN_TEST_FROM_FILE=value-from-file-123\n");
      const out: string[] = [];
      const err: string[] = [];
      let seen: string | undefined;
      const rc = await run(["driver:list", "--env", "preview", "--env-file", file], {
        out: (s: string) => out.push(s),
        err: (s: string) => err.push(s),
        createStore: () => {
          seen = process.env.FINN_TEST_FROM_FILE;
          return { listDriversDetailed: async () => ({ drivers: [], skipped: 0 }) };
        },
      });
      expect(rc).toBe(0);
      expect(seen).toBe("value-from-file-123");
      expect([...out, ...err].join("\n")).not.toContain("value-from-file-123");
    });

    it("refuses a nonexistent path before touching the store", async () => {
      const h = harness();
      expect(await h.go(["driver:list", "--env", "preview", "--env-file", join(tmpdir(), "finn-does-not-exist-xyz")])).toBe(2);
      expect(h.err.join("\n")).toMatch(/não existe/);
      expect(h.created).toEqual([]);
    });
  });
});
