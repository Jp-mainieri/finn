import type { AgentTaskInput } from "@/lib/contracts/a2a";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_OWNER_ID } from "../../../tests/helpers/owner";
import type { Agent, AgentResult } from "@/lib/contracts/a2a";
import type { NeuralakeClient } from "@/lib/contracts/neuralake";
import { WAZE_TOOLS } from "@/lib/contracts/tools";
import { MockNeuralakeClient, textMessage, toolCallMessage, type MockScript } from "@/lib/neuralake/mock";
import { getAddressBook, resetAddressBook } from "@/lib/waze/address-book";
import { orchestrate } from "@/orchestrator/orchestrate";
import { wazeAgent, wazeFastSpeech } from "./index";

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
  wazeAgent.handle({ transcript, contextId: "ctx", continuation, driverId: TEST_OWNER_ID });

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
    expect(await getAddressBook(TEST_OWNER_ID).get("casa")).toBe("Rua Augusta, 123");

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

  it.each([
    [{ pendingLabel: "../../etc" }],
    [{ pendingLabel: { toString: "x" } }],
    [{ pendingLabel: ["casa"] }],
    [{ awaitingDestination: "true" }],
    [{ driverId: "drv_legacy_owner_000000000" }],
    [[{ pendingLabel: "casa" }]],
    ["casa"],
    [42],
    [null],
  ])("ignores a hostile continuation %j (no turn context, nothing saved)", async (hostile) => {
    const client = useModel(navigateScript("Shopping Iguatemi"));
    const res = await handle("me leva pro Shopping Iguatemi", hostile);
    expect(client.calls[0].messages[0].content).not.toContain("Contexto deste turno");
    expect(res.toolCalls[0].result).toEqual({ navigating_to: "Shopping Iguatemi" });
    expect(await getAddressBook(TEST_OWNER_ID).get("casa")).toBeUndefined();
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
    const first = await orchestrate("toca minha playlist e me leva pra casa", { agents, contextId: "ctx", driverId: TEST_OWNER_ID });
    expect(first.speech).toBe("Tocando sua playlist. Qual é o endereço da sua casa?");
    expect(first.clientActions).toEqual([]);
    expect(first.continuation).toEqual({ agent: "waze", state: { pendingLabel: "casa" } });

    useModel(navigateScript("Rua Augusta, 123"));
    const second = await orchestrate("Rua Augusta, 123", {
      agents,
      contextId: "ctx",
      driverId: TEST_OWNER_ID,
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

  it("ignores driverContext.savedAddresses sent by the client", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", JSON.stringify({ casa: "Env Casa" }));
    resetAddressBook();
    useModel(navigateScript("casa"));
    const res = await wazeAgent.handle({
      transcript: "me leva pra casa",
      contextId: "ctx",
      driverId: TEST_OWNER_ID,
      driverContext: { savedAddresses: { casa: "Custom Driver Casa" } },
    } as AgentTaskInput);
    expect(res.status).toBe("completed");
    expect(res.clientActions).toEqual([
      {
        type: "open_url",
        url: "https://waze.com/ul?q=Env%20Casa&navigate=yes",
        label: "Navegar para casa",
      },
    ]);
  });

  it("a non-owner never reads the owner's seed nor writes into the owner's book", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", JSON.stringify({ casa: "Casa do Dono" }));
    resetAddressBook();
    const OTHER = "drv_" + "B".repeat(22);
    useModel(navigateScript("casa"));
    const asked = await wazeAgent.handle({ transcript: "me leva pra casa", contextId: "ctx", driverId: OTHER });
    expect(asked).toMatchObject({ status: "input-required", continuation: { pendingLabel: "casa" }, clientActions: [] });

    useModel(navigateScript("Rua do Outro, 9"));
    await wazeAgent.handle({ transcript: "Rua do Outro, 9", contextId: "ctx", driverId: OTHER, continuation: asked.continuation });
    expect(await getAddressBook(TEST_OWNER_ID).get("casa")).toBe("Casa do Dono");
  });

  describe("Redis down", () => {
    afterEach(() => vi.unstubAllGlobals());

    function redisDown() {
      vi.stubEnv("KV_REST_API_URL", "https://fake.upstash.example");
      vi.stubEnv("KV_REST_API_TOKEN", "fake-token");
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "ERR secret-detail" }), { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("speaks a short failure, never falls back to the owner's seed, logs nothing", async () => {
      vi.stubEnv("WAZE_SAVED_ADDRESSES", JSON.stringify({ casa: "Casa do Dono" }));
      const fetchMock = redisDown();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      useModel(navigateScript("casa"));
      for (const driverId of [TEST_OWNER_ID, "drv_" + "B".repeat(22)]) {
        const res = await wazeAgent.handle({ transcript: "me leva pra casa", contextId: "ctx", driverId });
        expect(res).toMatchObject({ status: "failed", speech: "Não consegui acessar seus endereços agora.", clientActions: [] });
        expect(JSON.stringify(res)).not.toMatch(/Casa do Dono|secret-detail/);
      }
      expect(fetchMock).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("saving also fails short when Redis is down", async () => {
      redisDown();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      useModel(navigateScript("Rua Augusta, 123"));
      const res = await wazeAgent.handle({
        transcript: "Rua Augusta, 123",
        contextId: "ctx",
        driverId: "drv_" + "B".repeat(22),
        continuation: { pendingLabel: "casa" },
      });
      expect(res).toMatchObject({ status: "failed", speech: "Não consegui acessar seus endereços agora.", clientActions: [] });
      expect(err).not.toHaveBeenCalled();
    });

    it("an explicit destination still navigates when Redis is down or production has no KV variables (book is lazy)", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchMock = redisDown();
      useModel(navigateScript("Avenida Paulista, 1000"));
      const down = await handle("me leva pra Avenida Paulista, 1000");
      expect(down.status).toBe("completed");
      expect(down.clientActions).toHaveLength(1);
      vi.unstubAllGlobals();
      const unused = vi.fn();
      vi.stubGlobal("fetch", unused);
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("KV_REST_API_URL", "");
      vi.stubEnv("KV_REST_API_TOKEN", "");
      useModel(navigateScript("Avenida Paulista, 1000"));
      const prod = await handle("me leva pra Avenida Paulista, 1000");
      expect(prod.status).toBe("completed");
      expect(prod.clientActions).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled(); // not even touched
      expect(unused).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    });

    it("production without Redis variables is a short failure too (fail closed, no memory)", async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("KV_REST_API_URL", "");
      vi.stubEnv("KV_REST_API_TOKEN", "");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      useModel(navigateScript("casa"));
      const res = await wazeAgent.handle({ transcript: "me leva pra casa", contextId: "ctx", driverId: TEST_OWNER_ID });
      expect(res).toMatchObject({ status: "failed", speech: "Não consegui acessar seus endereços agora." });
      expect(err).not.toHaveBeenCalled();
    });
  });

  it("never emits save_address, even when an old client's driverContext is smuggled in", async () => {
    useModel(navigateScript("Rua Oscar Freire, 100"));
    const res = await wazeAgent.handle({
      transcript: "Rua Oscar Freire, 100",
      contextId: "ctx",
      continuation: { pendingLabel: "casa" },
      driverId: TEST_OWNER_ID,
      driverContext: {},
    } as AgentTaskInput);
    expect(res.status).toBe("completed");
    expect(res.clientActions).toEqual([
      {
        type: "open_url",
        url: "https://waze.com/ul?q=Rua%20Oscar%20Freire%2C%20100&navigate=yes",
        label: "Navegar para casa",
      },
    ]);
    expect(JSON.stringify(res)).not.toContain("save_address");
  });

  it("exposes keywords and failureSpeech", () => {
    expect(wazeAgent.keywords).toBeDefined();
    expect(wazeAgent.failureSpeech).toBe("Não consegui abrir a navegação agora.");
  });

  it("synthesizes deterministic fastSpeech confirmation", () => {
    expect(wazeFastSpeech("navigate_to", { navigating_to: "casa" })).toBe(
      "Abrindo a rota para casa.",
    );
    expect(wazeFastSpeech("navigate_to", { needs_address: "casa" })).toBeNull();
    expect(wazeFastSpeech("other_tool", {})).toBeNull();
  });
});
