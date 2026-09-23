import { describe, expect, it, vi } from "vitest";
import { AGENT_TIMEOUT_MS } from "@/orchestrator/orchestrate";
import { expectFriendlySpeech, expectOrchestratorResponse, openUrls, resultOf, wazeUrl } from "../helpers/assertions";
import { useHarness } from "../helpers/harness";
import { callOrchestrator, say as turn } from "../helpers/http";
import { call, llm, say } from "../helpers/llm";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

const scriptWazeCongonhas = () => {
  llm.scripts.waze = {
    turns: [call("navigate_to", { destination: "Aeroporto de Congonhas" }), say("Indo pro Aeroporto de Congonhas.")],
  };
};

describe("[core] robustness — request validation", () => {
  useHarness();

  it("invalid JSON body → 400", async () => {
    const res = await callOrchestrator({}, { rawBody: "{transcript: oops" });
    expect(res.status).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    ["missing", {}],
    ["blank", { transcript: "   " }],
    ["not a string", { transcript: 42 }],
  ])("%s transcript → 400", async (_label, body) => {
    expect((await callOrchestrator(body)).status).toBe(400);
  });

  it.each([
    ["an unknown agent", { agent: "siri", state: {} }],
    ["a string", "casa"],
    ["null", null],
  ])("ignores a continuation that is %s (no crash, normal routing)", async (_label, continuation) => {
    const res = await callOrchestrator({ transcript: "que horas são?", continuation });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([]);
  });
});

describe("[core] robustness — routing", () => {
  const h = useHarness();

  it.each(["que horas são?", "conta uma piada", "liga pra minha mãe"])(
    "%s → friendly prompt, no agent/model/Spotify call",
    async (transcript) => {
      const res = await turn(transcript);
      expectOrchestratorResponse(res);
      expect(res.results).toEqual([]);
      expect(res.clientActions).toEqual([]);
      expect(res.speech).toMatch(/música|lugar/);
      expectFriendlySpeech(res.speech);
      expect(llm.calls).toHaveLength(0);
      expect(h.spotify.calls).toHaveLength(0);
    },
  );
});

describe("[core] robustness — one agent misbehaving doesn't break the other", () => {
  useHarness();

  it(`an agent that exceeds the time budget (${AGENT_TIMEOUT_MS}ms) is reported as failed; the other still acts`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    llm.scripts.spotify = { hang: true, turns: [] };
    scriptWazeCongonhas();

    const pending = turn("toca Rock Nacional e me leva pro aeroporto de Congonhas");
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS + 50);
    const res = await pending;

    expect(resultOf(res, "spotify").status).toBe("failed");
    expect(resultOf(res, "waze").status).toBe("completed");
    expect(openUrls(res)).toEqual([wazeUrl("Aeroporto de Congonhas")]);
    expect(res.speech).toContain("Congonhas");
    expectFriendlySpeech(res.speech, { maxChars: 240 });
  });

  it("the timed-out agent's model call is aborted (no work after the deadline)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    llm.scripts.spotify = { hang: true, turns: [] };
    scriptWazeCongonhas();

    const pending = turn("toca Rock Nacional e me leva pro aeroporto de Congonhas");
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS + 50);
    await pending;
    expect(llm.callsFor("spotify")[0]?.signal?.aborted).toBe(true);
  });

  it("Neuralake failing for one agent → that agent fails with a spoken apology, the other still acts", async () => {
    llm.scripts.spotify = { fail: new Error("Neuralake request failed (502): Bad Gateway"), turns: [] };
    scriptWazeCongonhas();
    const res = await turn("toca Rock Nacional e me leva pro aeroporto de Congonhas");

    expect(resultOf(res, "spotify").status).toBe("failed");
    expectFriendlySpeech(resultOf(res, "spotify").speech, { maxChars: 120 });
    expect(openUrls(res)).toEqual([wazeUrl("Aeroporto de Congonhas")]);
  });

  it("a model calling an unknown tool → failed with a spoken apology, HTTP 200", async () => {
    llm.scripts.waze = { turns: [call("delete_everything", {})] };
    const res = await turn("me leva pro aeroporto de Congonhas");
    expect(resultOf(res, "waze").status).toBe("failed");
    expect(res.clientActions).toEqual([]);
    expectFriendlySpeech(res.speech, { maxChars: 120 });
  });

  it("a model that never stops calling tools is cut off and reported as failed", async () => {
    llm.scripts.waze = {
      turns: Array.from({ length: 20 }, () => call("navigate_to", { destination: "Aeroporto de Congonhas" })),
    };
    const res = await turn("me leva pro aeroporto de Congonhas");
    expect(resultOf(res, "waze").status).toBe("failed");
    expect(llm.callsFor("waze").length).toBeLessThanOrEqual(6);
    expectFriendlySpeech(res.speech, { maxChars: 120 });
    // The PWA must not be told to open the same deep link once per looped call.
    expect(openUrls(res).length).toBeLessThanOrEqual(1);
  });
});
