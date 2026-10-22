import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent } from "@/lib/contracts/a2a";
import { SPOTIFY_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";
import { UNREACHABLE_SPEECH } from "@/lib/spotify/auth";
import { spotifyAgentCard } from "./card";
import { SPOTIFY_SYSTEM_PROMPT } from "./prompt";
import { spotifyExecutors } from "./tools";

export const SPOTIFY_KEYWORDS: readonly RegExp[] = [
  /\b(toca|tocar|toque|tocando|play)\b/,
  /\bplaylists?\b/,
  /\b(musica|musicas|cancao|spotify|ouvir|ouve)\b/,
  /\b(pausa|pausar|pause|despausa|retoma|retomar)\b/,
  /\b(pula|pular|skip|proxima|avanca)\b/,
  /\bpara (a|o|essa|esse) (musica|som)\b/,
];

export function spotifyFastSpeech(toolName: string, result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const res = result as Record<string, unknown>;
  if (toolName === "play_playlist") {
    if (res.found && typeof res.playlist === "object" && res.playlist !== null) {
      const playlist = res.playlist as { name?: string };
      if (playlist.name) {
        return `Tocando ${playlist.name}.`;
      }
    }
  }
  if (toolName === "toggle_playback") {
    if (res.ok) {
      if (res.action === "pause") return "Música pausada.";
      if (res.action === "play") return "Continuando a música.";
      if (res.action === "skip") return "Próxima música.";
    }
  }
  return null;
}

export const spotifyAgent: Agent = {
  id: "spotify",
  keywords: SPOTIFY_KEYWORDS,
  failureSpeech: "Não consegui mexer na música agora.",
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
      fastSpeech: spotifyFastSpeech,
    }),
};
