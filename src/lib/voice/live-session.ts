import { CLOSE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, LIVE_SESSION_PATH, MAX_SPOKEN_CHARS } from "./config";
import type { LiveSessionResponse } from "./live-session-config";
import { commentaryAppend, type LiveClientEvent, parseLiveServerEvent, sessionClose } from "./live-events";
import { classifyServerFailure } from "./failure-speech";
import { DayLimitedError, RateLimitedError, UnauthorizedError, UnavailableError, type VoiceSession, type VoiceSessionHandlers } from "./voice-session";

/**
 * GPT-Live over WebRTC with client delegation.
 * Flow (https://developers.openai.com/api/docs/guides/voice-webrtc?api=live):
 * 1. add the mic track and create the "oai-events" data channel before the offer;
 * 2. set the local description and wait for ICE gathering;
 * 3. our server exchanges the offer for an answer (POST /v1/live/sessions);
 * 4. apply the answer and wait for `session.started` (never send `session.start`).
 * Delegations arrive as `session.delegation.created` and are answered with
 * `session.commentary.append` carrying the delegation id
 * (https://developers.openai.com/api/docs/guides/live-delegation#receive-a-client-delegation).
 * Closing sends `session.close` and waits for `session.closed`
 * (https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close).
 *
 * The mic track is shared with the wake-word engine, so it is never stopped here.
 */

const ICE_GATHER_TIMEOUT_MS = 3_000;

export interface LiveSessionOptions {
  micTrack: MediaStreamTrack;
  micStream: MediaStream;
  getToken: () => string | null;
  handlers: VoiceSessionHandlers;
}

export class GptLiveSession implements VoiceSession {
  private readonly pc: RTCPeerConnection;
  private readonly dc: RTCDataChannel;
  private started = false;
  private closed = false;
  private closing = false;
  private seq = 0;
  private onStarted: (() => void) | null = null;
  private onAborted: ((err: Error) => void) | null = null;
  private onFinalized: (() => void) | null = null;

  constructor(private readonly options: LiveSessionOptions) {
    this.pc = new RTCPeerConnection();
    this.pc.addEventListener("track", (event) => {
      options.handlers.onRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
    });
    this.pc.addTrack(options.micTrack, options.micStream);

    this.dc = this.pc.createDataChannel("oai-events");
    this.dc.addEventListener("message", (event) => this.onMessage(event.data));
    this.dc.addEventListener("close", () => this.finish("connection_lost"));
    this.pc.addEventListener("connectionstatechange", () => {
      if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") this.finish("connection_lost");
    });
  }

  async connect(): Promise<void> {
    const token = this.options.getToken();
    if (!token) throw new UnauthorizedError();

    const started = new Promise<void>((resolve, reject) => {
      this.onStarted = resolve;
      this.onAborted = reject;
    });
    started.catch(() => undefined); // may reject before negotiate() attaches to it

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Live session start timed out")), CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.negotiate(token).then(() => started), timeout]);
    } catch (err) {
      // Failed before going live: tear down silently (the caller handles the error).
      this.closed = true;
      this.teardown();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  speak(delegationId: string | null, text: string): string {
    const eventId = this.nextEventId("result");
    this.send(commentaryAppend(eventId, delegationId, text.slice(0, MAX_SPOKEN_CHARS)));
    return eventId;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return new Promise((resolve) => this.whenFinalized(resolve));
    this.closing = true;
    if (!this.started || this.dc.readyState !== "open") {
      this.finish("close_requested");
      return;
    }
    const finalized = new Promise<void>((resolve) => this.whenFinalized(resolve));
    this.send(sessionClose(this.nextEventId("close")));
    const timer = setTimeout(() => this.finish("close_timeout"), CLOSE_TIMEOUT_MS);
    await finalized;
    clearTimeout(timer);
  }

  private async negotiate(token: string): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering();
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error("Missing local SDP offer");

    const res = await fetch(LIVE_SESSION_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sdp }),
    });
    if (res.status === 401) throw new UnauthorizedError();
    const kind = await classifyServerFailure(res);
    if (kind === "day_limited") throw new DayLimitedError();
    if (kind === "rate_limited") throw new RateLimitedError();
    if (kind === "unavailable") throw new UnavailableError();
    if (!res.ok) throw new Error(`Live session request failed (${res.status})`);
    const answer = (await res.json()) as LiveSessionResponse;
    await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  }

  /** Waits for ICE gathering, but not forever: host candidates are usually enough. */
  private waitForIceGathering(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => {
        if (this.pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
      this.pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private onMessage(data: unknown): void {
    const event = parseLiveServerEvent(data);
    if (!event) return;
    const { handlers } = this.options;
    switch (event.type) {
      case "session.started":
        this.started = true;
        this.onStarted?.();
        break;
      case "session.input_transcript.delta":
        handlers.onUserTranscript({ delta: event.delta, startMs: event.startMs, endMs: event.endMs });
        break;
      case "session.output_transcript.delta":
        handlers.onAssistantTranscript({ delta: event.delta, startMs: event.startMs, endMs: event.endMs });
        break;
      case "session.delegation.created":
        if (event.target === "client") handlers.onDelegation({ id: event.delegationId, offsetMs: event.offsetMs });
        break;
      case "session.closed":
        this.finish(event.reason);
        break;
      case "error":
        console.warn("[live] error event", event);
        handlers.onError(event.message);
        break;
    }
  }

  private send(event: LiveClientEvent): void {
    if (this.dc.readyState !== "open") {
      console.warn("[live] data channel not open; dropped", event.type);
      return;
    }
    this.dc.send(JSON.stringify(event));
  }

  private nextEventId(prefix: string): string {
    this.seq += 1;
    return `finn_${prefix}_${this.seq}`;
  }

  private whenFinalized(resolve: () => void): void {
    const previous = this.onFinalized;
    this.onFinalized = () => {
      previous?.();
      resolve();
    };
  }

  /** Single exit point: tears down transport once and notifies the controller. */
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    if (!this.started) this.onAborted?.(new Error(`Live session ended before starting (${reason})`));
    this.onFinalized?.();
    this.onFinalized = null;
    this.options.handlers.onClosed(reason);
  }

  private teardown(): void {
    try {
      this.dc.close();
    } catch {
      // already closed
    }
    // Closing the peer connection does not stop the shared mic track.
    this.pc.close();
  }
}
