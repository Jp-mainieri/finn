import { runToolLoop, UserFacingError } from "@/lib/agent-runtime";
import type { Agent, AgentResult, AgentTaskInput } from "@/lib/contracts/a2a";
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

export async function spotifyDeterministicFallback(input: AgentTaskInput): Promise<AgentResult | null> {
  const raw = input.transcript.trim().replace(/[.!?]+$/, "");
  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  try {
    // 1. Pause
    if (/\b(pausa|pausar|pause|para o som|para a musica|parar a musica|parar o som)\b/.test(norm)) {
      const out = await spotifyExecutors.toggle_playback({ action: "pause" }, input);
      return {
        agent: "spotify",
        status: "completed",
        speech: "Música pausada.",
        clientActions: [],
        toolCalls: [{ name: "toggle_playback", arguments: { action: "pause" }, result: out.result, ok: true }],
      };
    }

    // 2. Skip / Next
    if (/\b(proxima|proximo|pula|pular|skip|avanca|avancar|passa a musica)\b/.test(norm)) {
      const out = await spotifyExecutors.toggle_playback({ action: "skip" }, input);
      return {
        agent: "spotify",
        status: "completed",
        speech: "Próxima música.",
        clientActions: [],
        toolCalls: [{ name: "toggle_playback", arguments: { action: "skip" }, result: out.result, ok: true }],
      };
    }

    // 3. Resume / Play current
    if (
      /\b(continua|continuar|despausa|despausar|retoma|retomar|volta a tocar)\b/.test(norm) ||
      /^(toca|tocar|play|toca musica|toca uma musica|toca no spotify)$/.test(norm)
    ) {
      const out = await spotifyExecutors.toggle_playback({ action: "play" }, input);
      return {
        agent: "spotify",
        status: "completed",
        speech: "Continuando a música.",
        clientActions: [],
        toolCalls: [{ name: "toggle_playback", arguments: { action: "play" }, result: out.result, ok: true }],
      };
    }

    // 4. List playlists
    if (/\b(quais|lista|listar|mostra|ver|minhas)\b.*\bplaylists?\b/.test(norm)) {
      const out = await spotifyExecutors.list_playlists({}, input);
      const res = out.result as { playlists?: Array<{ name: string }> };
      const names = res.playlists?.map((p) => p.name).slice(0, 5) ?? [];
      const speech = names.length
        ? `Suas playlists são: ${names.join(", ")}.`
        : "Não encontrei playlists na sua conta do Spotify.";
      return {
        agent: "spotify",
        status: "completed",
        speech,
        clientActions: [],
        toolCalls: [{ name: "list_playlists", arguments: {}, result: out.result, ok: true }],
      };
    }

    // 5. Play a specific playlist or genre
    const playMatch = raw.match(
      /(?:toca|tocar|toque|tocando|play|ouvir|ouve|coloque|coloca)\s+(?:a\s+playlist|uma\s+playlist\s+de|playlist\s+de|playlist|a\s+m[uú]sica|uma\s+m[uú]sica\s+de|m[uú]sica\s+de|m[uú]sicas?\s+de|o\s+som|som\s+de)?\s*(.+)/i,
    );
    const candidate = (playMatch?.[1] ?? raw).replace(/\s+no\s+spotify$/i, "").trim();
    if (candidate) {
      const out = await spotifyExecutors.play_playlist({ playlist_name: candidate }, input);
      const res = out.result as {
        found?: boolean;
        playlist?: { id?: string; name?: string };
        suggestions?: string[];
      };
      if (res.found && res.playlist?.name) {
        return {
          agent: "spotify",
          status: "completed",
          speech: `Tocando ${res.playlist.name}.`,
          clientActions: [],
          toolCalls: [
            { name: "play_playlist", arguments: { playlist_name: candidate }, result: out.result, ok: true },
          ],
        };
      }
      const suggestions = res.suggestions?.slice(0, 3) ?? [];
      const speech = suggestions.length
        ? `Não achei a playlist ${candidate}. Você tem: ${suggestions.join(", ")}.`
        : `Não achei a playlist ${candidate} no seu Spotify.`;
      return {
        agent: "spotify",
        status: "completed",
        speech,
        clientActions: [],
        toolCalls: [
          { name: "play_playlist", arguments: { playlist_name: candidate }, result: out.result, ok: true },
        ],
      };
    }
  } catch (err) {
    if (err instanceof UserFacingError) {
      return {
        agent: "spotify",
        status: "failed",
        speech: err.speech,
        clientActions: [],
        toolCalls: [],
      };
    }
    throw err;
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
      deterministicFallback: spotifyDeterministicFallback,
    }),
};
