import type { AudioIO } from "./audio-io";
import {
  MAX_UTTERANCE_MS,
  MIN_SPEECH_MS,
  TRANSCRIBE_PATH,
  TTS_PATH,
  VAD_SILENCE_MS,
  VAD_SPEECH_THRESHOLD,
} from "./config";
import type { VoiceSession, VoiceSessionHandlers } from "./voice-session";

export interface SttTtsVoiceSessionOptions {
  audio: AudioIO;
  getToken: () => string | null;
  getTtsMode?: () => "native" | "openai";
  handlers: VoiceSessionHandlers;
  fetchImpl?: typeof fetch;
}

const HALLUCINATIONS = [
  /^(muito\s+)?obrigad[oa]\b/i,
  /^(valeu|tchau|até logo|bom dia|boa tarde|boa noite)\b/i,
  /legendas?(\s+pela\s+comunidade)?/i,
  /subtitles/i,
  /^(soletre|ponto|vírgula)\.?$/i,
  /^[\s.,!?…\-]+$/,
];

export function isSilenceHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return HALLUCINATIONS.some((pattern) => pattern.test(trimmed));
}

export function computeFrameRms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const norm = frame[i] / 32768;
    sum += norm * norm;
  }
  return Math.sqrt(sum / frame.length);
}

export function encodeWav16kMono(chunks: Int16Array[]): Uint8Array {
  let totalSamples = 0;
  for (const chunk of chunks) {
    totalSamples += chunk.length;
  }
  const dataSize = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, 16000, true); // 16kHz
  view.setUint32(28, 32000, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // 16-bit

  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class SttTtsVoiceSession implements VoiceSession {
  private connected = false;
  private closed = false;
  private speaking = false;
  private isRecording = false;
  private speechFramesCount = 0;
  private startTime = 0;
  private speechStartMs = 0;
  private lastSpeechMs = 0;
  private seq = 0;
  private turnSeq = 0;
  private preroll: Int16Array[] = [];
  private recordedChunks: Int16Array[] = [];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SttTtsVoiceSessionOptions) {
    this.fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : (() => Promise.reject()) as unknown as typeof fetch);
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("Session is already closed");
    this.connected = true;
    this.startTime = Date.now();
    this.options.audio.setSessionFrameSink((frame) => this.processFrame(frame));
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  processFrame(frame: Int16Array): void {
    if (!this.connected || this.closed) return;

    const rms = computeFrameRms(frame);

    // If assistant is currently speaking:
    // If user produces loud speech (> 0.08), barge-in: stop assistant speaking.
    // Otherwise, ignore mic to prevent echo / self-triggering.
    if (this.speaking) {
      if (rms > 0.08) {
        this.stopSpeaking();
      } else {
        return;
      }
    }

    const now = Date.now();

    if (!this.isRecording) {
      this.preroll.push(frame);
      if (this.preroll.length > 10) {
        this.preroll.shift();
      }

      if (rms > VAD_SPEECH_THRESHOLD) {
        this.isRecording = true;
        this.speechFramesCount = 1;
        this.speechStartMs = now;
        this.lastSpeechMs = now;
        this.recordedChunks = [...this.preroll, frame];
        // Signal user speech onset ("…") so UI shows voice was detected & idle timer resets
        this.options.handlers.onUserTranscript({
          delta: "…",
          startMs: this.sessionOffsetMs(),
          endMs: this.sessionOffsetMs(),
        });
      }
    } else {
      this.recordedChunks.push(frame);

      if (rms > VAD_SPEECH_THRESHOLD) {
        this.speechFramesCount += 1;
        this.lastSpeechMs = now;
      }

      const silenceDuration = now - this.lastSpeechMs;
      const totalDuration = now - this.speechStartMs;

      if (silenceDuration >= VAD_SILENCE_MS || totalDuration >= MAX_UTTERANCE_MS) {
        this.finalizeUtterance();
      }
    }
  }

  /** Manually finishes and sends the current utterance (or any captured audio) right away. */
  commitSpeech(): void {
    if (!this.connected || this.closed) return;
    if (this.isRecording && this.recordedChunks.length > 0) {
      this.speechFramesCount = Math.max(this.speechFramesCount, Math.ceil(MIN_SPEECH_MS / 32));
      this.finalizeUtterance();
    } else if (this.preroll.length > 0) {
      const chunks = [...this.preroll];
      this.preroll = [];
      void this.transcribeAndDelegate(chunks);
    }
  }

  private finalizeUtterance(): void {
    const speechFrames = this.speechFramesCount;
    this.speechFramesCount = 0;
    this.isRecording = false;
    const chunks = this.recordedChunks;
    this.recordedChunks = [];
    this.preroll = [];

    // Each frame is 512 samples at 16kHz = 32ms
    const speechDurationMs = speechFrames * 32;
    if (speechDurationMs < MIN_SPEECH_MS) {
      return; // Discard click / brief noise
    }

    void this.transcribeAndDelegate(chunks);
  }

  private async transcribeAndDelegate(chunks: Int16Array[]): Promise<void> {
    const wavBytes = encodeWav16kMono(chunks);
    const base64Audio = toBase64(wavBytes);
    const token = this.options.getToken();

    try {
      const res = await this.fetchImpl(TRANSCRIBE_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ audio: base64Audio, mimeType: "audio/wav" }),
      });

      if (this.closed) return;

      if (res.status === 401) {
        this.options.handlers.onError("Unauthorized");
        return;
      }

      if (!res.ok) {
        this.options.handlers.onError("Transcription error");
        return;
      }

      const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
      if (this.closed) return;

      const text = typeof data?.text === "string" ? data.text.trim() : "";

      if (!text || isSilenceHallucination(text)) {
        return;
      }

      const offset = this.sessionOffsetMs();
      this.options.handlers.onUserTranscript({
        delta: text,
        startMs: offset,
        endMs: offset + 100,
      });

      this.turnSeq += 1;
      this.options.handlers.onDelegation({
        id: `turn_${this.turnSeq}`,
        offsetMs: offset + 200,
      });
    } catch (err) {
      console.warn("[voice-session] STT transcribe request failed", err);
      this.options.handlers.onError("STT failed");
    }
  }

  speak(delegationId: string | null, text: string): string {
    this.seq += 1;
    const eventId = `finn_reply_${this.seq}`;

    const now = this.sessionOffsetMs();
    this.options.handlers.onAssistantTranscript({
      delta: text,
      startMs: now,
      endMs: now + 100,
    });

    const mode = this.options.getTtsMode?.() ?? "native";
    if (mode === "openai") {
      this.playOpenAiTts(text).catch(() => this.playNativeTts(text));
    } else {
      this.playNativeTts(text);
    }

    return eventId;
  }

  private async playOpenAiTts(text: string): Promise<void> {
    const token = this.options.getToken();
    const res = await this.fetchImpl(TTS_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error("TTS upstream error");

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = this.options.audio.output;

    this.speaking = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        audio.removeEventListener("ended", finish);
        audio.removeEventListener("error", finish);
        audio.removeEventListener("pause", finish);
        URL.revokeObjectURL(url);
        this.speaking = false;
        resolve();
      };
      audio.addEventListener("ended", finish, { once: true });
      audio.addEventListener("error", finish, { once: true });
      audio.addEventListener("pause", finish, { once: true });
      audio.src = url;
      void audio.play().catch(finish);
    });
  }

  private playNativeTts(text: string): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      this.speaking = false;
      return;
    }

    const synth = window.speechSynthesis;
    try {
      synth.cancel();
    } catch {
      // ignore
    }

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "pt-BR";
    utter.rate = 1.05;

    const voices = synth.getVoices?.() ?? [];
    const ptVoices = voices.filter(
      (v) => v.lang.startsWith("pt") || v.lang.startsWith("pt-BR") || v.lang.startsWith("pt_BR"),
    );
    const preferred = ptVoices.find((v) =>
      /Luciana|Felipe|Fernanda|Enhanced|Premium|Siri|Natural|Google português/i.test(v.name),
    );
    if (preferred) utter.voice = preferred;
    else if (ptVoices[0]) utter.voice = ptVoices[0];

    this.speaking = true;
    utter.onend = () => {
      this.speaking = false;
    };
    utter.onerror = () => {
      this.speaking = false;
    };

    synth.speak(utter);
  }

  private stopSpeaking(): void {
    this.speaking = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    try {
      this.options.audio.output.pause();
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopSpeaking();
    this.options.audio.setSessionFrameSink(null);
    this.options.handlers.onClosed("close_requested");
  }

  private sessionOffsetMs(): number {
    return this.startTime ? Date.now() - this.startTime : 0;
  }
}
