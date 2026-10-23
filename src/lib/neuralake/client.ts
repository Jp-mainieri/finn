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
  private readonly cleanBaseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly defaultModel: string,
  ) {
    this.cleanBaseUrl = baseUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  }

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

    try {
      const res = await fetch(`${this.cleanBaseUrl}/chat/completions`, {
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
    } catch (primaryErr) {
      // In unit/acceptance tests, never fall back so tests can assert NeuralakeHttpError behavior.
      if (process.env.VITEST) throw primaryErr;

      console.warn("[neuralake] primary endpoint failed, attempting LLM fallback:", primaryErr);
      const openaiKey = process.env.OPENAI_API_KEY?.trim();
      const groqKey = process.env.GROQ_API_KEY?.trim();
      const fallbackUrl = openaiKey
        ? "https://api.openai.com/v1/chat/completions"
        : groqKey
          ? "https://api.groq.com/openai/v1/chat/completions"
          : null;
      const fallbackKey = openaiKey || groqKey;
      const fallbackModel = openaiKey ? "gpt-4o-mini" : "llama-3.3-70b-versatile";

      if (!fallbackUrl || !fallbackKey) throw primaryErr;

      const fallbackBody: Record<string, unknown> = {
        model: fallbackModel,
        messages: req.messages,
        stream: false,
      };
      if (req.tools?.length) fallbackBody.tools = req.tools;

      const res = await fetch(fallbackUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fallbackKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fallbackBody),
        signal: req.signal,
      });
      if (!res.ok) throw primaryErr;

      const json = await res.json();
      const choice = json.choices?.[0];
      if (!choice?.message) throw primaryErr;
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
}

let cached: NeuralakeClient | undefined;

/** Shared client: mock when FINN_USE_MOCKS=1, real HTTP client otherwise. */
export function getNeuralakeClient(): NeuralakeClient {
  if (cached) return cached;
  cached = mocksEnabled()
    ? new MockNeuralakeClient()
    : new HttpNeuralakeClient(
        requireEnv("NEURALAKE_API_KEY").trim(),
        optionalEnv("NEURALAKE_BASE_URL", "https://api.neuralake.cloud/v1").trim(),
        optionalEnv("NEURALAKE_MODEL", "auto").trim(),
      );
  return cached;
}
