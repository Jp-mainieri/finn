/**
 * Tool schemas (OpenAI format) sent in the `tools` param of Neuralake calls.
 * Source of truth: "Finn — Especificação Técnica (MVP)", section "Tools".
 */

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const PLAY_PLAYLIST_TOOL = {
  type: "function",
  function: {
    name: "play_playlist",
    description: "Toca uma playlist específica no Spotify pelo nome exato",
    parameters: {
      type: "object",
      properties: { playlist_name: { type: "string" } },
      required: ["playlist_name"],
    },
  },
} as const satisfies ToolSchema;

export const TOGGLE_PLAYBACK_TOOL = {
  type: "function",
  function: {
    name: "toggle_playback",
    description: "Pausa, retoma ou pula a reprodução atual no Spotify",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play", "pause", "skip"] },
      },
      required: ["action"],
    },
  },
} as const satisfies ToolSchema;

export const LIST_PLAYLISTS_TOOL = {
  type: "function",
  function: {
    name: "list_playlists",
    description:
      "Lista as playlists do usuário no Spotify, com nome e ID. Use antes de play_playlist quando o nome dito pelo usuário não bate exatamente com nenhuma playlist conhecida",
    parameters: { type: "object", properties: {} },
  },
} as const satisfies ToolSchema;

export const NAVIGATE_TO_TOOL = {
  type: "function",
  function: {
    name: "navigate_to",
    description:
      "Abre navegação no Waze da localização atual até o destino falado",
    parameters: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
    },
  },
} as const satisfies ToolSchema;

export const SPOTIFY_TOOLS: ToolSchema[] = [
  PLAY_PLAYLIST_TOOL,
  TOGGLE_PLAYBACK_TOOL,
  LIST_PLAYLISTS_TOOL,
];

export const WAZE_TOOLS: ToolSchema[] = [NAVIGATE_TO_TOOL];

/** Parsed argument types for each tool. */
export interface ToolArgs {
  play_playlist: { playlist_name: string };
  toggle_playback: { action: "play" | "pause" | "skip" };
  list_playlists: Record<string, never>;
  navigate_to: { destination: string };
}

export type ToolName = keyof ToolArgs;
