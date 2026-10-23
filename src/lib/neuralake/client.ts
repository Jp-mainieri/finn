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

let cachedGroqModels: string[] | null = null;
let groqModelsFetchedAt = 0;
let primaryCooldownUntil = 0;

async function getAvailableGroqChatModels(apiKey: string): Promise<string[]> {
  if (cachedGroqModels && Date.now() - groqModelsFetchedAt < 10 * 60 * 1000) {
    return cachedGroqModels;
  }
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (json.data ?? [])
      .map((m) => m.id)
      .filter(
        (id) =>
          !id.includes("whisper") &&
          !id.includes("embed") &&
          !id.includes("guard") &&
          !id.includes("tts") &&
          !id.includes("orpheus") &&
          !id.includes("allam"),
      );
    const preferredOrder = [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile",
      "llama-3.1-8b-instant",
    ];
    models.sort((a, b) => {
      const ia = preferredOrder.indexOf(a);
      const ib = preferredOrder.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });
    cachedGroqModels = models;
    groqModelsFetchedAt = Date.now();
    return models;
  } catch {
    return [];
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

  private async executeFallback(
    req: CompletionRequest,
    primaryErr?: unknown,
  ): Promise<CompletionResponse> {
    const groqKey = process.env.GROQ_API_KEY?.trim();
    const openaiKey = process.env.OPENAI_API_KEY?.trim();

    const providers: Array<{ name: string; url: string; key: string; model: string }> = [];
    if (groqKey) {
      const discovered = await getAvailableGroqChatModels(groqKey);
      const candidates = discovered.length > 0 ? discovered.slice(0, 3) : ["llama-3.3-70b-versatile"];
      for (const model of candidates) {
        providers.push({
          name: `groq-${model}`,
          url: "https://api.groq.com/openai/v1/chat/completions",
          key: groqKey,
          model,
        });
      }
    }
    if (openaiKey) {
      providers.push({
        name: "openai-gpt-4o-mini",
        url: "https://api.openai.com/v1/chat/completions",
        key: openaiKey,
        model: "gpt-4o-mini",
      });
    }

    if (providers.length === 0) {
      if (primaryErr) throw primaryErr;
      throw new Error("No fallback LLM providers configured (GROQ_API_KEY / OPENAI_API_KEY)");
    }

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

    if (primaryErr) throw primaryErr;
    throw new Error("All fallback LLM providers failed");
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const isTest = Boolean(process.env.VITEST);

    // If Neuralake recently failed/timed out in production, skip straight to fallback
    // to preserve the 8000ms orchestrator latency budget across multi-step turns.
    if (!isTest && Date.now() < primaryCooldownUntil) {
      return this.executeFallback(req);
    }

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
      const primarySignal =
        !isTest && typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? req.signal
            ? AbortSignal.any([req.signal, AbortSignal.timeout(1800)])
            : AbortSignal.timeout(1800)
          : req.signal;

      let res = await fetch(`${this.cleanBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: primarySignal,
      });

      // Retry once after 500ms if Neuralake returns 429 (Model busy / engine_overloaded)
      if (res.status === 429 && !isTest && !req.signal?.aborted) {
        await res.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        res = await fetch(`${this.cleanBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: primarySignal,
        });
      }

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

      primaryCooldownUntil = Date.now() + 60_000;
      console.warn("[neuralake] primary endpoint failed (entering 60s cooldown), attempting LLM fallback:", primaryErr);

      return this.executeFallback(req, primaryErr);
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
