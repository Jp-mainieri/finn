import type { TranscriptFragment } from "./transcript-buffer";

/**
 * Provider-neutral voice session: one full-duplex conversation window.
 * The controller only depends on this, so the GPT-Live implementation
 * (`live-session.ts`) can be swapped (e.g. for the Realtime API with a
 * `delegate_to_finn` function tool) without touching the rest of the app.
 */

export interface Delegation {
  /** Opaque id to reply to. */
  id: string;
  /** Position on the session timeline where the model asked for help. */
  offsetMs: number;
}

export interface VoiceSessionHandlers {
  onUserTranscript(fragment: TranscriptFragment): void;
  onAssistantTranscript(fragment: TranscriptFragment): void;
  onDelegation(delegation: Delegation): void;
  onRemoteStream(stream: MediaStream): void;
  /** The session is over (graceful close, expiry or connection loss). Fired once. */
  onClosed(reason: string): void;
  /** A command was rejected or the provider reported a non-fatal problem. */
  onError(message: string): void;
}

export interface VoiceSession {
  /** Resolves once the provider says the session is live. */
  connect(): Promise<void>;
  /** Gives the model a result to say aloud for `delegationId` (null = general context). */
  speak(delegationId: string | null, text: string): string;
  /** Graceful close; resolves after the provider confirms or a timeout. Never rejects. */
  close(): Promise<void>;
  /** Optional check if the assistant is actively speaking (e.g. for native SpeechSynthesis or audio player). */
  isSpeaking?(): boolean;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
