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
        execFile(process.execPath, ["tests/smoke/session.mjs", `http://127.0.0.1:${port}`, code], (err, stdout, stderr) => {
          resolve({ stdout: stdout + stderr, code: (err as { code?: number } | null)?.code ?? 0 });
        });
      });
      expect(exit).toBe(0);
      expect(stdout.match(/PASSOU/g)).toHaveLength(4);
      expect(stdout).not.toMatch(/FALHOU|v1\.|drv_|FINN-/);
      expect(stdout).toMatch(/HTTP 200/);
    } finally {
      server.close();
    }
  });
});
