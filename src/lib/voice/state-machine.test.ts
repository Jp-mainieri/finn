import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceStateMachine, type VoiceEvent, type VoiceState } from "./state-machine";

const IDLE_MS = 10_000;
const MAX_MS = 60_000;

function machineIn(state: VoiceState): VoiceStateMachine {
  const m = new VoiceStateMachine({ idleTimeoutMs: IDLE_MS, maxConversationMs: MAX_MS });
  const path: Record<VoiceState, VoiceEvent[]> = {
    idle: [],
    "listening-wake": [{ type: "TRIP_STARTED" }],
    connecting: [{ type: "TRIP_STARTED" }, { type: "WAKE" }],
    "in-conversation": [{ type: "TRIP_STARTED" }, { type: "WAKE" }, { type: "CONNECTED" }],
    closing: [{ type: "TRIP_STARTED" }, { type: "WAKE" }, { type: "CONNECTED" }, { type: "HANG_UP" }],
    error: [{ type: "FAILED", error: { kind: "mic-denied", message: "x" } }],
  };
  path[state].forEach((e) => m.dispatch(e));
  expect(m.current.state).toBe(state);
  return m;
}

describe("VoiceStateMachine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("walks the happy path idle → listening-wake → connecting → in-conversation → closing → listening-wake", () => {
    const m = new VoiceStateMachine();
    const seen: VoiceState[] = [];
    m.subscribe((next) => seen.push(next.state));
    m.dispatch({ type: "TRIP_STARTED" });
    m.dispatch({ type: "WAKE" });
    m.dispatch({ type: "CONNECTED" });
    m.dispatch({ type: "HANG_UP" });
    m.dispatch({ type: "CLOSED" });
    expect(seen).toEqual(["listening-wake", "connecting", "in-conversation", "closing", "listening-wake"]);
  });

  it("ignores events that don't apply", () => {
    const m = machineIn("idle");
    const listener = vi.fn();
    m.subscribe(listener);
    m.dispatch({ type: "WAKE" });
    m.dispatch({ type: "CONNECTED" });
    m.dispatch({ type: "CLOSED" });
    expect(m.current.state).toBe("idle");
    expect(listener).not.toHaveBeenCalled();
  });

  it("closes after the idle timeout with no activity", () => {
    const m = machineIn("in-conversation");
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(m.current.state).toBe("in-conversation");
    vi.advanceTimersByTime(1);
    expect(m.current.state).toBe("closing");
  });

  it("restarts the idle countdown on user speech", () => {
    const m = machineIn("in-conversation");
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    m.dispatch({ type: "USER_SPEECH" });
    vi.advanceTimersByTime(IDLE_MS - 1_000);
    expect(m.current.state).toBe("in-conversation");
    vi.advanceTimersByTime(1_000);
    expect(m.current.state).toBe("closing");
  });

  it("pauses the countdown while the backend works and while the assistant speaks", () => {
    const m = machineIn("in-conversation");
    m.dispatch({ type: "WORK_STARTED" });
    expect(m.current).toMatchObject({ activity: "thinking", pendingWork: 1 });
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(m.current.state).toBe("in-conversation");

    m.dispatch({ type: "WORK_FINISHED" });
    m.dispatch({ type: "ASSISTANT_SPEECH" });
    expect(m.current.activity).toBe("speaking");
    vi.advanceTimersByTime(IDLE_MS * 2);
    expect(m.current.state).toBe("in-conversation");

    // ~10s after the last response finished playing, the window closes.
    m.dispatch({ type: "ASSISTANT_QUIET" });
    expect(m.current.activity).toBe("listening");
    vi.advanceTimersByTime(IDLE_MS);
    expect(m.current.state).toBe("closing");
  });

  it("keeps 'thinking' until every pending delegation finished", () => {
    const m = machineIn("in-conversation");
    m.dispatch({ type: "WORK_STARTED" });
    m.dispatch({ type: "WORK_STARTED" });
    m.dispatch({ type: "WORK_FINISHED" });
    expect(m.current).toMatchObject({ activity: "thinking", pendingWork: 1 });
    m.dispatch({ type: "WORK_FINISHED" });
    expect(m.current).toMatchObject({ activity: "listening", pendingWork: 0 });
  });

  it("hangs up at the max conversation length even with constant activity", () => {
    const m = machineIn("in-conversation");
    for (let t = 0; t < MAX_MS; t += 5_000) {
      m.dispatch({ type: "USER_SPEECH" });
      vi.advanceTimersByTime(5_000);
    }
    expect(m.current.state).toBe("closing");
  });

  it("does not fire stale timers after leaving the conversation", () => {
    const m = machineIn("in-conversation");
    m.dispatch({ type: "CLOSED" });
    expect(m.current.state).toBe("listening-wake");
    vi.advanceTimersByTime(MAX_MS * 2);
    expect(m.current.state).toBe("listening-wake");
  });

  it("goes back to listening when the provider ends the session", () => {
    const m = machineIn("in-conversation");
    m.dispatch({ type: "CLOSED" });
    expect(m.current.state).toBe("listening-wake");
  });

  it("can hang up while still connecting", () => {
    const m = machineIn("connecting");
    m.dispatch({ type: "HANG_UP" });
    expect(m.current.state).toBe("closing");
    m.dispatch({ type: "CLOSED" });
    expect(m.current.state).toBe("listening-wake");
  });

  it("recovers from connection errors by tap (WAKE) or RECOVER, but not from mic errors", () => {
    const m = machineIn("connecting");
    m.dispatch({ type: "FAILED", error: { kind: "connect-failed", message: "x" } });
    expect(m.current).toMatchObject({ state: "error", error: { kind: "connect-failed" } });
    m.dispatch({ type: "WAKE" });
    expect(m.current.state).toBe("connecting");

    m.dispatch({ type: "FAILED", error: { kind: "connect-failed", message: "x" } });
    m.dispatch({ type: "RECOVER" });
    expect(m.current.state).toBe("listening-wake");

    const denied = machineIn("error");
    denied.dispatch({ type: "WAKE" });
    denied.dispatch({ type: "RECOVER" });
    expect(denied.current.state).toBe("error");
    denied.dispatch({ type: "TRIP_STARTED" });
    expect(denied.current.state).toBe("listening-wake");
  });

  it("ends the trip from any state", () => {
    for (const state of ["listening-wake", "connecting", "in-conversation", "closing", "error"] as const) {
      const m = machineIn(state);
      m.dispatch({ type: "TRIP_ENDED" });
      expect(m.current).toEqual({ state: "idle", activity: "listening", pendingWork: 0 });
    }
  });
});
