import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, AgentResult } from "@/lib/contracts/a2a";
import { orchestrate } from "./orchestrate";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeAgent(id: AgentId, delayMs: number, result: Partial<AgentResult> = {}): Agent {
  return {
    id,
    card: () => {
      throw new Error("not used");
    },
    handle: vi.fn(async (): Promise<AgentResult> => {
      await sleep(delayMs);
      return { agent: id, status: "completed", speech: "", clientActions: [], toolCalls: [], ...result };
    }),
  };
}

describe("orchestrate", () => {
  it("fans out a double command (UC7) in parallel and merges results", async () => {
    const agents = {
      spotify: fakeAgent("spotify", 100, { speech: "Tocando Rock Nacional" }),
      waze: fakeAgent("waze", 100, {
        speech: "Abrindo a rota pra casa.",
        clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=casa&navigate=yes" }],
      }),
    };
    const transcript = "toca minha playlist e me leva pra casa";

    const started = Date.now();
    const res = await orchestrate(transcript, { agents, contextId: "ctx" });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(180); // parallel, not 200ms sequential
    expect(agents.spotify.handle).toHaveBeenCalledWith(
      expect.objectContaining({ transcript, contextId: "ctx" }),
    );
    expect(agents.waze.handle).toHaveBeenCalledWith(expect.objectContaining({ transcript }));
    expect(res.speech).toBe("Tocando Rock Nacional. Abrindo a rota pra casa.");
    expect(res.clientActions).toHaveLength(1);
    expect(res.results.map((r) => r.agent)).toEqual(["spotify", "waze"]);
  });

  it("only calls the matched agent", async () => {
    const agents = { spotify: fakeAgent("spotify", 0, { speech: "Pausado." }), waze: fakeAgent("waze", 0) };
    const res = await orchestrate("pausa", { agents, contextId: "ctx" });
    expect(agents.waze.handle).not.toHaveBeenCalled();
    expect(res.speech).toBe("Pausado.");
  });

  it("keeps the other agent's result when one times out", async () => {
    const agents = {
      spotify: fakeAgent("spotify", 500, { speech: "tarde demais" }),
      waze: fakeAgent("waze", 0, { speech: "Indo pra casa." }),
    };
    const res = await orchestrate("toca algo e me leva pra casa", { agents, contextId: "ctx", timeoutMs: 50 });
    expect(res.results[0]).toMatchObject({ agent: "spotify", status: "failed" });
    expect(res.speech).toBe("Não consegui mexer na música agora. Indo pra casa.");
  });

  it("routes a keyword-less follow-up to the agent that asked for it", async () => {
    const agents = {
      spotify: fakeAgent("spotify", 0),
      waze: fakeAgent("waze", 0, { speech: "Salvei sua casa. Indo pra lá." }),
    };
    const res = await orchestrate("Rua Augusta, 123", {
      agents,
      contextId: "ctx",
      continuation: { agent: "waze", state: { pendingLabel: "casa" } },
    });
    expect(agents.spotify.handle).not.toHaveBeenCalled();
    expect(agents.waze.handle).toHaveBeenCalledWith(
      expect.objectContaining({ continuation: { pendingLabel: "casa" } }),
    );
    expect(res.speech).toBe("Salvei sua casa. Indo pra lá.");
  });

  it("drops a pending continuation when the driver changes topic", async () => {
    const agents = { spotify: fakeAgent("spotify", 0, { speech: "Tocando rock." }), waze: fakeAgent("waze", 0) };
    const res = await orchestrate("toca rock", {
      agents,
      contextId: "ctx",
      continuation: { agent: "waze", state: { pendingLabel: "casa" } },
    });
    expect(agents.waze.handle).not.toHaveBeenCalled();
    expect(res.continuation).toBeUndefined();
    expect(res.speech).toBe("Tocando rock.");
  });

  it("surfaces an agent's continuation when it needs input", async () => {
    const agents = {
      spotify: fakeAgent("spotify", 0),
      waze: fakeAgent("waze", 0, {
        status: "input-required",
        speech: "Qual o endereço da sua casa?",
        continuation: { pendingLabel: "casa" },
      }),
    };
    const res = await orchestrate("me leva pra casa", { agents, contextId: "ctx" });
    expect(res.continuation).toEqual({ agent: "waze", state: { pendingLabel: "casa" } });
  });

  it("asks what to do when nothing matches", async () => {
    const agents = { spotify: fakeAgent("spotify", 0), waze: fakeAgent("waze", 0) };
    const res = await orchestrate("que horas são?", { agents, contextId: "ctx" });
    expect(res.results).toEqual([]);
    expect(res.speech).toMatch(/música|lugar/);
  });

  it("uses custom failureSpeech when agent defines it", async () => {
    const customAgent = {
      ...fakeAgent("spotify", 500),
      failureSpeech: "Custom Spotify failure speech.",
    };
    const agents = { spotify: customAgent, waze: fakeAgent("waze", 0) };
    const res = await orchestrate("toca rock", { agents, contextId: "ctx", timeoutMs: 50 });
    expect(res.results[0]).toMatchObject({
      agent: "spotify",
      status: "failed",
      speech: "Custom Spotify failure speech.",
    });
  });

  it("passes driverContext to agent.handle", async () => {
    const agents = {
      spotify: fakeAgent("spotify", 0),
      waze: fakeAgent("waze", 0, { speech: "Indo." }),
    };
    const driverContext = { spotifyRefreshToken: "driver-token" };
    await orchestrate("toca rock", { agents, contextId: "ctx", driverContext });
    expect(agents.spotify.handle).toHaveBeenCalledWith(
      expect.objectContaining({ driverContext }),
    );
  });
});
