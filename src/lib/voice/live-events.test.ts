import { describe, expect, it } from "vitest";
import { commentaryAppend, parseLiveServerEvent, sessionClose } from "./live-events";
import { buildLiveSessionConfig } from "./live-session-config";
import { TranscriptBuffer } from "./transcript-buffer";

// Payloads copied from the GPT-Live reference examples.
describe("parseLiveServerEvent", () => {
  it("parses session.started", () => {
    const raw = { type: "session.started", event_id: "e", session: { id: "live_123", status: "active" } };
    expect(parseLiveServerEvent(JSON.stringify(raw))).toEqual({ type: "session.started", sessionId: "live_123" });
  });

  it("parses transcript deltas", () => {
    const raw = {
      type: "session.input_transcript.delta",
      event_id: "evt_input_transcript_001",
      delta: "A table for two at seven, please.",
      start_ms: 1600,
      end_ms: 3400,
    };
    expect(parseLiveServerEvent(JSON.stringify(raw))).toEqual({
      type: "session.input_transcript.delta",
      delta: "A table for two at seven, please.",
      startMs: 1600,
      endMs: 3400,
    });
  });

  it("parses a client delegation", () => {
    const raw = {
      type: "session.delegation.created",
      event_id: "evt_delegation_001",
      offset_ms: 3600,
      delegation: { id: "del_abc123", type: "delegation", target: "client" },
    };
    expect(parseLiveServerEvent(JSON.stringify(raw))).toEqual({
      type: "session.delegation.created",
      delegationId: "del_abc123",
      target: "client",
      offsetMs: 3600,
    });
  });

  it("parses errors and closes", () => {
    const err = {
      type: "error",
      event_id: "e",
      error: { type: "invalid_request_error", code: "x", message: "bad", client_event_id: "finn_result_1" },
    };
    expect(parseLiveServerEvent(JSON.stringify(err))).toEqual({
      type: "error",
      code: "x",
      message: "bad",
      clientEventId: "finn_result_1",
    });
    expect(parseLiveServerEvent('{"type":"session.closed","reason":"expired"}')).toEqual({
      type: "session.closed",
      reason: "expired",
    });
  });

  it("ignores unknown or malformed messages", () => {
    expect(parseLiveServerEvent("not json")).toBeNull();
    expect(parseLiveServerEvent('{"type":"session.usage.updated"}')).toBeNull();
    expect(parseLiveServerEvent('{"type":"session.delegation.created","delegation":{}}')).toBeNull();
  });
});

describe("client events", () => {
  it("answers a delegation with session.commentary.append", () => {
    expect(commentaryAppend("finn_result_1", "del_abc123", "Tocando Rock.")).toEqual({
      type: "session.commentary.append",
      event_id: "finn_result_1",
      delegation_id: "del_abc123",
      content: "Tocando Rock.",
    });
    expect(sessionClose("finn_close_2")).toEqual({ type: "session.close", event_id: "finn_close_2" });
  });

  it("builds a client-delegation session that only lets the browser send what it uses", () => {
    const config = buildLiveSessionConfig("bossa");
    expect(config).toMatchObject({
      model: "gpt-live-1",
      delegation: { type: "client" },
      audio: { output: { voice: "bossa" } },
    });
    expect(config).not.toHaveProperty("audio.format");
    expect(config.client.data_channel.allowed_client_events).toEqual(
      expect.arrayContaining(["session.commentary.append", "session.close"]),
    );
    expect(config.instructions).toMatch(/português do Brasil/);
  });
});

describe("TranscriptBuffer", () => {
  it("consumes fragments that started before the delegation and keeps the rest", () => {
    const b = new TranscriptBuffer();
    b.add({ delta: " toca", startMs: 100, endMs: 200 });
    b.add({ delta: "  rock ", startMs: 200, endMs: 400 });
    b.add({ delta: "e me leva", startMs: 900, endMs: 1_200 });
    expect(b.hasTextBefore(500)).toBe(true);
    expect(b.takeUntil(500)).toBe("toca rock");
    expect(b.hasTextBefore(500)).toBe(false);
    expect(b.peek()).toBe("e me leva");
    b.clear();
    expect(b.takeUntil(10_000)).toBe("");
  });
});
