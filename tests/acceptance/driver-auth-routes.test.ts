import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routes = {
  orchestrator: () => import("@/app/api/orchestrator/route"),
  transcribe: () => import("@/app/api/realtime/transcribe/route"),
  tts: () => import("@/app/api/realtime/tts/route"),
  session: () => import("@/app/api/realtime/session/route"),
};

const call = async (name: keyof typeof routes, token?: string) => {
  const { POST } = await routes[name]();
  return POST(
    new Request(`http://x/api/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: "{}",
    }),
  );
};

describe("routes protected by authorizeDriver", () => {
  beforeEach(() => {
    vi.stubEnv("FINN_API_TOKEN", "legacy-s3cret");
    vi.stubEnv("FINN_SESSION_SECRET", "3f9a1c7e5b2d48806ae1f4c93d7b05e2a8c61f9d04b37e5a2c8d1f6039ab74ce");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe.each(Object.keys(routes) as (keyof typeof routes)[])("%s", (name) => {
    it("rejects without a token and with a wrong one", async () => {
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
      expect((await call(name)).status).toBe(401);
      expect((await call(name, "wrong")).status).toBe(401);
      expect((await call(name, "v1.wrong.wrong")).status).toBe(401);
    });

    it("rejects the legacy token when the flag is off, accepts it when it is exactly 1", async () => {
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "true");
      expect((await call(name, "legacy-s3cret")).status).toBe(401);
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
      const ok = await call(name, "legacy-s3cret");
      // Passed auth: later failures (invalid body, missing provider keys) are the route's own.
      expect(ok.status === 401 && ok.headers.has("www-authenticate")).toBe(false);
      expect(await ok.text()).not.toMatch(/Unauthorized|indisponível agora/);
    });
  });
});
