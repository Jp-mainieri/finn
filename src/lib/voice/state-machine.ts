import { IDLE_TIMEOUT_MS, MAX_CONVERSATION_MS } from "./config";

/**
 * Audio lifecycle of a trip (spec "Wake word"):
 *
 *   idle ─TRIP_STARTED→ listening-wake ─WAKE→ connecting ─CONNECTED→ in-conversation
 *     ↑                      ↑                                           │ idle timeout / HANG_UP
 *     └──TRIP_ENDED──────────┴──────────────CLOSED──────────── closing ←─┘
 *
 * Any state can go to `error` (FAILED); recoverable errors (the mic is still
 * fine) go back to listening on RECOVER or straight to a new session on WAKE. The machine is pure apart from its two
 * timers (idle + max duration); side effects (opening/closing the Live session)
 * are done by whoever subscribes to transitions.
 */

export type VoiceState =
  | "idle"
  | "listening-wake"
  | "connecting"
  | "in-conversation"
  | "closing"
  | "error";

/** What the conversation is doing right now (only meaningful in `in-conversation`). */
export type ConversationActivity = "listening" | "thinking" | "speaking";

export type VoiceErrorKind =
  | "mic-denied"
  | "mic-lost"
  | "unsupported"
  | "connect-failed"
  | "session-lost"
  | "unauthorized";

export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
}

export type VoiceEvent =
  | { type: "TRIP_STARTED" }
  | { type: "WAKE" }
  | { type: "CONNECTED" }
  | { type: "USER_SPEECH" }
  | { type: "ASSISTANT_SPEECH" }
  | { type: "ASSISTANT_QUIET" }
  | { type: "WORK_STARTED" }
  | { type: "WORK_FINISHED" }
  | { type: "HANG_UP" }
  | { type: "CLOSED" }
  | { type: "FAILED"; error: VoiceError }
  /** Back to waiting for "Finn" after a recoverable error. */
  | { type: "RECOVER" }
  | { type: "TRIP_ENDED" };

export interface VoiceSnapshot {
  state: VoiceState;
  activity: ConversationActivity;
  /** Delegations still waiting for the backend; the idle timer is paused while > 0. */
  pendingWork: number;
  error?: VoiceError;
}

export type TransitionListener = (next: VoiceSnapshot, prev: VoiceSnapshot, event: VoiceEvent) => void;

export interface VoiceStateMachineOptions {
  idleTimeoutMs?: number;
  maxConversationMs?: number;
}

/** Errors after which the mic stream is still usable, so a tap can retry directly. */
const RECOVERABLE: ReadonlySet<VoiceErrorKind> = new Set(["connect-failed", "session-lost"]);

export function isRecoverable(error: VoiceError | undefined): boolean {
  return !!error && RECOVERABLE.has(error.kind);
}

const INITIAL: VoiceSnapshot = { state: "idle", activity: "listening", pendingWork: 0 };

export class VoiceStateMachine {
  private snapshot: VoiceSnapshot = INITIAL;
  private readonly listeners = new Set<TransitionListener>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTimeoutMs: number;
  private readonly maxConversationMs: number;

  constructor(options: VoiceStateMachineOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxConversationMs = options.maxConversationMs ?? MAX_CONVERSATION_MS;
  }

  get current(): VoiceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies an event; events that don't apply to the current state are ignored. */
  dispatch(event: VoiceEvent): void {
    const prev = this.snapshot;
    const next = this.reduce(prev, event);
    if (next === prev) return;
    this.snapshot = next;
    this.updateTimers(prev, next);
    for (const listener of [...this.listeners]) listener(next, prev, event);
  }

  /** Stops timers; call when the owner is torn down. */
  dispose(): void {
    this.clearIdleTimer();
    clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
    this.listeners.clear();
  }

  private reduce(s: VoiceSnapshot, event: VoiceEvent): VoiceSnapshot {
    if (event.type === "FAILED") {
      return { state: "error", activity: "listening", pendingWork: 0, error: event.error };
    }
    if (event.type === "TRIP_ENDED") {
      return s.state === "idle" ? s : INITIAL;
    }

    switch (s.state) {
      case "idle":
        return event.type === "TRIP_STARTED" ? to("listening-wake") : s;

      case "listening-wake":
        return event.type === "WAKE" ? to("connecting") : s;

      case "connecting":
        if (event.type === "CONNECTED") return to("in-conversation");
        if (event.type === "HANG_UP") return to("closing");
        if (event.type === "CLOSED") return to("listening-wake");
        return s;

      case "in-conversation":
        switch (event.type) {
          case "USER_SPEECH":
            return s.pendingWork > 0 ? s : { ...s, activity: "listening" };
          case "ASSISTANT_SPEECH":
            return s.activity === "speaking" ? s : { ...s, activity: "speaking" };
          case "ASSISTANT_QUIET":
            return s.activity === "speaking"
              ? { ...s, activity: s.pendingWork > 0 ? "thinking" : "listening" }
              : s;
          case "WORK_STARTED":
            return { ...s, activity: "thinking", pendingWork: s.pendingWork + 1 };
          case "WORK_FINISHED": {
            const pendingWork = Math.max(0, s.pendingWork - 1);
            const activity = pendingWork > 0 ? "thinking" : s.activity === "thinking" ? "listening" : s.activity;
            return { ...s, pendingWork, activity };
          }
          case "HANG_UP":
            return to("closing");
          case "CLOSED":
            return to("listening-wake");
          default:
            return s;
        }

      case "closing":
        return event.type === "CLOSED" ? to("listening-wake") : s;

      case "error":
        if (event.type === "TRIP_STARTED") return to("listening-wake");
        if (event.type === "WAKE" && isRecoverable(s.error)) return to("connecting");
        if (event.type === "RECOVER" && isRecoverable(s.error)) return to("listening-wake");
        return s;
    }
  }

  private updateTimers(prev: VoiceSnapshot, next: VoiceSnapshot): void {
    if (next.state !== "in-conversation") {
      this.clearIdleTimer();
      clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
      return;
    }

    if (prev.state !== "in-conversation") {
      this.maxTimer = setTimeout(() => this.dispatch({ type: "HANG_UP" }), this.maxConversationMs);
    }

    // Every accepted event counts as activity and restarts the countdown, which
    // stays paused while the backend works or the assistant is still talking.
    if (next.pendingWork > 0 || next.activity === "speaking") this.clearIdleTimer();
    else this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.dispatch({ type: "HANG_UP" });
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function to(state: VoiceState): VoiceSnapshot {
  return { state, activity: "listening", pendingWork: 0 };
}
