import type {
  CompletionRequest,
  CompletionResponse,
  NeuralakeClient,
} from "@/lib/contracts/neuralake";
import { optionalEnv, requireEnv, mocksEnabled } from "@/lib/env";
import { MockNeuralakeClient } from "./mock";

export class NeuralakeHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Neuralake request failed (${status}): ${body.slice(0, 300)}`);
    this.name = "NeuralakeHttpError";
  }
}

export class HttpNeuralakeClient implements NeuralakeClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly defaultModel: string,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.defaultModel,
      messages: req.messages,
      stream: false,
    };
    if (req.tools?.length) body.tools = req.tools;
    // TODO(neuralake-memory): map req.memoryScope to Neuralake's per-agent
    // memory mechanism once confirmed in the Neuralake dashboard. Until then
    // it is intentionally not sent.

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new NeuralakeHttpError(res.status, await res.text());

    const json = await res.json();
    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new NeuralakeHttpError(res.status, "response has no choices[0].message");
    }
    return {
      message: {
        role: "assistant",
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      },
      finishReason: choice.finish_reason ?? null,
    };
  }
}

let cached: NeuralakeClient | undefined;

/** Shared client: mock when FINN_USE_MOCKS=1, real HTTP client otherwise. */
export function getNeuralakeClient(): NeuralakeClient {
  if (cached) return cached;
  cached = mocksEnabled()
    ? new MockNeuralakeClient()
    : new HttpNeuralakeClient(
        requireEnv("NEURALAKE_API_KEY"),
        optionalEnv("NEURALAKE_BASE_URL", "https://api.neuralake.cloud/v1"),
        optionalEnv("NEURALAKE_MODEL", "auto"),
      );
  return cached;
}
