import { describe, expect, it } from "vitest";
import { MockNeuralakeClient, textMessage, toolCallMessage } from "@/lib/neuralake/mock";
import { runToolLoop, UserFacingError } from "./agent-runtime";
import { SPOTIFY_TOOLS } from "./contracts/tools";

const input = { transcript: "toca rock", contextId: "ctx" };

describe("runToolLoop", () => {
  it("executes tool calls and returns the model's final text", async () => {
    const client = new MockNeuralakeClient((req) =>
      req.messages.at(-1)?.role === "tool"
        ? textMessage("Tocando Rock.")
        : toolCallMessage("play_playlist", { playlist_name: "Rock" }),
    );
    const res = await runToolLoop({
      agent: "spotify",
      client,
      systemPrompt: "sys",
      tools: SPOTIFY_TOOLS,
      executors: { play_playlist: async (args) => ({ result: { playing: args.playlist_name } }) },
      input,
    });
    expect(res).toMatchObject({ status: "completed", speech: "Tocando Rock." });
    expect(res.toolCalls).toEqual([
      { name: "play_playlist", arguments: { playlist_name: "Rock" }, result: { playing: "Rock" }, ok: true },
    ]);
    expect(client.calls[0].memoryScope).toBe("finn-spotify");
  });

  it("turns a UserFacingError into a spoken failure (UC6)", async () => {
    const client = new MockNeuralakeClient(() => toolCallMessage("toggle_playback", { action: "pause" }));
    const res = await runToolLoop({
      agent: "spotify",
      client,
      systemPrompt: "sys",
      tools: SPOTIFY_TOOLS,
      executors: {
        toggle_playback: async () => {
          throw new UserFacingError("Perdi a conexão com o Spotify.");
        },
      },
      input,
    });
    expect(res).toMatchObject({ status: "failed", speech: "Perdi a conexão com o Spotify." });
  });

  it("lets the latest tool output decide input-required, and dedupes client actions", async () => {
    let step = 0;
    const client = new MockNeuralakeClient(() =>
      ++step <= 2 ? toolCallMessage("navigate_to", { destination: "x" }) : textMessage("Indo."),
    );
    const outputs = [
      { result: { needs_address: "casa" }, continuation: { pendingLabel: "casa" } },
      { result: {}, clientActions: [{ type: "open_url" as const, url: "u" }, { type: "open_url" as const, url: "u" }] },
    ];
    const res = await runToolLoop({
      agent: "waze",
      client,
      systemPrompt: "sys",
      tools: [],
      executors: { navigate_to: async () => outputs.shift()! },
      input,
    });
    expect(res.status).toBe("completed");
    expect(res.continuation).toBeUndefined();
    expect(res.clientActions).toHaveLength(1);
  });

  it("never throws when the client fails", async () => {
    const client = { complete: async () => Promise.reject(new Error("boom")) };
    const res = await runToolLoop({
      agent: "spotify",
      client,
      systemPrompt: "sys",
      tools: SPOTIFY_TOOLS,
      executors: {},
      input,
      fallbackErrorSpeech: "Falhou.",
    });
    expect(res).toMatchObject({ status: "failed", speech: "Falhou." });
  });

  describe("fastSpeech optimization", () => {
    it("skips 2nd LLM call when FINN_FAST_SPEECH=1 and fastSpeech returns speech", async () => {
      process.env.FINN_FAST_SPEECH = "1";
      try {
        let callsCount = 0;
        const client = new MockNeuralakeClient(() => {
          callsCount++;
          return toolCallMessage("play_playlist", { playlist_name: "Rock" });
        });
        const res = await runToolLoop({
          agent: "spotify",
          client,
          systemPrompt: "sys",
          tools: SPOTIFY_TOOLS,
          executors: {
            play_playlist: async () => ({
              result: { found: true, playlist: { name: "Rock" } },
            }),
          },
          fastSpeech: (tool, result) => {
            if (tool === "play_playlist") {
              return `Tocando ${(result as { playlist: { name: string } }).playlist.name}.`;
            }
            return null;
          },
          input,
        });
        expect(res).toMatchObject({ status: "completed", speech: "Tocando Rock." });
        expect(callsCount).toBe(1); // 1 LLM round-trip instead of 2!
      } finally {
        delete process.env.FINN_FAST_SPEECH;
      }
    });

    it("falls through to 2nd LLM call when fastSpeech returns null", async () => {
      process.env.FINN_FAST_SPEECH = "1";
      try {
        let callsCount = 0;
        const client = new MockNeuralakeClient((req) => {
          callsCount++;
          return req.messages.at(-1)?.role === "tool"
            ? textMessage("Fallback confirmation.")
            : toolCallMessage("list_playlists", {});
        });
        const res = await runToolLoop({
          agent: "spotify",
          client,
          systemPrompt: "sys",
          tools: SPOTIFY_TOOLS,
          executors: {
            list_playlists: async () => ({ result: { playlists: [] } }),
          },
          fastSpeech: () => null,
          input,
        });
        expect(res).toMatchObject({ status: "completed", speech: "Fallback confirmation." });
        expect(callsCount).toBe(2);
      } finally {
        delete process.env.FINN_FAST_SPEECH;
      }
    });

    it("does not fast-speech when inputRequired is true", async () => {
      process.env.FINN_FAST_SPEECH = "1";
      try {
        let callsCount = 0;
        const client = new MockNeuralakeClient((req) => {
          callsCount++;
          return req.messages.at(-1)?.role === "tool"
            ? textMessage("Qual endereço?")
            : toolCallMessage("navigate_to", { destination: "casa" });
        });
        const res = await runToolLoop({
          agent: "waze",
          client,
          systemPrompt: "sys",
          tools: [],
          executors: {
            navigate_to: async () => ({
              result: { needs_address: "casa" },
              continuation: { pendingLabel: "casa" },
            }),
          },
          fastSpeech: () => "Fast speech should not be used",
          input,
        });
        expect(res.status).toBe("input-required");
        expect(res.speech).toBe("Qual endereço?");
        expect(callsCount).toBe(2);
      } finally {
        delete process.env.FINN_FAST_SPEECH;
      }
    });

    it("does not fast-speech when FINN_FAST_SPEECH is not 1", async () => {
      delete process.env.FINN_FAST_SPEECH;
      let callsCount = 0;
      const client = new MockNeuralakeClient((req) => {
        callsCount++;
        return req.messages.at(-1)?.role === "tool"
          ? textMessage("Spoken by model.")
          : toolCallMessage("play_playlist", { playlist_name: "Rock" });
      });
      const res = await runToolLoop({
        agent: "spotify",
        client,
        systemPrompt: "sys",
        tools: SPOTIFY_TOOLS,
        executors: {
          play_playlist: async () => ({ result: { found: true } }),
        },
        fastSpeech: () => "Fast speech",
        input,
      });
      expect(res.speech).toBe("Spoken by model.");
      expect(callsCount).toBe(2);
    });
  });
});
