import { authorize } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const MAX_TEXT_LENGTH = 1200;
const MAX_BODY_BYTES = 64 * 1024; // 64 KB limit

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: { text?: unknown; voice?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { error: `Text is required and must be between 1 and ${MAX_TEXT_LENGTH} characters` },
      { status: 400 },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: "TTS is not configured on the server (OPENAI_API_KEY required)" },
      { status: 503 },
    );
  }

  const model = optionalEnv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts").trim();
  const voice = typeof body?.voice === "string" && body.voice.trim() ? body.voice.trim() : optionalEnv("OPENAI_TTS_VOICE", "coral").trim();

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: "mp3",
      }),
    });
  } catch (err) {
    console.error("[tts] upstream fetch failed", err);
    return Response.json({ error: "TTS upstream request failed" }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("[tts] upstream error", upstream.status, await upstream.text().catch(() => ""));
    return Response.json({ error: "TTS upstream error" }, { status: 502 });
  }

  const audioBytes = await upstream.arrayBuffer();
  return new Response(audioBytes, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
