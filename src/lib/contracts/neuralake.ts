/**
 * Neuralake client contract. The API is OpenAI-compatible
 * (POST https://api.neuralake.cloud/v1/chat/completions, Bearer auth).
 *
 * UNCONFIRMED (not in public docs as of 2026-09-23):
 *  - whether `tools` / `tool_calls` are passed through exactly like OpenAI
 *  - how per-agent memory / Cross Memory is scoped (field? header?)
 * `memoryScope` is our abstraction for that; the real client maps it once the
 * mechanism is confirmed. Agents must not depend on how it's mapped.
 */

import type { ToolSchema } from "./tools";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** Neuralake capability endpoint; defaults to NEURALAKE_MODEL or "auto". */
  model?: string;
  /** Agent that owns this call, used to scope Neuralake agent memory. */
  memoryScope?: string;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  message: AssistantMessage;
  finishReason: string | null;
}

export interface NeuralakeClient {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
