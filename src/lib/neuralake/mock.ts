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

/**
 * Default script: on the first turn, call the first tool offered with a naive
 * argument from the transcript; once a tool result is in the history, reply
 * with a short confirmation.
 */
export const defaultMockScript: MockScript = (req) => {
  const last = req.messages[req.messages.length - 1];
  if (last?.role === "tool") return textMessage("Pronto.");

  const transcript =
    [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const tool = req.tools?.[0]?.function.name;
  switch (tool) {
    case "play_playlist":
      return toolCallMessage("play_playlist", { playlist_name: transcript });
    case "navigate_to":
      return toolCallMessage("navigate_to", { destination: transcript });
    default:
      return textMessage("Pronto.");
  }
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
