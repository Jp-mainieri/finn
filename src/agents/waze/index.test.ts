import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentResult } from "@/lib/contracts/a2a";
import type { NeuralakeClient } from "@/lib/contracts/neuralake";
import { WAZE_TOOLS } from "@/lib/contracts/tools";
import { MockNeuralakeClient, textMessage, toolCallMessage, type MockScript } from "@/lib/neuralake/mock";
import { getAddressBook, resetAddressBook } from "@/lib/waze/address-book";
import { orchestrate } from "@/orchestrator/orchestrate";
import { wazeAgent } from "./index";

const mocks = vi.hoisted(() => ({ client: undefined as NeuralakeClient | undefined }));
vi.mock("@/lib/neuralake/client", () => ({
  getNeuralakeClient: () => {
    if (!mocks.client) throw new Error("test did not set a Neuralake client");
    return mocks.client;
  },
}));

/** Model that calls navigate_to once with `destination`, then answers from the tool result. */
function navigateScript(destination: string): MockScript {
  return (req) => {
    const last = req.messages.at(-1);
    if (last?.role !== "tool") return toolCallMessage("navigate_to", { destination });
    const out = JSON.parse(last.content);
    if (out.needs_address) return textMessage(`Qual é o endereço da sua ${out.needs_address}?`);
    return textMessage(`Beleza, rota para ${out.navigating_to}.`);
  };
}

function useModel(script: MockScript): MockNeuralakeClient {
  const client = new MockNeuralakeClient(script);
  mocks.client = client;
  return client;
}

const handle = (transcript: string, continuation?: unknown) =>
  wazeAgent.handle({ transcript, contextId: "ctx", continuation });

beforeEach(() => {
  vi.stubEnv("WAZE_SAVED_ADDRESSES", "");
  resetAddressBook();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAddressBook();
  mocks.client = undefined;
});

describe("wazeAgent", () => {
  it("navigates to a free-form destination (UC3)", async () => {
    const client = useModel(navigateScript("Shopping Iguatemi"));
    const res = await handle("me leva pro Shopping Iguatemi");

    expect(res).toMatchObject({
      agent: "waze",
      status: "completed",
      speech: "Beleza, rota para Shopping Iguatemi.",
      clientActions: [
        {
          type: "open_url",
          url: "https://waze.com/ul?q=Shopping%20Iguatemi&navigate=yes",
          label: "Navegar para Shopping Iguatemi",
        },
      ],
    });
    expect(res.continuation).toBeUndefined();
    expect(res.toolCalls).toEqual([
      {
        name: "navigate_to",
        arguments: { destination: "Shopping Iguatemi" },
        result: { navigating_to: "Shopping Iguatemi" },
        ok: true,
      },
    ]);
    expect(client.calls[0].tools).toEqual(WAZE_TOOLS);
    expect(client.calls[0].memoryScope).toBe("finn-waze");
    // The model never sees the URL.
    expect(client.calls[1].messages.at(-1)?.content).not.toContain("waze.com");
  });

  it("asks for, saves and then reuses the home address", async () => {
    // Turn 1: no saved address → input-required with a continuation.
    useModel(navigateScript("casa"));
    const first = await handle("me leva pra casa");
    expect(first).toMatchObject({
      status: "input-required",
      speech: "Qual é o endereço da sua casa?",
      clientActions: [],
      continuation: { pendingLabel: "casa" },
    });
    expect(first.toolCalls[0].result).toEqual({ needs_address: "casa" });

    // Turn 2: the driver answers; the continuation is echoed back.
    const client = useModel(navigateScript("Rua Augusta, 123"));
    const second = await handle("Rua Augusta, 123", first.continuation);
    expect(client.calls[0].messages[0]).toMatchObject({ role: "system" });
    expect(client.calls[0].messages[0].content).toContain("endereço da casa");
    expect(second).toMatchObject({
      status: "completed",
      clientActions: [
        {
          type: "open_url",
          url: "https://waze.com/ul?q=Rua%20Augusta%2C%20123&navigate=yes",
          label: "Navegar para casa",
        },
      ],
    });
    expect(second.continuation).toBeUndefined();
    expect(await getAddressBook().get("casa")).toBe("Rua Augusta, 123");

    // Turn 3: next time, the saved address is used without asking.
    useModel(navigateScript("minha casa"));
    const third = await handle("me leva pra casa");
    expect(third).toMatchObject({
      status: "completed",
      speech: "Beleza, rota para casa.",
      clientActions: [
        { type: "open_url", url: "https://waze.com/ul?q=Rua%20Augusta%2C%20123&navigate=yes" },
      ],
    });
  });

  it("uses the work address seeded from WAZE_SAVED_ADDRESSES", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", JSON.stringify({ trabalho: "Av. Paulista, 1000" }));
    resetAddressBook();
    useModel(navigateScript("escritório"));
    const res = await handle("me leva pro escritório");
    expect(res).toMatchObject({
      status: "completed",
      clientActions: [
        {
          type: "open_url",
          url: "https://waze.com/ul?q=Av.%20Paulista%2C%201000&navigate=yes",
          label: "Navegar para o trabalho",
        },
      ],
    });
  });

  it("only adds turn context to the prompt when resuming", async () => {
    const client = useModel(navigateScript("Shopping Iguatemi"));
    await handle("me leva pro Shopping Iguatemi", { unexpected: true });
    expect(client.calls[0].messages[0].content).not.toContain("Contexto deste turno");
  });

  it("speaks a fallback when the model ends the turn without text", async () => {
    useModel((req) =>
      req.messages.at(-1)?.role === "tool" ? textMessage("") : toolCallMessage("navigate_to", { destination: "trabalho" }),
    );
    const res = await handle("me leva pro trabalho");
    expect(res).toMatchObject({ status: "input-required", speech: "Qual é o endereço do seu trabalho?" });
  });

  it("fails with a short spoken message when the model errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.client = { complete: () => Promise.reject(new Error("neuralake down")) };
    const res = await handle("me leva pro Shopping Iguatemi");
    expect(res).toMatchObject({ status: "failed", speech: "Não consegui definir a rota agora.", clientActions: [] });
    vi.restoreAllMocks();
  });

  it("serves an Agent Card with the navigate_to skill", () => {
    const card = wazeAgent.card("https://finn.example");
    expect(card).toMatchObject({ name: "waze-agent", url: "https://finn.example/api/agents/waze" });
    expect(card.skills.map((s) => s.id)).toEqual(["navigate_to"]);
    expect(card.skills[0].examples?.length).toBeGreaterThan(0);
  });
});

describe("wazeAgent through the orchestrator", () => {
  const spotify: Agent = {
    id: "spotify",
    card: () => {
      throw new Error("not used");
    },
    handle: async (): Promise<AgentResult> => ({
      agent: "spotify",
      status: "completed",
      speech: "Tocando sua playlist.",
      clientActions: [],
      toolCalls: [],
    }),
  };
  const agents = { spotify, waze: wazeAgent };

  it("round-trips the home-address continuation, even alongside music (UC7)", async () => {
    useModel(navigateScript("casa"));
    const first = await orchestrate("toca minha playlist e me leva pra casa", { agents, contextId: "ctx" });
    expect(first.speech).toBe("Tocando sua playlist. Qual é o endereço da sua casa?");
    expect(first.clientActions).toEqual([]);
    expect(first.continuation).toEqual({ agent: "waze", state: { pendingLabel: "casa" } });

    useModel(navigateScript("Rua Augusta, 123"));
    const second = await orchestrate("Rua Augusta, 123", {
      agents,
      contextId: "ctx",
      continuation: first.continuation,
    });
    expect(second.results.map((r) => r.agent)).toEqual(["waze"]);
    expect(second.continuation).toBeUndefined();
    expect(second.clientActions).toEqual([
      {
        type: "open_url",
        url: "https://waze.com/ul?q=Rua%20Augusta%2C%20123&navigate=yes",
        label: "Navegar para casa",
      },
    ]);
  });
});
