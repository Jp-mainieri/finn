import { authorizeDriver } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ai-limits";
import { MissingEnvError, optionalEnv, requireEnv } from "@/lib/env";
import { buildLiveSessionConfig, DEFAULT_LIVE_VOICE, type LiveSessionResponse } from "@/lib/voice/live-session-config";

/**
 * Starts a GPT-Live WebRTC session for the PWA.
 *
 * GPT-Live's browser flow is the "unified" SDP exchange, not a client secret:
 * the browser sends its SDP offer here, this route POSTs it together with the
 * session config to `POST /v1/live/sessions` using the server-only
 * OPENAI_API_KEY, and returns just the session id + SDP answer.
 * Docs: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
 *       https://developers.openai.com/api/docs/guides/live-delegation (client delegation)
 */

const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const MAX_SDP_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const auth = await authorizeDriver(request);
  if (auth instanceof Response) return auth;

  if (optionalEnv("ENABLE_GPT_LIVE", "0") !== "1") {
    return Response.json(
      { error: "GPT-Live-1 está temporariamente desativado (Em breve)." },
      { status: 403 },
    );
  }

  const limited = await enforceAiLimit("live", auth.driverId);
  if (limited) return limited;

  let sdp: unknown;
  try {
    ({ sdp } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof sdp !== "string" || !sdp.trim() || sdp.length > MAX_SDP_BYTES) {
    return Response.json({ error: "An SDP offer is required" }, { status: 400 });
  }

  let apiKey: string;
  try {
    apiKey = requireEnv("OPENAI_API_KEY");
  } catch (err) {
    if (!(err instanceof MissingEnvError)) throw err;
    console.error("[realtime] OPENAI_API_KEY is not set");
    return Response.json({ error: "Voice is not configured on the server" }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(LIVE_SESSIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: buildLiveSessionConfig(optionalEnv("OPENAI_LIVE_VOICE", DEFAULT_LIVE_VOICE)),
        transport: { type: "webrtc", sdp },
      }),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[realtime] Live session request failed", err);
    return Response.json({ error: "Live session creation failed" }, { status: 502 });
  }

  if (!upstream.ok) {
    // Log OpenAI's error server-side only; the browser gets a generic message.
    console.error("[realtime] Live session creation failed", upstream.status, await upstream.text().catch(() => ""));
    return Response.json({ error: "Live session creation failed" }, { status: 502 });
  }

  const created = (await upstream.json().catch(() => null)) as {
    session?: { id?: unknown };
    transport?: { sdp?: unknown };
  } | null;
  const answer = created?.transport?.sdp;
  if (typeof answer !== "string") {
    console.error("[realtime] Live session response had no SDP answer");
    return Response.json({ error: "Live session creation failed" }, { status: 502 });
  }

  const body: LiveSessionResponse = {
    sessionId: typeof created?.session?.id === "string" ? created.session.id : "",
    sdp: answer,
  };
  return Response.json(body, { status: 201, headers: { "Cache-Control": "no-store" } });
}
