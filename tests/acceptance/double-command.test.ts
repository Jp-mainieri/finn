/**
 * UC7 — double command: both agents run concurrently on the full transcript and
 * their results merge into one spoken reply, without an extra LLM call.
 */
import { describe, expect, it, vi } from "vitest";
import { expectFriendlySpeech, expectOrchestratorResponse, openUrls, resultOf, wazeUrl } from "../helpers/assertions";
import { useHarness } from "../helpers/harness";
import { say as turn } from "../helpers/http";
import { call, llm, say, userMessage } from "../helpers/llm";
import { NO_ACTIVE_DEVICE, playlistNamed } from "../helpers/spotify-fake";
import { at, timeline } from "../helpers/timeline";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

const TRANSCRIPT = "toca a playlist Rock Nacional e me leva pro aeroporto de Congonhas";
const DESTINATION = "Aeroporto de Congonhas";

function scriptBoth(opts: { spotifyDelayMs?: number; wazeDelayMs?: number } = {}) {
  llm.scripts.spotify = {
    delayMs: opts.spotifyDelayMs,
    turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando Rock Nacional.")],
  };
  llm.scripts.waze = {
    delayMs: opts.wazeDelayMs,
    turns: [call("navigate_to", { destination: DESTINATION }), say("Abrindo a rota pro Aeroporto de Congonhas.")],
  };
}

describe("[core] UC7 — fan-out through the route (model latency only)", () => {
  useHarness();

  it("both agents' model calls overlap in time", async () => {
    scriptBoth({ spotifyDelayMs: 100, wazeDelayMs: 100 }); // 2 round-trips each → 400ms if sequential
    const started = performance.now();
    const res = await turn(TRANSCRIPT);
    const elapsed = performance.now() - started;

    expect(res.results.map((r) => r.agent)).toEqual(["spotify", "waze"]);
    expect(at("llm:waze:start")).toBeLessThan(at("llm:spotify:end"));
    expect(elapsed).toBeLessThan(350);
  });
});

describe("[spotify+waze] UC7 — double command", () => {
  const h = useHarness({ spotify: true });

  it("runs both agents and merges their replies into one response", async () => {
    scriptBoth();
    const res = await turn(TRANSCRIPT);

    expectOrchestratorResponse(res);
    expect(res.results.map((r) => r.agent)).toEqual(["spotify", "waze"]);
    expect(resultOf(res, "spotify").status).toBe("completed");
    expect(resultOf(res, "waze").status).toBe("completed");

    expect(h.spotify.callsTo("play")).toHaveLength(1);
    expect(h.spotify.callsTo("play")[0].json).toMatchObject({
      context_uri: `spotify:playlist:${playlistNamed("Rock Nacional").id}`,
    });
    expect(openUrls(res)).toEqual([wazeUrl(DESTINATION)]);

    expect(res.speech).toContain("Rock Nacional");
    expect(res.speech).toContain("Congonhas");
    expect(res.speech.indexOf("Rock Nacional")).toBeLessThan(res.speech.indexOf("Congonhas"));
    expectFriendlySpeech(res.speech, { maxChars: 240 });
    expect(res.continuation).toBeUndefined();
  });

  it("sends the FULL transcript to each agent (each ignores the other domain itself)", async () => {
    scriptBoth();
    await turn(TRANSCRIPT);
    expect(userMessage(llm.callsFor("spotify")[0])).toContain(TRANSCRIPT);
    expect(userMessage(llm.callsFor("waze")[0])).toContain(TRANSCRIPT);
  });

  it("runs the agents concurrently, not one after the other", async () => {
    h.spotify.latency.play = 150; // slow Spotify player call
    scriptBoth({ wazeDelayMs: 75 }); // each waze model round-trip takes 75ms (2 round-trips)

    const started = performance.now();
    const res = await turn(TRANSCRIPT);
    const elapsed = performance.now() - started;

    expect(openUrls(res)).toEqual([wazeUrl(DESTINATION)]);
    expect(h.spotify.callsTo("play")).toHaveLength(1);

    // Waze's model is consulted while Spotify's play call is still in flight, and vice versa.
    const timelineDump = timeline.map((e) => `${Math.round(e.t - started)}ms ${e.event}`).join("\n");
    expect(at("llm:waze:start"), timelineDump).toBeLessThan(at("spotify:play:end", "last"));
    expect(at("llm:spotify:start"), timelineDump).toBeLessThan(at("llm:waze:end", "last"));
    // Sequential would take ≥ 150 + 2×75 = 300ms.
    expect(elapsed, timelineDump).toBeLessThan(280);
  });

  it("one agent failing (UC6) still delivers the other's action and a combined reply", async () => {
    h.spotify.enqueue("play", NO_ACTIVE_DEVICE);
    scriptBoth();
    const res = await turn(TRANSCRIPT);

    expect(resultOf(res, "spotify").status).toBe("failed");
    expect(resultOf(res, "waze").status).toBe("completed");
    expect(openUrls(res)).toEqual([wazeUrl(DESTINATION)]);
    expect(res.speech).toMatch(/spotify/i);
    expect(res.speech).toContain("Congonhas");
    expectFriendlySpeech(res.speech, { maxChars: 240 });
  });
});
