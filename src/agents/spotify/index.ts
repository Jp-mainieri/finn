/**
 * PHASE 0 STUB — replaced by the feat/spotify-agent worktree.
 * Keeps the Agent contract so the orchestrator and routes work end-to-end.
 */
import { buildAgentCard } from "@/lib/a2a-server";
import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent } from "@/lib/contracts/a2a";
import { SPOTIFY_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";

export const spotifyAgent: Agent = {
  id: "spotify",

  card: (baseUrl) =>
    buildAgentCard({
      name: "spotify-agent",
      description: "(stub) Controla música no Spotify.",
      url: `${baseUrl}/api/agents/spotify`,
      skills: SPOTIFY_TOOLS.map((t) => ({
        id: t.function.name,
        name: t.function.name,
        description: t.function.description,
        tags: ["music", "spotify"],
      })),
    }),

  handle: (input) =>
    runToolLoop({
      agent: "spotify",
      client: getNeuralakeClient(),
      systemPrompt: "(stub) Você controla o Spotify. Ignore o que não for música.",
      tools: SPOTIFY_TOOLS,
      executors: {
        play_playlist: async (args) => ({ result: { stub: true, playing: args.playlist_name } }),
        toggle_playback: async (args) => ({ result: { stub: true, action: args.action } }),
        list_playlists: async () => ({ result: { stub: true, playlists: [] } }),
      },
      input,
    }),
};
