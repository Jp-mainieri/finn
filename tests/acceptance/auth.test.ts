import { describe, expect, it, vi } from "vitest";
import { useHarness } from "../helpers/harness";
import { callA2A, callOrchestrator, getCard, messageSend, TEST_A2A_TOKEN, TEST_TOKEN } from "../helpers/http";
import { llm } from "../helpers/llm";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

describe("[core] auth — Bearer FINN_API_TOKEN (orchestrator) / FINN_A2A_TOKEN (A2A)", () => {
  const h = useHarness();

  // `unconfigured`: status when the endpoint's own secret (`envVar`) is empty. /api/agents/* uses authorizeA2A (503, off);
  // /api/orchestrator uses authorizeDriver, where an unset legacy token simply never matches (401, still closed).
  const protectedCalls = {
    "POST /api/orchestrator": {
      envVar: "FINN_API_TOKEN",
      good: TEST_TOKEN,
      unconfigured: 401,
      call: (token?: string | null) => callOrchestrator({ transcript: "pausa a música" }, { token }),
    },
    "POST /api/agents/spotify": {
      envVar: "FINN_A2A_TOKEN",
      good: TEST_A2A_TOKEN,
      unconfigured: 503,
      call: (token?: string | null) => callA2A("spotify", messageSend("pausa a música"), { token }),
    },
    "POST /api/agents/waze": {
      envVar: "FINN_A2A_TOKEN",
      good: TEST_A2A_TOKEN,
      unconfigured: 503,
      call: (token?: string | null) => callA2A("waze", messageSend("me leva pro aeroporto"), { token }),
    },
  };

  describe.each(Object.entries(protectedCalls))("%s", (_name, { call, unconfigured, envVar, good }) => {
    it("rejects a request without Authorization with 401 + WWW-Authenticate", async () => {
      const res = await call(null);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    });

    it.each([
      ["wrong token", "not-the-token"],
      ["token prefix", good.slice(0, -1)],
      ["token with suffix", `${good}x`],
      ["empty token", ""],
    ])("rejects a %s with 401", async (_label, token) => {
      expect((await call(token)).status).toBe(401);
    });

    it("fails closed when its own secret is not configured", async () => {
      vi.stubEnv(envVar, "");
      expect((await call(good)).status).toBe(unconfigured);
    });

    it("never reaches an agent, the model or Spotify when rejected", async () => {
      await call(null);
      await call("nope");
      expect(llm.calls).toHaveLength(0);
      expect(h.spotify.calls).toHaveLength(0);
    });
  });

  describe("A2A has its own secret", () => {
    const send = (token?: string | null) => callA2A("spotify", messageSend("pausa a música"), { token });

    it("accepts FINN_A2A_TOKEN", async () => {
      expect((await send(TEST_A2A_TOKEN)).status).toBe(200);
    });

    it.each([["flag on", "1"], ["flag off", undefined]])("FINN_API_TOKEN does not open it (legacy %s)", async (_l, flag) => {
      vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", flag);
      expect((await send(TEST_TOKEN)).status).toBe(401);
      expect(llm.calls).toHaveLength(0);
      expect(h.spotify.calls).toHaveLength(0);
    });

    it.each([["unset", undefined], ["empty", ""], ["spaces", "   "], ["short", "short-secret"], ["trivial", "a".repeat(40)]])(
      "is off (503) when FINN_A2A_TOKEN is %s, and FINN_API_TOKEN still does not open it",
      async (_l, value) => {
        vi.stubEnv("FINN_A2A_TOKEN", value);
        vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
        for (const t of [TEST_A2A_TOKEN, TEST_TOKEN, value ?? ""]) expect((await send(t)).status).toBe(503);
        expect(llm.calls).toHaveLength(0);
        expect(h.spotify.calls).toHaveLength(0);
      },
    );

    it("does not affect /api/orchestrator (FINN_API_TOKEN still works there, FINN_A2A_TOKEN does not)", async () => {
      vi.stubEnv("FINN_A2A_TOKEN", "");
      expect((await callOrchestrator({ transcript: "pausa a música" })).status).toBe(200);
      vi.stubEnv("FINN_A2A_TOKEN", TEST_A2A_TOKEN);
      expect((await callOrchestrator({ transcript: "pausa" }, { token: TEST_A2A_TOKEN })).status).toBe(401);
    });
  });

  it("rejects a raw token without the Bearer scheme", async () => {
    const req = new Request("https://finn.test/api/orchestrator", {
      method: "POST",
      headers: { authorization: TEST_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ transcript: "pausa" }),
    });
    const { POST } = await import("@/app/api/orchestrator/route");
    expect((await POST(req)).status).toBe(401);
  });

  it.each(["spotify", "waze"])("Agent Card for %s is public (no token needed)", async (agent) => {
    vi.stubEnv("FINN_API_TOKEN", "");
    vi.stubEnv("FINN_A2A_TOKEN", "");
    const res = await getCard(agent);
    expect(res.status).toBe(200);
    expect(res.json.name).toBeTypeOf("string");
  });
});
