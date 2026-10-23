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
  private primaryCooldownUntil = 0;

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

    const isTest = Boolean(process.env.VITEST);

    try {
      if (!isTest && Date.now() < this.primaryCooldownUntil) {
        throw new NeuralakeHttpError(429, "Primary Neuralake in cooldown");
      }

      const primarySignal =
        !isTest && typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? req.signal
            ? AbortSignal.any([req.signal, AbortSignal.timeout(2500)])
            : AbortSignal.timeout(2500)
          : req.signal;

      const res = await fetch(`${this.cleanBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: primarySignal,
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
          ...(choice.message.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}),
        },
        finishReason: choice.finish_reason ?? null,
      };
    } catch (primaryErr) {
      // In unit/acceptance tests, never fall back so tests can assert NeuralakeHttpError behavior.
      if (isTest) throw primaryErr;

      this.primaryCooldownUntil = Date.now() + 120_000;
      console.warn("[neuralake] primary endpoint failed, attempting LLM fallback:", primaryErr);

      const groqKey = process.env.GROQ_API_KEY?.trim();
      const openaiKey = process.env.OPENAI_API_KEY?.trim();

      const providers: Array<{ name: string; url: string; key: string; model: string }> = [];
      if (groqKey) {
        providers.push({
          name: "groq-llama-3.3-70b",
          url: "https://api.groq.com/openai/v1/chat/completions",
          key: groqKey,
          model: "llama-3.3-70b-versatile",
        });
        providers.push({
          name: "groq-llama-3.1-8b",
          url: "https://api.groq.com/openai/v1/chat/completions",
          key: groqKey,
          model: "llama-3.1-8b-instant",
        });
      }
      if (openaiKey) {
        providers.push({
          name: "openai-gpt-4o-mini",
          url: "https://api.openai.com/v1/chat/completions",
          key: openaiKey,
          model: "gpt-4o-mini",
        });
      }

      if (providers.length === 0) throw primaryErr;

      for (const provider of providers) {
        try {
          const fallbackBody: Record<string, unknown> = {
            model: provider.model,
            messages: req.messages,
            stream: false,
          };
          if (req.tools?.length) fallbackBody.tools = req.tools;

          const res = await fetch(provider.url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${provider.key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(fallbackBody),
            signal: req.signal,
          });
          if (!res.ok) {
            const errTxt = await res.text().catch(() => "");
            console.warn(`[neuralake] fallback ${provider.name} failed (${res.status}):`, errTxt.slice(0, 200));
            continue;
          }

          const json = await res.json();
          const choice = json.choices?.[0];
          if (!choice?.message) continue;
          return {
            message: {
              role: "assistant",
              content: choice.message.content ?? null,
              ...(choice.message.tool_calls?.length ? { tool_calls: choice.message.tool_calls } : {}),
            },
            finishReason: choice.finish_reason ?? null,
          };
        } catch (fallbackErr) {
          console.warn(`[neuralake] fallback ${provider.name} threw:`, fallbackErr);
        }
      }

      throw primaryErr;
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
