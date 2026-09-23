import type {
  AgentId,
  AgentResult,
  AgentTaskInput,
  ToolInvocation,
} from "@/lib/contracts/a2a";
import type { ClientAction } from "@/lib/contracts/client-events";
import type { ChatMessage, NeuralakeClient } from "@/lib/contracts/neuralake";
import type { ToolSchema } from "@/lib/contracts/tools";

/** What a tool executor returns to the runtime. */
export interface ToolOutput {
  /** Fed back to the model as the tool message content (JSON-serialized). */
  result: unknown;
  /** Side effects the PWA must perform (e.g. open the Waze deep link). */
  clientActions?: ClientAction[];
  /** Set by tools that need more info from the driver (e.g. unknown address). */
  inputRequired?: boolean;
  /** Agent-defined state to resume next turn; implies `inputRequired`. */
  continuation?: unknown;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  input: AgentTaskInput,
) => Promise<ToolOutput>;

/**
 * Thrown by executors for failures the driver should hear about (UC6).
 * `speech` must be short and non-technical; `cause` keeps the details for logs.
 */
export class UserFacingError extends Error {
  constructor(
    public readonly speech: string,
    options?: { cause?: unknown },
  ) {
    super(speech, options);
    this.name = "UserFacingError";
  }
}

export interface ToolLoopOptions {
  agent: AgentId;
  client: NeuralakeClient;
  systemPrompt: string;
  tools: ToolSchema[];
  executors: Record<string, ToolExecutor>;
  input: AgentTaskInput;
  /** Max model round-trips (UC5 needs list_playlists → play_playlist → reply = 3). */
  maxSteps?: number;
  /** Spoken when something unexpected fails. */
  fallbackErrorSpeech?: string;
}

/**
 * Standard tool-calling loop shared by all agents: ask Neuralake, execute any
 * tool calls, feed results back, stop when the model answers in plain text.
 * Never throws — failures become a `failed` AgentResult with a spoken message.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<AgentResult> {
  const {
    agent,
    client,
    systemPrompt,
    tools,
    executors,
    input,
    maxSteps = 4,
    fallbackErrorSpeech = "Não consegui fazer isso agora.",
  } = opts;
  const { signal } = input;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input.transcript },
  ];
  const toolCalls: ToolInvocation[] = [];
  const clientActions: ClientAction[] = [];
  let inputRequired = false;
  let continuation: unknown;

  // A failed turn must not act on the phone (the driver hears "couldn't do it").
  const result = (status: AgentResult["status"], speech: string): AgentResult => ({
    agent,
    status,
    speech: speech.trim(),
    clientActions: status === "failed" ? [] : clientActions,
    toolCalls,
    ...(status === "input-required" && continuation !== undefined ? { continuation } : {}),
  });

  try {
    for (let step = 0; step < maxSteps; step++) {
      const { message } = await client.complete({
        messages,
        tools,
        memoryScope: `finn-${agent}`,
        signal,
      });
      messages.push(message);

      if (!message.tool_calls?.length) {
        return result(inputRequired ? "input-required" : "completed", message.content ?? "");
      }

      for (const call of message.tool_calls) {
        const executor = executors[call.function.name];
        let args: Record<string, unknown> = {};
        let output: ToolOutput;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          if (!executor) throw new Error(`Unknown tool: ${call.function.name}`);
          output = await executor(args, input);
        } catch (err) {
          toolCalls.push({ name: call.function.name, arguments: args, result: String(err), ok: false });
          if (err instanceof UserFacingError) return result("failed", err.speech);
          throw err;
        }
        toolCalls.push({ name: call.function.name, arguments: args, result: output.result, ok: true });
        for (const action of output.clientActions ?? []) {
          if (!clientActions.some((a) => a.type === action.type && a.url === action.url)) {
            clientActions.push(action);
          }
        }
        // The latest tool output decides whether the turn still awaits the driver.
        inputRequired = Boolean(output.inputRequired) || output.continuation !== undefined;
        continuation = output.continuation;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(output.result),
        });
      }
    }
    return result("failed", fallbackErrorSpeech);
  } catch (err) {
    console.error(`[agent:${agent}] tool loop failed`, err);
    return result("failed", fallbackErrorSpeech);
  }
}
