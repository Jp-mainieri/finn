import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeFrameRms,
  encodeWav16kMono,
  isSilenceHallucination,
  SttTtsVoiceSession,
  toBase64,
} from "./stt-tts-session";
import type { AudioIO } from "./audio-io";
import type { VoiceSessionHandlers } from "./voice-session";

describe("SttTtsVoiceSession utilities", () => {
  it("computes RMS of a frame accurately", () => {
    expect(computeFrameRms(new Int16Array([]))).toBe(0);
    const silence = new Int16Array(512);
    expect(computeFrameRms(silence)).toBe(0);

    const fullScale = new Int16Array(512).fill(32767);
    expect(computeFrameRms(fullScale)).toBeCloseTo(1, 1);
  });

  it("detects silence hallucinations", () => {
    expect(isSilenceHallucination("Obrigado.")).toBe(true);
    expect(isSilenceHallucination("Muito obrigado")).toBe(true);
    expect(isSilenceHallucination("Legendas pela comunidade Amara.org")).toBe(true);
    expect(isSilenceHallucination("Valeu")).toBe(true);
    expect(isSilenceHallucination("...")).toBe(true);
    expect(isSilenceHallucination("Toca rock")).toBe(false);
    expect(isSilenceHallucination("Me leva pra casa")).toBe(false);
  });

  it("encodes valid 16kHz 16-bit mono WAV with a 44-byte header", () => {
    const chunk1 = new Int16Array([0, 1000, 2000]);
    const chunk2 = new Int16Array([-1000, -2000]);
    const wav = encodeWav16kMono([chunk1, chunk2]);

    expect(wav.length).toBe(44 + 5 * 2);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    const ascii = (offset: number, len: number) =>
      Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");

    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 10);
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // Mono
    expect(view.getUint32(24, true)).toBe(16000); // Sample rate
    expect(view.getUint32(28, true)).toBe(32000); // Byte rate
    expect(view.getUint16(32, true)).toBe(2); // Block align
    expect(view.getUint16(34, true)).toBe(16); // Bits per sample
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(10); // Data length
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(1000);

    const b64 = toBase64(wav);
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);
  });
});

describe("SttTtsVoiceSession session lifecycle & VAD", () => {
  let mockAudio: {
    frameSink: ((frame: Int16Array) => void) | null;
    setSessionFrameSink: (sink: ((frame: Int16Array) => void) | null) => void;
    output: HTMLAudioElement;
  };

  let handlers: VoiceSessionHandlers;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    mockAudio = {
      frameSink: null,
      setSessionFrameSink(sink) {
        mockAudio.frameSink = sink;
      },
      output: {
        src: "",
        play: vi.fn(async () => {}),
        pause: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLAudioElement,
    };

    handlers = {
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onDelegation: vi.fn(),
      onRemoteStream: vi.fn(),
      onClosed: vi.fn(),
      onError: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects and wires the frame sink to AudioIO", async () => {
    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "test-token",
      handlers,
      fetchImpl: fetchMock,
    });

    await session.connect();
    expect(mockAudio.frameSink).toBeTypeOf("function");

    await session.close();
    expect(mockAudio.frameSink).toBeNull();
    expect(handlers.onClosed).toHaveBeenCalledWith("close_requested");
  });

  it("detects speech start, gathers utterance, transcribes, and delegates", async () => {
    vi.useFakeTimers();

    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Toca o som", provider: "groq" }, { status: 200 }),
    );

    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "s3cret",
      handlers,
      fetchImpl: fetchMock,
    });

    await session.connect();

    // 1. Send silence frames
    const silenceFrame = new Int16Array(512); // RMS = 0
    session.processFrame(silenceFrame);
    expect(handlers.onUserTranscript).not.toHaveBeenCalled();

    // 2. Send speech frames (RMS ~ 0.06 > 0.018)
    const speechFrame = new Int16Array(512).fill(2000);
    // Feed ~12 speech frames (approx 384ms of speech, > MIN_SPEECH_MS 300ms)
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(speechFrame);
    }

    // Verify onUserTranscript was called with "…" on speech start
    expect(handlers.onUserTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ delta: "…" }),
    );

    // 3. Send silence frames to trigger VAD_SILENCE_MS (900ms)
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(silenceFrame);
    }

    // Wait microtasks for async transcription
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/realtime/transcribe");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer s3cret");

    expect(handlers.onUserTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ delta: "Toca o som" }),
    );
    expect(handlers.onDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "turn_1" }),
    );

    vi.useRealTimers();
  });

  it("discards short clicks (<300ms)", async () => {
    vi.useFakeTimers();

    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "s3cret",
      handlers,
      fetchImpl: fetchMock,
    });

    await session.connect();

    // 2 speech frames = 64ms < 300ms
    const speechFrame = new Int16Array(512).fill(2000);
    session.processFrame(speechFrame);
    session.processFrame(speechFrame);

    // Silence to finish
    const silenceFrame = new Int16Array(512);
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(silenceFrame);
    }

    await vi.runAllTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("speaks reply and emits onAssistantTranscript", () => {
    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "s3cret",
      handlers,
      fetchImpl: fetchMock,
    });

    const eventId = session.speak("turn_1", "Navegando para casa.");
    expect(eventId).toMatch(/^finn_reply_\d+$/);
    expect(handlers.onAssistantTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ delta: "Navegando para casa." }),
    );
  });

  it.each([
    [429, "Muitas tentativas, tente de novo em instantes.", "Rate limited"],
    [503, "O Finn está fora do ar agora, tente de novo daqui a pouco.", "Unavailable"],
  ] as const)("a %i from transcribe is spoken locally and never calls the TTS route", async (status, line, errorMsg) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "x" }, { status }));
    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "s3cret",
      getTtsMode: () => "openai", // the networked TTS would be used by `speak`; `speakLocal` must not
      handlers,
      fetchImpl: fetchMock,
    });
    await session.connect();
    const speechFrame = new Int16Array(512).fill(2000);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(speechFrame);
    }
    const silenceFrame = new Int16Array(512);
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(silenceFrame);
    }
    await vi.runAllTimersAsync();

    expect(handlers.onAssistantTranscript).toHaveBeenCalledWith(expect.objectContaining({ delta: line }));
    expect(handlers.onError).toHaveBeenCalledWith(errorMsg);
    expect(handlers.onDelegation).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // transcribe only
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain("/api/realtime/tts");
    vi.useRealTimers();
  });

  it("a transcribe 429 with scope 'day' speaks the daily-limit line locally; 'DAY' stays generic", async () => {
    for (const [scope, line] of [
      ["day", "Você atingiu o limite de uso de hoje. Volte amanhã."],
      ["DAY", "Muitas tentativas, tente de novo em instantes."],
    ] as const) {
      vi.useFakeTimers();
      fetchMock.mockReset();
      (handlers.onAssistantTranscript as ReturnType<typeof vi.fn>).mockClear();
      fetchMock.mockResolvedValueOnce(Response.json({ error: "Too many requests", scope }, { status: 429 }));
      const session = new SttTtsVoiceSession({
        audio: mockAudio as unknown as AudioIO,
        getToken: () => "s3cret",
        getTtsMode: () => "openai",
        handlers,
        fetchImpl: fetchMock,
      });
      await session.connect();
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(32);
        session.processFrame(new Int16Array(512).fill(2000));
      }
      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(32);
        session.processFrame(new Int16Array(512));
      }
      await vi.runAllTimersAsync();
      expect(handlers.onAssistantTranscript).toHaveBeenCalledWith(expect.objectContaining({ delta: line }));
      expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain("/api/realtime/tts");
      vi.useRealTimers();
    }
  });
});
