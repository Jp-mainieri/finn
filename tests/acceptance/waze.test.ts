/**
 * waze-agent acceptance: UC3 (free-form destination) and saved addresses
 * ("casa"/"trabalho") with the input-required continuation round trip.
 */
import { describe, expect, it, vi } from "vitest";
import type { Continuation } from "@/lib/contracts/a2a";
import {
  expectPublicResult,
  expectFriendlySpeech,
  expectOrchestratorResponse,
  openUrls,
  resultOf,
  toolCall,
  wazeUrl,
} from "../helpers/assertions";
import { useHarness } from "../helpers/harness";
import { callA2A, messageSend, say as turn } from "../helpers/http";
import { call, llm, say, toolMessages } from "../helpers/llm";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

function navigateThenConfirm(destination: string, confirmation = `Abrindo a rota pra ${destination}.`) {
  llm.scripts.waze = { turns: [call("navigate_to", { destination }), say(confirmation)] };
}

describe("[waze] UC3 — navigate to a spoken destination", () => {
  const h = useHarness();

  it.each([
    ["me leva pro aeroporto de Congonhas", "Aeroporto de Congonhas"],
    ["navega até a Avenida Paulista, 1000", "Avenida Paulista, 1000"],
    ["quero chegar na Rua Oscar Freire, 900 - Jardins", "Rua Oscar Freire, 900 - Jardins"],
    ["vai pra Praça da Sé & arredores", "Praça da Sé & arredores"],
  ])("%s → one open_url with the encoded Waze deep link", async (transcript, destination) => {
    navigateThenConfirm(destination);
    const res = await turn(transcript);

    expectOrchestratorResponse(res);
    expect(res.results.map((r) => r.agent)).toEqual(["waze"]);
    const waze = resultOf(res, "waze");
    expect(waze.status).toBe("completed");
    expect(res.continuation).toBeUndefined();

    expect(res.clientActions).toHaveLength(1);
    const [action] = res.clientActions;
    expect(action).toMatchObject({ type: "open_url", url: wazeUrl(destination) });
    expect(action.label).toEqual(expect.stringMatching(/\S/));
    expect(action.label).not.toMatch(/https?:/);
    expect(toolCall(waze, "navigate_to")?.ok).toBe(true);

    expect(h.spotify.spotifyCalls).toEqual([]);
    expect(llm.callsFor("spotify")).toHaveLength(0);
    expect(res.speech).toMatch(/\S/);
  });

  it("the tool result gives the model the destination, never the URL (it must not read links aloud)", async () => {
    navigateThenConfirm("Aeroporto de Congonhas");
    const res = await turn("me leva pro aeroporto de Congonhas");
    const result = toolCall(resultOf(res, "waze"), "navigate_to")?.result;
    expect(result).toMatchObject({ navigating_to: expect.any(String) }); // confirmed shape
    expect(JSON.stringify(result)).not.toMatch(/https?:|waze\.com/);
    // What the model actually received as the tool message:
    const fed = toolMessages(llm.callsFor("waze")[1]);
    expect(fed).toHaveLength(1);
    expect(fed[0]).not.toMatch(/https?:|waze\.com/);
  });

  it("offers the model only navigate_to", async () => {
    navigateThenConfirm("Aeroporto de Congonhas");
    await turn("me leva pro aeroporto de Congonhas");
    expect(llm.callsFor("waze")[0]?.tools?.map((t) => t.function.name)).toEqual(["navigate_to"]);
  });

  it("does not open anything if the model never calls navigate_to", async () => {
    llm.scripts.waze = { turns: [say("Pra onde você quer ir?")] };
    const res = await turn("quero ir pra um lugar");
    expect(res.clientActions).toEqual([]);
    expectFriendlySpeech(res.speech);
  });

  it("still speaks something when the model ends with empty text", async () => {
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "Aeroporto de Congonhas" }), say("")] };
    const res = await turn("me leva pro aeroporto de Congonhas");
    expect(openUrls(res)).toEqual([wazeUrl("Aeroporto de Congonhas")]);
    expectFriendlySpeech(resultOf(res, "waze").speech);
  });

  it("empty destination → asks where to, then the keyword-less answer navigates", async () => {
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "" }), say("Pra onde você quer ir?")] };
    const ask = await turn("abre o waze");
    expect(resultOf(ask, "waze").status).toBe("input-required");
    expect(toolCall(resultOf(ask, "waze"), "navigate_to")?.result).toMatchObject({ needs_destination: true });
    expect(ask.clientActions).toEqual([]);
    expect(ask.continuation).toEqual({ agent: "waze", state: { awaitingDestination: true } });

    navigateThenConfirm("Avenida Paulista, 1000");
    const answer = await turn("Avenida Paulista, 1000", { continuation: ask.continuation });
    expect(openUrls(answer)).toEqual([wazeUrl("Avenida Paulista, 1000")]);
    expect(answer.continuation).toBeUndefined();
  });
});

describe("[waze] saved addresses — casa / trabalho", () => {
  const h = useHarness({ addressBook: true });

  async function askHomeUnsaved(transcript = "me leva pra casa", destination = "minha casa") {
    llm.scripts.waze = {
      turns: [call("navigate_to", { destination }), say("Qual é o endereço da sua casa?")],
    };
    return turn(transcript);
  }

  it("unsaved 'casa' → input-required: asks for the address, no open_url, returns a continuation", async () => {
    const res = await askHomeUnsaved();

    const waze = resultOf(res, "waze");
    expect(waze.status).toBe("input-required");
    expect(res.clientActions).toEqual([]);
    expect(toolCall(waze, "navigate_to")?.result).toMatchObject({ needs_address: "casa" });
    expect(res.continuation).toEqual({ agent: "waze", state: { pendingLabel: "casa" } });
    expectFriendlySpeech(res.speech);
  });

  it.each(["minha casa", "pra casa", "casa", "Minha Casa", "me leva pra minha casa"])(
    "normalizes destination %j to the canonical label 'casa'",
    async (destination) => {
      const res = await askHomeUnsaved("me leva pra casa", destination);
      expect(res.continuation).toEqual({ agent: "waze", state: { pendingLabel: "casa" } });
    },
  );

  it.each(["meu trabalho", "trabalho", "serviço", "escritório", "o escritório"])(
    "normalizes destination %j to the canonical label 'trabalho'",
    async (destination) => {
      llm.scripts.waze = { turns: [call("navigate_to", { destination }), say("Qual o endereço do seu trabalho?")] };
      const res = await turn("me leva pro trabalho");
      expect(res.continuation).toEqual({ agent: "waze", state: { pendingLabel: "trabalho" } });
    },
  );

  it("full flow: ask → keyword-less answer is routed back to waze and saved → reused next time", async () => {
    // Turn 1: unknown home.
    const first = await askHomeUnsaved();
    const continuation = first.continuation as Continuation;
    expect(continuation).toBeDefined();

    // Turn 2: the driver answers with just the address (no routing keyword).
    navigateThenConfirm("Rua Augusta, 123", "Salvei sua casa. Indo pra lá.");
    const second = await turn("Rua Augusta, 123", { continuation });

    expect(second.results.map((r) => r.agent)).toEqual(["waze"]);
    expect(llm.callsFor("spotify")).toHaveLength(0);
    expect(resultOf(second, "waze").status).toBe("completed");
    expect(openUrls(second)).toEqual([wazeUrl("Rua Augusta, 123")]);
    expect(second.continuation).toBeUndefined();

    // Turn 3 (later, no continuation): "casa" now resolves to the saved address.
    navigateThenConfirm("casa", "Indo pra casa.");
    const third = await turn("me leva pra casa");
    expect(resultOf(third, "waze").status).toBe("completed");
    expect(openUrls(third)).toEqual([wazeUrl("Rua Augusta, 123")]);
    expect(third.clientActions[0].label).toMatch(/casa/i); // confirmed: "Navegar para casa"
    expect(third.continuation).toBeUndefined();
    expect(h.spotify.spotifyCalls).toEqual([]);
  });

  it("saving 'casa' does not fill 'trabalho'", async () => {
    await askHomeUnsaved();
    navigateThenConfirm("Rua Augusta, 123");
    await turn("Rua Augusta, 123", { continuation: { agent: "waze", state: { pendingLabel: "casa" } } });

    llm.scripts.waze = { turns: [call("navigate_to", { destination: "trabalho" }), say("Qual o endereço do trabalho?")] };
    const res = await turn("me leva pro trabalho");
    expect(res.clientActions).toEqual([]);
    expect(res.continuation).toEqual({ agent: "waze", state: { pendingLabel: "trabalho" } });
  });

  it("an unrelated destination is not treated as a label", async () => {
    navigateThenConfirm("Casa do Pão de Queijo, Rua Augusta");
    const res = await turn("me leva pra Casa do Pão de Queijo da Rua Augusta");
    expect(res.continuation).toBeUndefined();
    expect(openUrls(res)).toEqual([wazeUrl("Casa do Pão de Queijo, Rua Augusta")]);
  });

  it("works over A2A too: the artifact hides the continuation; the client echoes the state it knows in a data part", async () => {
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Qual o endereço da sua casa?")] };
    const ask = await callA2A("waze", messageSend("me leva pra casa", { contextId: "ctx-a2a-home" }));
    const task = ask.json.result!;
    expect(task.status.state).toBe("input-required");
    const askResult = task.artifacts[0].parts[0].data;
    expectPublicResult(askResult, "waze");
    expect(askResult.status).toBe("input-required");

    navigateThenConfirm("Rua Augusta, 123");
    const answer = await callA2A(
      "waze",
      messageSend("Rua Augusta, 123", { contextId: "ctx-a2a-home", continuation: { pendingLabel: "casa" } }),
    );
    const done = answer.json.result!;
    expect(done.status.state).toBe("completed");
    expectPublicResult(done.artifacts[0].parts[0].data, "waze");
    // A2A runs as the owner; no deep link or action leaves the server (the speech is the model's own sentence).
    expect(JSON.stringify(answer.json)).not.toMatch(/waze\.com|clientActions|toolCalls/);
  });
});
