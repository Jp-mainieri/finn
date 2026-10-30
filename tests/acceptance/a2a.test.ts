import { describe, expect, it, vi } from "vitest";
import { SPOTIFY_TOOLS, WAZE_TOOLS } from "@/lib/contracts/tools";
import nextConfig from "../../next.config";
import { expectPublicResult } from "../helpers/assertions";
import { useHarness } from "../helpers/harness";
import { callA2A, getCard, messageSend, ORIGIN } from "../helpers/http";
import { call, llm, say } from "../helpers/llm";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

describe("[core] A2A Agent Cards", () => {
  useHarness();

  const toolNames = { spotify: SPOTIFY_TOOLS, waze: WAZE_TOOLS };

  it("is served at /agents/<id>/.well-known/agent.json (rewrite to the card handler)", async () => {
    const rewrites = await nextConfig.rewrites?.();
    const list = Array.isArray(rewrites) ? rewrites : [...(rewrites?.beforeFiles ?? []), ...(rewrites?.afterFiles ?? [])];
    expect(list).toContainEqual(
      expect.objectContaining({
        source: "/agents/:agent/.well-known/agent.json",
        destination: "/api/agents/:agent/card",
      }),
    );
  });

  describe.each(["spotify", "waze"] as const)("%s card", (agent) => {
    it("has name, description, task URL and A2A metadata", async () => {
      const res = await getCard(agent);
      expect(res.status).toBe(200);
      const card = res.json;
      expect(card.name).toEqual(expect.stringMatching(/\S/));
      expect(card.description).toEqual(expect.stringMatching(/\S/));
      expect(card.url).toBe(`${ORIGIN}/api/agents/${agent}`);
      expect(card).toMatchObject({
        version: expect.any(String),
        protocolVersion: expect.any(String),
        preferredTransport: "JSONRPC",
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: expect.arrayContaining(["text/plain"]),
        defaultOutputModes: expect.any(Array),
      });
    });

    it(`[${agent}] has the real description, not the Phase 0 stub`, async () => {
      expect((await getCard(agent)).json.description).not.toMatch(/\bstub\b/i);
    });

    it("exposes one skill per tool (id = tool name)", async () => {
      const skills = (await getCard(agent)).json.skills as { id: string; name: string; description: string; tags: string[] }[];
      expect(skills.map((s) => s.id).sort()).toEqual(toolNames[agent].map((t) => t.function.name).sort());
      for (const s of skills) {
        expect(s.name).toEqual(expect.stringMatching(/\S/));
        expect(s.description).toEqual(expect.stringMatching(/\S/));
        expect(Array.isArray(s.tags)).toBe(true);
      }
    });
  });

  it("returns 404 for an unknown agent", async () => {
    expect((await getCard("siri")).status).toBe(404);
  });
});

describe("[core] A2A message/send (JSON-RPC 2.0)", () => {
  useHarness();

  it("returns 404 for an unknown agent", async () => {
    expect((await callA2A("siri", messageSend("oi"))).status).toBe(404);
  });

  it("-32700 on an unparseable body", async () => {
    const res = await callA2A("waze", undefined, { rawBody: "{not json" });
    expect(res.json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });

  it.each([
    ["an unknown method", messageSend("oi", { method: "tasks/get", id: 7 }), 7],
    ["a non-2.0 jsonrpc", { ...(messageSend("oi", { id: 8 }) as object), jsonrpc: "1.0" }, 8],
  ])("-32601 for %s, echoing the request id", async (_label, body, id) => {
    const res = await callA2A("spotify", body);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ jsonrpc: "2.0", id, error: { code: -32601 } });
    expect(res.json.result).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    ["no parts", messageSend(null)],
    ["a blank text part", messageSend("   ")],
    ["only a data part", messageSend(null, { continuation: { pendingLabel: "casa" } })],
    ["no message", { jsonrpc: "2.0", id: 3, method: "message/send", params: {} }],
  ])("-32602 when the message has %s", async (_label, body) => {
    const res = await callA2A("waze", body);
    expect(res.json).toMatchObject({ jsonrpc: "2.0", error: { code: -32602 } });
    expect(llm.calls).toHaveLength(0);
  });

  it("[waze] returns a Task whose artifact is only { agent, status, speech }", async () => {
    llm.scripts.waze = {
      turns: [call("navigate_to", { destination: "Aeroporto de Congonhas" }), say("Indo pro Aeroporto de Congonhas.")],
    };
    const res = await callA2A("waze", messageSend("me leva pro aeroporto de Congonhas", { id: "req-42", contextId: "ctx-a2a" }));

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ jsonrpc: "2.0", id: "req-42" });
    expect(res.json.error).toBeUndefined();
    const task = res.json.result!;
    expect(task).toMatchObject({ kind: "task", id: expect.any(String), contextId: "ctx-a2a" });
    expect(task.status.state).toBe("completed");
    expect(task.status.message).toMatchObject({ kind: "message", role: "agent", contextId: "ctx-a2a" });
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0]).toMatchObject({ artifactId: expect.any(String), name: "result" });
    expect(task.artifacts[0].parts).toHaveLength(1);
    const part = task.artifacts[0].parts[0];
    expect(part.kind).toBe("data");

    const result = part.data;
    expectPublicResult(result, "waze");
    expect(result.status).toBe(task.status.state);
    expect(task.status.message?.parts).toEqual([{ kind: "text", text: result.speech }]);
    // No deep link, no tool arguments: addresses never leave the server over A2A.
    expect(JSON.stringify(res.json)).not.toMatch(/waze\.com|toolCalls|clientActions/);
  });

  it("[waze] generates a contextId when the caller sends none", async () => {
    llm.scripts.waze = { turns: [say("Pra onde?")] };
    const res = await callA2A("waze", messageSend("navega"));
    expect(res.json.result?.contextId).toEqual(expect.stringMatching(/\S/));
  });

  it("[waze] passes the full transcript to the agent's model", async () => {
    llm.scripts.waze = { turns: [say("Ok.")] };
    await callA2A("waze", messageSend("me leva pra Rua Augusta, 500"));
    const user = llm.callsFor("waze")[0]?.messages.find((m) => m.role === "user");
    expect(user?.content).toContain("Rua Augusta, 500");
  });
});
