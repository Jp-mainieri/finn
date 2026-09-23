import { PCM_WORKLET_PATH } from "./config";

/**
 * Browser audio plumbing (not unit-tested: needs real Web Audio / media devices).
 *
 * iOS rules this follows: the AudioContext and the output <audio> element are
 * created and "unlocked" synchronously inside the trip-start tap, and a single
 * mic MediaStream is opened once and shared by Porcupine (via an AudioWorklet)
 * and the WebRTC peer connection (its track is added to each Live session).
 */

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export class AudioIO {
  readonly context: AudioContext;
  readonly output: HTMLAudioElement;
  private mic: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private frameSink: ((frame: Int16Array) => void) | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private readonly levelBuffer = new Float32Array(1024);

  /** Must run synchronously inside a user gesture (iOS). */
  constructor() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctx();
    void this.context.resume().catch(() => undefined);

    this.output = new Audio();
    this.output.autoplay = true;
    this.output.setAttribute("playsinline", "");
    // Playing something now, inside the gesture, lets later play() calls with the
    // WebRTC stream succeed without another tap.
    this.output.src = SILENT_WAV;
    void this.output.play().catch(() => undefined);
  }

  get stream(): MediaStream | null {
    return this.mic;
  }

  get micTrack(): MediaStreamTrack | null {
    return this.mic?.getAudioTracks()[0] ?? null;
  }

  get micAlive(): boolean {
    return this.micTrack?.readyState === "live";
  }

  /** Asks for the mic once per trip; rejects with the browser's DOMException on denial. */
  async openMic(): Promise<MediaStream> {
    if (this.mic && this.micAlive) return this.mic;
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("getUserMedia unavailable", "NotSupportedError");
    // Re-opening after iOS killed the track: drop the dead capture graph first.
    this.worklet?.disconnect();
    this.worklet = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });

    await this.context.audioWorklet.addModule(PCM_WORKLET_PATH);
    const source = this.context.createMediaStreamSource(this.mic);
    this.worklet = new AudioWorkletNode(this.context, "pcm-frame-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { frameLength: 512 },
    });
    this.worklet.port.onmessage = (event: MessageEvent<Int16Array>) => this.frameSink?.(event.data);
    // Keep the worklet pulled by the graph without making any sound.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(this.worklet).connect(mute).connect(this.context.destination);
    return this.mic;
  }

  /** Routes 16 kHz Int16 frames to `sink` (Porcupine) or stops posting them when null. */
  setFrameSink(sink: ((frame: Int16Array) => void) | null, frameLength?: number): void {
    this.frameSink = sink;
    if (!this.worklet) return;
    if (frameLength) this.worklet.port.postMessage({ command: "configure", frameLength });
    this.worklet.port.postMessage({ command: sink ? "enable" : "disable" });
  }

  /** Plays the assistant's WebRTC audio and measures its level for silence detection. */
  attachRemote(stream: MediaStream): void {
    this.output.srcObject = stream;
    void this.output.play().catch((err) => console.warn("[voice] remote audio play() rejected", err));
    this.remoteSource?.disconnect();
    try {
      this.remoteSource = this.context.createMediaStreamSource(stream);
      this.remoteAnalyser = this.context.createAnalyser();
      this.remoteAnalyser.fftSize = this.levelBuffer.length;
      this.remoteSource.connect(this.remoteAnalyser);
    } catch (err) {
      console.warn("[voice] cannot analyse remote audio; relying on transcripts", err);
      this.remoteAnalyser = null;
    }
  }

  detachRemote(): void {
    this.remoteSource?.disconnect();
    this.remoteSource = null;
    this.remoteAnalyser = null;
    this.output.srcObject = null;
  }

  /** RMS (0..1) of the assistant's audio right now; 0 when unknown. */
  remoteLevel(): number {
    if (!this.remoteAnalyser) return 0;
    this.remoteAnalyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) sum += v * v;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  /** Short tone: rising when Finn starts listening, falling when it stops. */
  earcon(kind: "ready" | "closed"): void {
    const ctx = this.context;
    if (ctx.state !== "running") return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    const [from, to] = kind === "ready" ? [660, 990] : [660, 440];
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.linearRampToValueAtTime(to, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume().catch(() => undefined);
  }

  release(): void {
    this.frameSink = null;
    this.worklet?.port.postMessage({ command: "disable" });
    this.worklet?.disconnect();
    this.worklet = null;
    this.detachRemote();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    void this.context.close().catch(() => undefined);
  }
}

/** 10 ms of 8 kHz silence as a WAV data URI, used to unlock media playback on iOS. */
const SILENT_WAV = (() => {
  const samples = 80;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(binary)}`;
})();
