import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorResponse } from "@/lib/contracts/client-events";
import { DelegationHandler, SPEECH } from "./delegation-handler";
import { LOCAL_SPEECH } from "./failure-speech";
import { OrchestratorClient } from "./orchestrator-client";
import { TranscriptBuffer } from "./transcript-buffer";

const reply = (r: Partial<OrchestratorResponse>) =>
  Response.json({ speech: "", clientActions: [], results: [], ...r } satisfies OrchestratorResponse);

function setup(...responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  responses.forEach((r) => fetchImpl.mockResolvedValueOnce(r));
  const transcripts = new TranscriptBuffer();
  const orchestrator = new OrchestratorClient({ getToken: () => "tok", fetchImpl, newContextId: () => "ctx" });
  const spoken: Array<[string, string]> = [];
  const deps = {
    transcripts,
    orchestrator,
    speak: vi.fn((id: string, text: string) => void spoken.push([id, text])),
    onWorkStarted: vi.fn(),
    onWorkFinished: vi.fn(),
    onTurn: vi.fn(),
    onFailure: vi.fn(),
  };
  const handler = new DelegationHandler(deps);
  const bodies = () => fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
  return { handler, transcripts, deps, spoken, bodies, fetchImpl };
}

/** Runs the handler to completion under fake timers. */
async function run(p: Promise<void>) {
  await vi.runAllTimersAsync();
  await p;
}

describe("DelegationHandler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the driver's words before the delegation and speaks the orchestrator's speech", async () => {
    const { handler, transcripts, deps, spoken, bodies } = setup(reply({ speech: "Tocando Rock." }));
    transcripts.add({ delta: "toca ", startMs: 1_000, endMs: 1_300 });
    transcripts.add({ delta: "rock", startMs: 1_300, endMs: 1_600 });
    transcripts.add({ delta: "e aumenta", startMs: 2_500, endMs: 2_900 }); // said after the delegation

    await run(handler.handle({ id: "del_1", offsetMs: 2_000 }));

    expect(bodies()).toEqual([{ transcript: "toca rock", contextId: "ctx" }]);
    expect(spoken).toEqual([["del_1", "Tocando Rock."]]);
    expect(deps.onWorkStarted).toHaveBeenCalledTimes(1);
    expect(deps.onWorkFinished).toHaveBeenCalledTimes(1);
    expect(deps.onTurn).toHaveBeenCalledWith(expect.objectContaining({ transcript: "toca rock" }));
    expect(transcripts.peek()).toBe("e aumenta");
  });

  it("waits briefly for transcript fragments that arrive after the delegation event", async () => {
    const { handler, transcripts, bodies } = setup(reply({ speech: "Ok." }));
    const done = handler.handle({ id: "del_1", offsetMs: 2_000 });
    await vi.advanceTimersByTimeAsync(400);
    transcripts.add({ delta: "pausa a música", startMs: 1_000, endMs: 1_800 });
    await run(done);
    expect(bodies()).toEqual([{ transcript: "pausa a música", contextId: "ctx" }]);
  });

  it("asks the driver to repeat when there is no transcript", async () => {
    const { handler, spoken, fetchImpl } = setup();
    await run(handler.handle({ id: "del_1", offsetMs: 2_000 }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spoken).toEqual([["del_1", SPEECH.notUnderstood]]);
  });

  it("round-trips the continuation across delegations in the same window", async () => {
    const { handler, transcripts, bodies, spoken } = setup(
      reply({ speech: "Qual o endereço de casa?", continuation: { agent: "waze", state: { pendingLabel: "casa" } } }),
      reply({ speech: "Indo para casa.", clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=x" }] }),
    );
    transcripts.add({ delta: "me leva pra casa", startMs: 0, endMs: 900 });
    const first = handler.handle({ id: "del_1", offsetMs: 1_000 });
    transcripts.add({ delta: "Rua A, 100", startMs: 3_000, endMs: 3_900 });
    const second = handler.handle({ id: "del_2", offsetMs: 4_000 });
    await run(Promise.all([first, second]).then(() => undefined));

    expect(bodies()).toEqual([
      { transcript: "me leva pra casa", contextId: "ctx" },
      { transcript: "Rua A, 100", contextId: "ctx", continuation: { agent: "waze", state: { pendingLabel: "casa" } } },
    ]);
    expect(spoken).toEqual([
      ["del_1", "Qual o endereço de casa?"],
      ["del_2", "Indo para casa."],
    ]);
  });

  it("apologises by voice and reports a 401", async () => {
    const { handler, transcripts, spoken, deps } = setup(Response.json({ error: "Unauthorized" }, { status: 401 }));
    transcripts.add({ delta: "toca rock", startMs: 0, endMs: 500 });
    await run(handler.handle({ id: "del_1", offsetMs: 1_000 }));
    expect(spoken).toEqual([["del_1", SPEECH.unauthorized]]);
    expect(deps.onFailure).toHaveBeenCalledWith("unauthorized", "toca rock");
    expect(deps.onWorkFinished).toHaveBeenCalledTimes(1);
  });

  it("apologises by voice on server errors", async () => {
    const { handler, transcripts, spoken, deps } = setup(Response.json({ error: "x" }, { status: 500 }));
    transcripts.add({ delta: "toca rock", startMs: 0, endMs: 500 });
    await run(handler.handle({ id: "del_1", offsetMs: 1_000 }));
    expect(spoken).toEqual([["del_1", SPEECH.unavailable]]);
    expect(deps.onFailure).toHaveBeenCalledWith("server", "toca rock");
  });

  it("a 429 with scope 'day' is spoken locally with the daily-limit line, never the generic one", async () => {
    const { transcripts, spoken, deps } = setup(Response.json({ error: "Too many requests", scope: "day" }, { status: 429 }));
    const local: string[] = [];
    const withLocal = new DelegationHandler({ ...deps, speakLocal: (t) => void local.push(t) });
    transcripts.add({ delta: "toca rock", startMs: 0, endMs: 500 });
    await run(withLocal.handle({ id: "del_1", offsetMs: 1_000 }));
    expect(local).toEqual(["Você atingiu o limite de uso de hoje. Volte amanhã."]);
    expect(spoken).toEqual([]);
    expect(deps.onFailure).toHaveBeenCalledWith("day_limited", "toca rock");
  });

  it("a 503 never speaks the daily-limit line, even with scope 'day' in the body", async () => {
    const { transcripts, deps } = setup(Response.json({ scope: "day" }, { status: 503 }));
    const local: string[] = [];
    const withLocal = new DelegationHandler({ ...deps, speakLocal: (t) => void local.push(t) });
    transcripts.add({ delta: "toca rock", startMs: 0, endMs: 500 });
    await run(withLocal.handle({ id: "del_1", offsetMs: 1_000 }));
    expect(local).toEqual([LOCAL_SPEECH.unavailable]);
  });

  it.each([
    [429, "rate_limited", "Muitas tentativas, tente de novo em instantes."],
    [503, "unavailable", "O Finn está fora do ar agora, tente de novo daqui a pouco."],
  ] as const)("a %i is spoken locally (phone TTS, no network) with the fixed line", async (status, failure, line) => {
    const { transcripts, spoken, deps } = setup(Response.json({ error: "x" }, { status }));
    const local: string[] = [];
    const withLocal = new DelegationHandler({ ...deps, speakLocal: (t) => void local.push(t) });
    transcripts.add({ delta: "toca rock", startMs: 0, endMs: 500 });
    await run(withLocal.handle({ id: "del_1", offsetMs: 1_000 }));
    expect(local).toEqual([line]);
    expect(spoken).toEqual([]);
    expect(deps.onFailure).toHaveBeenCalledWith(failure, "toca rock");
  });

  it("recovers via fallback when fragments arrived with startMs >= offsetMs (timestamp jitter)", async () => {
    const { handler, transcripts, bodies, spoken } = setup(reply({ speech: "Tocando Capital Inicial." }));
    // Timestamp skew: fragment started at 2_050ms, but delegation was emitted at 2_000ms
    transcripts.add({ delta: "toca Capital Inicial", startMs: 2_050, endMs: 2_500 });
    await run(handler.handle({ id: "del_skew", offsetMs: 2_000 }));

    expect(bodies()).toEqual([{ transcript: "toca Capital Inicial", contextId: "ctx" }]);
    expect(spoken).toEqual([["del_skew", "Tocando Capital Inicial."]]);
    expect(transcripts.peek()).toBe("");
  });

  it("drops stale unconsumed fragments from a previous turn separated by a large time gap", async () => {
    const { handler, transcripts, bodies } = setup(reply({ speech: "Ok." }));
    // Unconsumed fragment from 10 seconds ago
    transcripts.add({ delta: "toca rock", startMs: 1_000, endMs: 1_500 });
    // New utterance from current turn
    transcripts.add({ delta: "pausa a música", startMs: 12_000, endMs: 12_800 });

    await run(handler.handle({ id: "del_2", offsetMs: 13_000 }));
    // Does NOT concatenate "toca rock pausa a música"; only the current turn is sent
    expect(bodies()).toEqual([{ transcript: "pausa a música", contextId: "ctx" }]);
  });
});
