import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce";
const PEPPER = "c2b7d95e01f84a36b9d0e7a15c4f8823e6a91b07d3f5c8e24a0b69d1f7c3e5a8";

afterEach(() => vi.unstubAllEnvs());

describe("tests/smoke/session.mjs", () => {
  it("passes against a local server wired to the real session route (memory store); prints no token", async () => {
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    vi.stubEnv("FINN_INVITE_PEPPER", PEPPER);
    vi.resetModules();
    const { getDriverStore } = await import("@/lib/driver");
    const session = await import("@/app/api/session/route");
    const { authorizeDriver } = await import("@/lib/auth");
    const { code } = await getDriverStore().createInvite({ label: "Smoke", maxUses: 1, expiresAt: Date.now() + 60_000 });

    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://local${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" ? undefined : Buffer.concat(chunks),
      });
      let response: Response;
      if (req.url === "/api/session") response = req.method === "POST" ? await session.POST(request) : await session.GET(request);
      else {
        const a = await authorizeDriver(request); // stands in for /api/orchestrator (no LLM here)
        response = a instanceof Response ? a : Response.json({ ok: true });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const { stdout, code: exit } = await new Promise<{ stdout: string; code: number }>((resolve) => {
        execFile(process.execPath, ["tests/smoke/session.mjs", `http://127.0.0.1:${port}`, code, "--with-orchestrator"], (err, stdout, stderr) => {
          resolve({ stdout: stdout + stderr, code: (err as { code?: number } | null)?.code ?? 0 });
        });
      });
      expect(exit).toBe(0);
      expect(stdout.match(/PASSOU/g)).toHaveLength(4);
      expect(stdout).not.toMatch(/PULADO/);
      expect(stdout).not.toMatch(/FALHOU|v1\.|drv_|FINN-/);
      expect(stdout).toMatch(/HTTP 200/);
    } finally {
      server.close();
    }
  });
});

import { checkTarget, parseSmokeArgs } from "../smoke/session-args.mjs";
import { spawnSync } from "node:child_process";

describe("smoke target validation", () => {
  it.each([
    ["https://finn-git-x-team.vercel.app", false, null],
    ["http://localhost:3000", false, null],
    ["http://127.0.0.1:3000", false, null],
    ["http://finn-git-x.vercel.app", false, "https"],
    ["https://finn.example.com", false, "produção"],
    ["https://finn.example.com", true, null],
    ["https://evilvercel.app", false, "produção"],
    ["ftp://localhost", false, "https"],
    ["not a url", false, "inválida"],
  ])("%s (allowProduction=%s)", (url, allow, want) => {
    const r = checkTarget(url, { allowProduction: allow });
    if (want === null) expect(r).toBeNull();
    else expect(r).toContain(want);
  });

  it("parses flags; orchestrator step is opt-in", () => {
    expect(parseSmokeArgs(["https://a.vercel.app", "FINN-AAAA-BBBB"])).toMatchObject({ withOrchestrator: false, allowProduction: false });
    expect(parseSmokeArgs(["https://a.vercel.app", "C", "--with-orchestrator"])).toMatchObject({ withOrchestrator: true });
    expect(parseSmokeArgs(["x"])).toHaveProperty("error");
    expect(parseSmokeArgs(["a", "b", "--nope"])).toHaveProperty("error");
  });

  it("the script refuses a production host without making any request", () => {
    const r = spawnSync(process.execPath, ["tests/smoke/session.mjs", "https://finn.example.com", "FINN-AAAA-BBBB"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/produção/);
  });

  it("without --with-orchestrator the orchestrator is skipped (default run)", async () => {
    vi.stubEnv("FINN_SESSION_SECRET", SECRET);
    vi.stubEnv("FINN_INVITE_PEPPER", PEPPER);
    vi.resetModules();
    const { getDriverStore } = await import("@/lib/driver");
    const session = await import("@/app/api/session/route");
    const { code } = await getDriverStore().createInvite({ label: "S", maxUses: 1, expiresAt: Date.now() + 60_000 });
    const paths: string[] = [];
    const server = createServer(async (req, res) => {
      paths.push(`${req.method} ${req.url}`);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://local${req.url}`, { method: req.method, headers, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
      const response = req.method === "POST" ? await session.POST(request) : await session.GET(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const out = await new Promise<string>((resolve) =>
        execFile(process.execPath, ["tests/smoke/session.mjs", `http://127.0.0.1:${port}`, code], (_e, so, se) => resolve(so + se)),
      );
      expect(out).toMatch(/PULADO/);
      expect(out.match(/PASSOU/g)).toHaveLength(3);
      expect(paths.some((p) => p.includes("orchestrator"))).toBe(false);
      expect(out).not.toMatch(/v1\.|drv_|FINN-/);
    } finally {
      server.close();
    }
  });
});
