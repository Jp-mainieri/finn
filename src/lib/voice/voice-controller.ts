import { AudioIO } from "./audio-io";
import { toPendingActions, openPendingAction, type PendingAction } from "./client-actions";
import {
  AUTO_OPEN_CLIENT_ACTIONS,
  AUTO_OPEN_MAX_WAIT_MS,
  AUTO_OPEN_QUIET_MS,
  ERROR_RECOVERY_MS,
  SPEAKING_RMS_THRESHOLD,
} from "./config";
import { DelegationHandler } from "./delegation-handler";
import { getDriverContext, getDriverSettings, saveDictatedAddress } from "./driver-settings";
import { OrchestratorClient, randomId } from "./orchestrator-client";
import { isRecoverable, VoiceStateMachine, type VoiceError, type VoiceSnapshot } from "./state-machine";
import { SttTtsVoiceSession } from "./stt-tts-session";
import type { TokenStore } from "./token-store";
import { TranscriptBuffer } from "./transcript-buffer";
import { UnauthorizedError, type VoiceSession } from "./voice-session";
import { createWakeWordDetector, type WakeWordDetector, type WakeWordStatus } from "./wake-word";

/** Everything the UI renders. */
export interface VoiceView {
  voice: VoiceSnapshot;
  wakeWord: WakeWordStatus | { available: "loading" } | null;
  userText: string;
  assistantText: string;
  pendingActions: PendingAction[];
  needsToken: boolean;
  /** The server answered 401 with the saved token. */
  tokenRejected: boolean;
}

const TICK_MS = 200;
/** Assistant counts as speaking this long after its last audio/transcript signal. */
const SPEAKING_HOLD_MS = 700;

/**
 * Browser glue for a trip: owns the mic (AudioIO), Porcupine, the Live session,
 * the state machine and the orchestrator client. The pieces with real logic
 * (state machine, delegation handling, orchestrator client, client actions)
 * are unit-tested on their own; this class only wires them to browser APIs.
 */
export class VoiceController {
  private readonly machine = new VoiceStateMachine();
  private readonly transcripts = new TranscriptBuffer();
  private readonly orchestrator: OrchestratorClient;
  private readonly delegations: DelegationHandler;
  private readonly listeners = new Set<() => void>();
  private view: VoiceView;

  private audio: AudioIO | null = null;
  private detector: WakeWordDetector | null = null;
  private session: VoiceSession | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private lastAssistantSignal = 0;
  private captionTurn: "user" | "assistant" = "user";
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private autoOpen: { action: PendingAction; since: number; spokeAfter: boolean } | null = null;
  private openAfterClose: PendingAction | null = null;
  private disposed = false;

  constructor(private readonly tokens: TokenStore) {
    this.orchestrator = new OrchestratorClient({
      getToken: () => tokens.get(),
      getDriverContext: () => getDriverContext() ?? {},
    });
    this.delegations = new DelegationHandler({
      transcripts: this.transcripts,
      orchestrator: this.orchestrator,
      speak: (id, text) => this.session?.speak(id, text),
      onWorkStarted: () => this.machine.dispatch({ type: "WORK_STARTED" }),
      onWorkFinished: () => this.machine.dispatch({ type: "WORK_FINISHED" }),
      onTurn: ({ response }) => {
        for (const action of response.clientActions) {
          if (action.type === "save_address") {
            saveDictatedAddress(action.label, action.address);
          }
        }
        this.onActions(toPendingActions(response.clientActions, randomId));
      },
      onFailure: (failure) => {
        if (failure === "unauthorized") this.requireToken();
      },
    });
    this.view = {
      voice: this.machine.current,
      wakeWord: null,
      userText: "",
      assistantText: "",
      pendingActions: [],
      needsToken: !tokens.get(),
      tokenRejected: false,
    };
    this.machine.subscribe((next, prev) => this.onTransition(next, prev));
  }

  // --- React binding (useSyncExternalStore) ----------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): VoiceView => this.view;

  private update(patch: Partial<VoiceView>): void {
    this.view = { ...this.view, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // --- Commands from the UI ---------------------------------------------------

  saveToken(token: string): void {
    this.tokens.set(token);
    this.update({ needsToken: !this.tokens.get(), tokenRejected: false });
    // The mic is still open after a 401 mid-trip: go straight back to listening.
    const { state, error } = this.machine.current;
    if (state === "error" && error?.kind === "unauthorized" && this.audio?.micAlive) {
      this.machine.dispatch({ type: "TRIP_STARTED" });
    }
  }

  resetToken(): void {
    this.tokens.clear();
    this.endTrip();
    this.update({ needsToken: true, tokenRejected: false });
  }

  /** Must be called from a tap: unlocks audio (iOS) and asks for the mic once. */
  startTrip(): void {
    if (!this.audio) this.audio = new AudioIO(); // synchronous, inside the gesture
    const audio = this.audio;
    void audio.resume();
    void this.requestWakeLock();

    audio
      .openMic()
      .then(() => {
        this.machine.dispatch({ type: "TRIP_STARTED" });
        this.watchMic();
        if (!this.detector) void this.initWakeWord();
      })
      .catch((err: unknown) => {
        const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
        this.fail(
          denied
            ? { kind: "mic-denied", message: "Sem acesso ao microfone. Libere o microfone para o Finn nos Ajustes." }
            : { kind: "unsupported", message: "Não consegui abrir o microfone neste aparelho." },
        );
      });
  }

  /** Tap-to-talk: same as saying "Finn". */
  talk(): void {
    if (this.view.needsToken) return;
    void this.audio?.resume();
    this.machine.dispatch({ type: "WAKE" });
  }

  hangUp(): void {
    this.machine.dispatch({ type: "HANG_UP" });
  }

  endTrip(): void {
    this.autoOpen = null;
    this.openAfterClose = null;
    void this.session?.close();
    this.session = null;
    void this.detector?.release();
    this.detector = null;
    this.audio?.release();
    this.audio = null;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.machine.dispatch({ type: "TRIP_ENDED" });
    this.update({ wakeWord: null, pendingActions: [] });
  }

  dismissAction(id: string): void {
    this.update({ pendingActions: this.view.pendingActions.filter((a) => a.id !== id) });
    if (this.autoOpen?.action.id === id) this.autoOpen = null;
  }

  /** Page went to the background: iOS will suspend it, so stop paying for the session. */
  onHidden(): void {
    const { state } = this.machine.current;
    if (state === "connecting" || state === "in-conversation") this.hangUp();
  }

  /** Page came back to the foreground (e.g. after Waze). */
  async onVisible(): Promise<void> {
    if (!this.audio) return;
    await this.audio.resume();
    void this.requestWakeLock();
    if (!this.audio.micAlive && this.machine.current.state !== "idle") {
      this.fail({ kind: "mic-lost", message: "O microfone foi desligado. Toque para retomar." });
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.recoveryTimer);
    this.endTrip();
    this.machine.dispose();
    this.listeners.clear();
  }

  // --- State machine side effects ---------------------------------------------

  private onTransition(next: VoiceSnapshot, prev: VoiceSnapshot): void {
    this.update({ voice: next });
    if (next.state === prev.state) return;

    this.feedWakeWord(next.state === "listening-wake");

    clearTimeout(this.recoveryTimer);
    if (next.state === "error" && isRecoverable(next.error)) {
      this.recoveryTimer = setTimeout(() => this.machine.dispatch({ type: "RECOVER" }), ERROR_RECOVERY_MS);
    }

    if (next.state === "connecting") void this.openSession();
    if (next.state === "in-conversation") {
      this.audio?.earcon("ready");
      this.startTicker();
    }
    if (prev.state === "in-conversation") this.stopTicker();
    if (next.state === "closing") void this.closeSession();

    const leftConversation =
      (prev.state === "closing" || prev.state === "in-conversation" || prev.state === "connecting") &&
      (next.state === "listening-wake" || next.state === "error" || next.state === "idle");
    if (leftConversation) {
      this.orchestrator.endWindow();
      this.transcripts.clear();
      if (this.session) void this.session.close();
      this.session = null;
      this.audio?.detachRemote();
      this.audio?.earcon("closed");
      const action = this.openAfterClose;
      this.openAfterClose = null;
      if (action) openPendingAction(action, window.location);
    }
  }

  private async openSession(): Promise<void> {
    const audio = this.audio;
    const track = audio?.micTrack;
    if (!audio?.stream || !track || track.readyState !== "live") {
      this.fail({ kind: "mic-lost", message: "O microfone foi desligado. Toque para retomar." });
      return;
    }

    this.orchestrator.startWindow();
    this.transcripts.clear();
    this.captionTurn = "user";
    this.update({ userText: "", assistantText: "" });

    const handlers = {
      onRemoteStream: (stream: MediaStream) => this.session === session && audio.attachRemote(stream),
      onUserTranscript: (fragment: import("./transcript-buffer").TranscriptFragment) => {
        if (this.session !== session) return;
        this.transcripts.add(fragment);
        this.caption("user", fragment.delta);
        this.machine.dispatch({ type: "USER_SPEECH" });
      },
      onAssistantTranscript: (fragment: import("./transcript-buffer").TranscriptFragment) => {
        if (this.session !== session) return;
        this.markAssistantSignal();
        this.caption("assistant", fragment.delta);
      },
      onDelegation: (delegation: import("./voice-session").Delegation) => {
        if (this.session === session) void this.delegations.handle(delegation);
      },
      onClosed: (reason: string) => {
        if (this.session !== session) return;
        console.info("[voice] session closed:", reason);
        const { state } = this.machine.current;
        if (state === "connecting") return; // connect() rejects and reports it
        if (reason === "connection_lost" && state === "in-conversation") {
          this.fail({ kind: "session-lost", message: "A conexão caiu. Chame o Finn de novo." });
        } else {
          this.machine.dispatch({ type: "CLOSED" });
        }
      },
      onError: (message: string) => {
        console.warn("[voice] session error:", message);
        if (message === "Unauthorized") {
          this.requireToken();
          this.fail({ kind: "unauthorized", message: "Token inválido. Configure de novo." });
        }
      },
    };

    const session: VoiceSession = new SttTtsVoiceSession({
      audio,
      getToken: () => this.tokens.get(),
      getTtsMode: () => getDriverSettings().ttsMode,
      handlers,
    });
    this.session = session;

    try {
      await session.connect();
      if (this.session === session) this.machine.dispatch({ type: "CONNECTED" });
      else await session.close();
    } catch (err) {
      if (this.session !== session) return;
      this.session = null;
      if (err instanceof UnauthorizedError) {
        this.requireToken();
        this.fail({ kind: "unauthorized", message: "Token inválido. Configure de novo." });
      } else {
        console.warn("[voice] could not start the Live session", err);
        this.fail({ kind: "connect-failed", message: "Não consegui conectar. Toque para tentar de novo." });
      }
    }
  }

  private async closeSession(): Promise<void> {
    const session = this.session;
    if (session) await session.close();
    if (this.machine.current.state === "closing") this.machine.dispatch({ type: "CLOSED" });
  }

  /** Captions: a speaker's first fragment after the other one spoke starts a new line. */
  private caption(speaker: "user" | "assistant", delta: string): void {
    const key = speaker === "user" ? "userText" : "assistantText";
    const text = this.captionTurn === speaker ? this.view[key] + delta : delta.trimStart();
    this.captionTurn = speaker;
    this.update({ [key]: text });
  }

  private fail(error: VoiceError): void {
    this.machine.dispatch({ type: "FAILED", error });
  }

  private requireToken(): void {
    this.update({ needsToken: true, tokenRejected: true });
  }

  // --- Wake word ----------------------------------------------------------------

  private async initWakeWord(): Promise<void> {
    this.update({ wakeWord: { available: "loading" } });
    const { detector, status } = await createWakeWordDetector(() => {
      if (this.machine.current.state === "listening-wake") this.talk();
    });
    if (this.disposed || !this.audio) {
      void detector?.release();
      return;
    }
    this.detector = detector;
    this.update({ wakeWord: status });
    this.feedWakeWord(this.machine.current.state === "listening-wake");
  }

  /** Porcupine only hears the mic while waiting for "Finn" (same stream, frames dropped otherwise). */
  private feedWakeWord(on: boolean): void {
    const detector = this.detector;
    if (!this.audio) return;
    if (on && detector) this.audio.setFrameSink((frame) => detector.process(frame), detector.frameLength);
    else this.audio.setFrameSink(null);
  }

  // --- Speaking detection, idle support and deep-link auto-open ----------------------

  private markAssistantSignal(): void {
    const now = Date.now();
    this.lastAssistantSignal = now;
    if (this.autoOpen && now > this.autoOpen.since) this.autoOpen.spokeAfter = true;
    this.machine.dispatch({ type: "ASSISTANT_SPEECH" });
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicker(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private tick(): void {
    const now = Date.now();
    const isSpeaking =
      (this.audio?.remoteLevel() ?? 0) > SPEAKING_RMS_THRESHOLD || Boolean(this.session?.isSpeaking?.());
    if (isSpeaking) this.markAssistantSignal();
    else if (now - this.lastAssistantSignal > SPEAKING_HOLD_MS) this.machine.dispatch({ type: "ASSISTANT_QUIET" });

    const pending = this.autoOpen;
    if (!pending) return;
    const quietFor = now - this.lastAssistantSignal;
    const done = pending.spokeAfter && quietFor >= AUTO_OPEN_QUIET_MS;
    if (done || now - pending.since >= AUTO_OPEN_MAX_WAIT_MS) {
      this.autoOpen = null;
      // Close first (graceful, confirmation already spoken); open once the session is gone.
      this.openAfterClose = pending.action;
      this.machine.dispatch({ type: "HANG_UP" });
    }
  }

  private onActions(actions: PendingAction[]): void {
    if (!actions.length) return;
    this.update({ pendingActions: actions });
    if (!AUTO_OPEN_CLIENT_ACTIONS) return;
    const first = actions[0];
    if (this.machine.current.state === "in-conversation") {
      this.autoOpen = { action: first, since: Date.now(), spokeAfter: false };
    } else {
      openPendingAction(first, window.location);
    }
  }

  // --- Misc browser helpers -----------------------------------------------------------

  private watchMic(): void {
    const track = this.audio?.micTrack;
    track?.addEventListener("ended", () => {
      if (this.audio?.micTrack === track) {
        this.fail({ kind: "mic-lost", message: "O microfone foi desligado. Toque para retomar." });
      }
    });
  }

  /** Keeps the screen on while driving; iOS suspends the PWA (and the mic) when it locks. */
  private async requestWakeLock(): Promise<void> {
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }
}
