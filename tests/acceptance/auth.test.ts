import { describe, expect, it, vi } from "vitest";
import { useHarness } from "../helpers/harness";
import { callA2A, callOrchestrator, getCard, messageSend, TEST_TOKEN } from "../helpers/http";
import { llm } from "../helpers/llm";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

describe("[core] auth — Bearer FINN_API_TOKEN", () => {
  const h = useHarness();

  const protectedCalls = {
    "POST /api/orchestrator": (token?: string | null) =>
      callOrchestrator({ transcript: "pausa a música" }, { token }),
    "POST /api/agents/spotify": (token?: string | null) =>
      callA2A("spotify", messageSend("pausa a música"), { token }),
    "POST /api/agents/waze": (token?: string | null) =>
      callA2A("waze", messageSend("me leva pro aeroporto"), { token }),
  };

  describe.each(Object.entries(protectedCalls))("%s", (_name, call) => {
    it("rejects a request without Authorization with 401 + WWW-Authenticate", async () => {
      const res = await call(null);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    });

    it.each([
      ["wrong token", "not-the-token"],
      ["token prefix", TEST_TOKEN.slice(0, -1)],
      ["token with suffix", `${TEST_TOKEN}x`],
      ["empty token", ""],
    ])("rejects a %s with 401", async (_label, token) => {
      expect((await call(token)).status).toBe(401);
    });

    it("fails closed with 503 when FINN_API_TOKEN is not configured", async () => {
      vi.stubEnv("FINN_API_TOKEN", "");
      expect((await call(TEST_TOKEN)).status).toBe(503);
    });

    it("never reaches an agent, the model or Spotify when rejected", async () => {
      await call(null);
      await call("nope");
      expect(llm.calls).toHaveLength(0);
      expect(h.spotify.calls).toHaveLength(0);
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
    const res = await getCard(agent);
    expect(res.status).toBe(200);
    expect(res.json.name).toBeTypeOf("string");
  });
});
