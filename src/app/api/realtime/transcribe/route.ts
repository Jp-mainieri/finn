import { authorize } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const STT_PROMPT = "Finn, Spotify, Waze, toca a playlist, pausa, próxima, me leva pra casa, trabalho.";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB limit for voice commands

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_AUDIO_BYTES * 1.5) {
    return Response.json(
      { error: "Audio payload exceeds maximum allowed size (10 MB)" },
      { status: 413 },
    );
  }

  const sttProviderEnv = optionalEnv("STT_PROVIDER", "").trim().toLowerCase();
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  let provider: "groq" | "openai";
  let url: string;
  let model: string;
  let apiKey: string;

  if (groqKey && sttProviderEnv !== "openai") {
    provider = "groq";
    url = GROQ_TRANSCRIBE_URL;
    model = optionalEnv("GROQ_STT_MODEL", "whisper-large-v3-turbo").trim();
    apiKey = groqKey;
  } else if (openaiKey) {
    provider = "openai";
    url = OPENAI_TRANSCRIBE_URL;
    model = optionalEnv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe").trim();
    apiKey = openaiKey;
  } else {
    return Response.json(
      { error: "STT is not configured on the server (set GROQ_API_KEY or OPENAI_API_KEY)" },
      { status: 503 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  let audioBlob: Blob | null = null;
  let filename = "audio.wav";

  if (contentType.includes("application/json")) {
    let body: { audio?: unknown; audioBase64?: unknown; mimeType?: unknown } | null = null;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const raw = typeof body?.audio === "string" ? body.audio : typeof body?.audioBase64 === "string" ? body.audioBase64 : "";
    if (!raw.trim()) {
      return Response.json({ error: "Audio data is required" }, { status: 400 });
    }

    const cleanMime = (typeof body?.mimeType === "string" ? body.mimeType : "audio/wav").split(";")[0]?.trim() || "audio/wav";
    const base64Clean = raw.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(base64Clean, "base64");
    if (buffer.length === 0) {
      return Response.json({ error: "Audio data is empty" }, { status: 400 });
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      return Response.json(
        { error: "Audio payload exceeds maximum allowed size (10 MB)" },
        { status: 413 },
      );
    }

    audioBlob = new Blob([buffer], { type: cleanMime });
    if (cleanMime.includes("webm")) filename = "audio.webm";
    else if (cleanMime.includes("mp4") || cleanMime.includes("m4a")) filename = "audio.m4a";
  } else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    let formData: FormData | null = null;
    try {
      formData = await request.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const field = formData.get("file") ?? formData.get("audio");
    if (!field || !(field instanceof Blob)) {
      return Response.json({ error: "Audio file is required in form data" }, { status: 400 });
    }
    if (field.size === 0) {
      return Response.json({ error: "Audio file is empty" }, { status: 400 });
    }
    if (field.size > MAX_AUDIO_BYTES) {
      return Response.json(
        { error: "Audio payload exceeds maximum allowed size (10 MB)" },
        { status: 413 },
      );
    }

    audioBlob = field;
    if (field instanceof File && field.name) {
      filename = field.name;
    } else if (field.type.includes("webm")) {
      filename = "audio.webm";
    }
  } else {
    return Response.json({ error: "Content-Type must be application/json or multipart/form-data" }, { status: 400 });
  }

  const upstreamForm = new FormData();
  upstreamForm.append("file", audioBlob, filename);
  upstreamForm.append("model", model);
  upstreamForm.append("language", "pt");
  upstreamForm.append("prompt", STT_PROMPT);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
    });
  } catch (err) {
    console.error("[transcribe] upstream fetch failed", err);
    return Response.json({ error: "Transcription request failed" }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("[transcribe] upstream error", upstream.status, await upstream.text().catch(() => ""));
    return Response.json({ error: "Transcription upstream error" }, { status: 502 });
  }

  const result = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof result?.text === "string" ? result.text.trim() : "";

  return Response.json({ text, provider }, { status: 200 });
}
