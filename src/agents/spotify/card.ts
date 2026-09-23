import { buildAgentCard } from "@/lib/a2a-server";
import type { AgentCard } from "@/lib/contracts/a2a";
import {
  LIST_PLAYLISTS_TOOL,
  PLAY_PLAYLIST_TOOL,
  TOGGLE_PLAYBACK_TOOL,
} from "@/lib/contracts/tools";

export function spotifyAgentCard(baseUrl: string): AgentCard {
  return buildAgentCard({
    name: "spotify-agent",
    description:
      "Controla o Spotify do motorista por voz: toca playlists pelo nome (mesmo com nome aproximado), pausa, retoma, pula faixas e diz quais playlists ele tem. Ignora pedidos que não sejam sobre música.",
    url: `${baseUrl}/api/agents/spotify`,
    skills: [
      {
        id: PLAY_PLAYLIST_TOOL.function.name,
        name: "Tocar playlist",
        description:
          "Toca uma playlist do usuário no dispositivo Spotify ativo. Aceita o nome falado de forma aproximada e resolve para a playlist real; se não houver correspondência confiável, devolve sugestões.",
        tags: ["music", "spotify", "playlist", "play"],
        examples: [
          "Toca minha playlist de rock",
          "Coloca a Músicas pra Viajar",
          "Toca aquela de treino e me leva pra academia",
        ],
      },
      {
        id: TOGGLE_PLAYBACK_TOOL.function.name,
        name: "Pausar, retomar ou pular",
        description: "Pausa, retoma ou pula para a próxima faixa na reprodução atual do Spotify.",
        tags: ["music", "spotify", "playback", "pause", "skip"],
        examples: ["Pausa a música", "Volta a tocar", "Pula essa"],
      },
      {
        id: LIST_PLAYLISTS_TOOL.function.name,
        name: "Listar playlists",
        description:
          "Lista as playlists do usuário no Spotify (próprias e seguidas) e responde com alguns nomes em voz alta.",
        tags: ["music", "spotify", "playlist", "library"],
        examples: ["Quais playlists eu tenho?", "Que playlists tem no meu Spotify?"],
      },
    ],
  });
}
