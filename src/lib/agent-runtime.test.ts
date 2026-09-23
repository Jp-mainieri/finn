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
});
