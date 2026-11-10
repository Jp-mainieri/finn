/**
 * Provedores de TTS da rota POST /api/realtime/tts (somente servidor).
 * `FINN_TTS_PROVIDER` = "openai" (padrao) ou "gemini"; qualquer outro valor = openai.
 * A chave do Gemini nunca e logada nem devolvida.
 */

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-lite-tts";
const DEFAULT_GEMINI_VOICE = "Kore";
/** Timeout total (cabecalhos + corpo). Amostra real: 4,6 s de audio levou ~3,8 s. */
export const GEMINI_TIMEOUT_MS = 8000;
/** Teto do audio decodificado (resposta da Vercel limitada a 4,5 MB). */
export const GEMINI_MAX_AUDIO_BYTES = 4_000_000;
/** Acima disso vai direto ao OpenAI: ~13 caracteres/s de audio, geracao quase em tempo real. */
export const GEMINI_MAX_TEXT_CHARS = 600;

export type TtsProvider = "openai" | "gemini";

export function resolveTtsProvider(): TtsProvider {
  return process.env.FINN_TTS_PROVIDER?.trim().toLowerCase() === "gemini" ? "gemini" : "openai";
}

export interface GeminiAudio {
  bytes: ArrayBuffer;
  contentType: string;
}

function findAudioData(json: unknown): string | null {
  const steps = (json as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    if (!step || typeof step !== "object" || (step as { type?: unknown }).type !== "model_output") continue;
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const it = item as { type?: unknown; data?: unknown };
      if (it?.type === "audio" && typeof it.data === "string" && it.data.length > 0) return it.data;
    }
  }
  return null;
}

/**
 * Sintetiza com o Gemini (requisicao unaria, WAV 24 kHz mono 16-bit).
 * Devolve null em qualquer falha (chave ausente, rede, nao-2xx, corpo sem audio);
 * o chamador cai para o OpenAI. So loga o status, nunca valores.
 */
export async function synthesizeWithGemini(text: string): Promise<GeminiAudio | null> {
  if (text.length > GEMINI_MAX_TEXT_CHARS) return null;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[tts] gemini skipped: not configured");
    return null;
  }
  const model = process.env.GEMINI_TTS_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const voice = process.env.GEMINI_TTS_VOICE?.trim() || DEFAULT_GEMINI_VOICE;

  try {
    const res = await fetch(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ type: "user_input", content: [{ type: "text", text }] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (!res.ok) {
      console.warn(`[tts] gemini failed: HTTP ${res.status}`);
      return null;
    }
    const data = findAudioData(await res.json());
    if (!data) {
      console.warn("[tts] gemini failed: no audio in response");
      return null;
    }
    // 4 chars base64 = 3 bytes; evita decodificar uma resposta absurda.
    if (data.length > Math.ceil(GEMINI_MAX_AUDIO_BYTES / 3) * 4 + 4) {
      console.warn("[tts] gemini failed: audio too large");
      return null;
    }
    const buf = Buffer.from(data, "base64");
    if (buf.byteLength > GEMINI_MAX_AUDIO_BYTES) {
      console.warn("[tts] gemini failed: audio too large");
      return null;
    }
    if (buf.byteLength < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") {
      console.warn("[tts] gemini failed: audio is not WAV");
      return null;
    }
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { bytes, contentType: "audio/wav" };
  } catch {
    console.warn("[tts] gemini failed: request error");
    return null;
  }
}
