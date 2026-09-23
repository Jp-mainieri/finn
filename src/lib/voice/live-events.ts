/**
 * The subset of the GPT-Live event protocol Finn uses, as carried on the WebRTC
 * data channel ("oai-events"). Shapes follow the official reference:
 * - https://developers.openai.com/api/reference/resources/live/primary-websocket
 * - https://developers.openai.com/api/docs/guides/live-delegation (client delegation)
 * - https://developers.openai.com/api/docs/guides/live-conversations (transcripts, close)
 */

export type LiveServerEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "session.input_transcript.delta"; delta: string; startMs: number; endMs: number }
  | { type: "session.output_transcript.delta"; delta: string; startMs: number; endMs: number }
  | { type: "session.delegation.created"; delegationId: string; target: "client" | "responses"; offsetMs: number }
  | { type: "session.commentary.appended"; clientEventId?: string }
  | { type: "session.closed"; reason: string }
  | { type: "error"; code: string | null; message: string; clientEventId?: string };

/** Parses a data-channel message; returns null for events Finn doesn't use. */
export function parseLiveServerEvent(data: unknown): LiveServerEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  switch (raw.type) {
    case "session.started": {
      const session = raw.session as { id?: unknown } | undefined;
      return { type: "session.started", sessionId: typeof session?.id === "string" ? session.id : "" };
    }
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      if (typeof raw.delta !== "string") return null;
      return {
        type: raw.type,
        delta: raw.delta,
        startMs: num(raw.start_ms),
        endMs: num(raw.end_ms),
      };
    case "session.delegation.created": {
      const d = raw.delegation as { id?: unknown; target?: unknown } | undefined;
      if (typeof d?.id !== "string") return null;
      return {
        type: "session.delegation.created",
        delegationId: d.id,
        target: d.target === "responses" ? "responses" : "client",
        offsetMs: num(raw.offset_ms),
      };
    }
    case "session.commentary.appended":
      return { type: "session.commentary.appended", clientEventId: str(raw.client_event_id) };
    case "session.closed":
      return { type: "session.closed", reason: str(raw.reason) ?? "unknown" };
    case "error": {
      const e = (raw.error ?? {}) as Record<string, unknown>;
      return {
        type: "error",
        code: str(e.code) ?? null,
        message: str(e.message) ?? "Unknown Live error",
        clientEventId: str(e.client_event_id),
      };
    }
    default:
      return null;
  }
}

export type LiveClientEvent =
  | { type: "session.commentary.append"; event_id: string; delegation_id: string | null; content: string }
  | { type: "session.thinking.append"; event_id: string; delegation_id: string | null; content: string }
  | { type: "session.instructions.append"; event_id: string; delegation_id: string | null; content: string }
  | { type: "session.close"; event_id: string };

/** Client events the browser may send; used to lock down the data channel at session creation. */
export const ALLOWED_CLIENT_EVENTS: readonly LiveClientEvent["type"][] = [
  "session.commentary.append",
  "session.thinking.append",
  "session.instructions.append",
  "session.close",
];

/** A result GPT-Live should say aloud (it may paraphrase). */
export function commentaryAppend(eventId: string, delegationId: string | null, content: string): LiveClientEvent {
  return { type: "session.commentary.append", event_id: eventId, delegation_id: delegationId, content };
}

export function sessionClose(eventId: string): LiveClientEvent {
  return { type: "session.close", event_id: eventId };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
