import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent } from "@/lib/contracts/a2a";
import { SPOTIFY_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";
import { UNREACHABLE_SPEECH } from "@/lib/spotify/auth";
import { spotifyAgentCard } from "./card";
import { SPOTIFY_SYSTEM_PROMPT } from "./prompt";
import { spotifyExecutors } from "./tools";

export const spotifyAgent: Agent = {
  id: "spotify",
  card: spotifyAgentCard,
  handle: (input) =>
    runToolLoop({
      agent: "spotify",
      client: getNeuralakeClient(),
      systemPrompt: SPOTIFY_SYSTEM_PROMPT,
      tools: SPOTIFY_TOOLS,
      executors: spotifyExecutors,
      input,
      fallbackErrorSpeech: UNREACHABLE_SPEECH,
    }),
};
