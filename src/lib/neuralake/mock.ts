import type {
  AssistantMessage,
  CompletionRequest,
  CompletionResponse,
  NeuralakeClient,
} from "@/lib/contracts/neuralake";

/**
 * Decides the next assistant message given the request. Tests pass their own
 * script; the default script covers the happy path of each tool so the app
 * runs end-to-end with FINN_USE_MOCKS=1 and no Neuralake key.
 */
export type MockScript = (req: CompletionRequest) => AssistantMessage;

let seq = 0;

export function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_mock_${++seq}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

export function textMessage(content: string): AssistantMessage {
  return { role: "assistant", content };
}

/** Text after the last trigger word ("toca rock" → "rock", "me leva pra casa" → "casa"). */
function argumentAfter(transcript: string, trigger: RegExp): string {
  const parts = transcript.split(trigger);
  return (parts.length > 1 ? parts[parts.length - 1] : transcript).trim().replace(/[.!?]+$/, "");
}

/** Short reply to a tool result, mirroring what a real model would say. */
function replyTo(toolContent: string): string {
  const result = JSON.parse(toolContent || "null") ?? {};
  if (result.needs_address) {
    return `Qual é o endereço ${result.needs_address === "casa" ? "da sua casa" : "do seu trabalho"}?`;
  }
  if (result.needs_destination) return "Pra onde você quer ir?";
  if (result.found === false) return `Não achei essa playlist. Quer ${result.suggestions?.[0] ?? "outra"}?`;
  if (result.navigating_to) return "Rota definida.";
  if (result.playlist?.name) return `Tocando ${result.playlist.name}.`;
  return "Pronto.";
}

/**
 * Default script (FINN_USE_MOCKS=1): pick a tool with a naive argument taken
 * from the transcript; once a tool result is in the history, reply to it.
 * With a single-domain reading only — a real model is still needed to ignore
 * the other half of a double command.
 */
export const defaultMockScript: MockScript = (req) => {
  const last = req.messages[req.messages.length - 1];
  if (last?.role === "tool") return textMessage(replyTo(last.content));

  const transcript =
    [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const tools = new Set(req.tools?.map((t) => t.function.name));
  const text = transcript;

  if (tools.has("navigate_to")) {
    // Keep only the navigation half of "toca X e me leva pra Y".
    const nav = text.split(/\s+e\s+(?=me leva|vai|vamos|navega|leva)/i).find((p) => !/\btoca/i.test(p)) ?? text;
    return toolCallMessage("navigate_to", {
      destination: argumentAfter(nav, /\b(?:pra|para|pro|até|ate|ao)\s+/i),
    });
  }
  if (/\b(pausa|pausar|pause)\b/i.test(text)) return toolCallMessage("toggle_playback", { action: "pause" });
  if (/\b(pula|pular|próxima|proxima|skip)\b/i.test(text)) return toolCallMessage("toggle_playback", { action: "skip" });
  if (/\bquais\b.*\bplaylists?\b/i.test(text)) return toolCallMessage("list_playlists", {});
  if (tools.has("play_playlist")) {
    const music = text.split(/\s+e\s+(?=me leva|vai|vamos|navega|leva)/i)[0];
    return toolCallMessage("play_playlist", {
      playlist_name: argumentAfter(music, /\b(?:playlist|toca|tocar)\s+/i),
    });
  }
  return textMessage("Pronto.");
};

export class MockNeuralakeClient implements NeuralakeClient {
  readonly calls: CompletionRequest[] = [];

  constructor(private readonly script: MockScript = defaultMockScript) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    const message = this.script(req);
    return {
      message,
      finishReason: message.tool_calls?.length ? "tool_calls" : "stop",
    };
  }
}
