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

  describe("local speech for a 429 whose body is still being read", () => {
    /** Drives one utterance to the transcribe request without firing the body-read deadline. */
    async function utterance(session: SttTtsVoiceSession) {
      await session.connect();
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(32);
        session.processFrame(new Int16Array(512).fill(2000));
      }
      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(32);
        session.processFrame(new Int16Array(512));
      }
      await vi.advanceTimersByTimeAsync(10);
    }
    const slow429 = () => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (body = c) });
      return { response: new Response(stream, { status: 429 }), body };
    };
    const mk = () =>
      new SttTtsVoiceSession({
        audio: mockAudio as unknown as AudioIO,
        getToken: () => "s3cret",
        getTtsMode: () => "openai",
        handlers,
        fetchImpl: fetchMock,
      });

    afterEach(() => vi.useRealTimers());

    it("a session closed while the body is still reading says nothing and reports nothing, then or at the deadline", async () => {
      vi.useFakeTimers();
      const { response, body } = slow429();
      fetchMock.mockResolvedValueOnce(response);
      const session = mk();
      await utterance(session);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await session.close(); // sign out / hang up while the 429 body is in flight
      (handlers.onAssistantTranscript as ReturnType<typeof vi.fn>).mockClear();
      body.enqueue(new TextEncoder().encode(JSON.stringify({ scope: "day" })));
      body.close();
      await vi.advanceTimersByTimeAsync(3_000); // past the 1.5 s body deadline too

      expect(handlers.onAssistantTranscript).not.toHaveBeenCalled();
      expect(handlers.onError).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("the same when the deadline (not the body) ends the read", async () => {
      vi.useFakeTimers();
      const { response } = slow429(); // the body never ends
      fetchMock.mockResolvedValueOnce(response);
      const session = mk();
      await utterance(session);
      await session.close();
      (handlers.onAssistantTranscript as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(handlers.onAssistantTranscript).not.toHaveBeenCalled();
      expect(handlers.onError).not.toHaveBeenCalled();
    });

    it("still speaks when the session stays open and the body arrives late", async () => {
      vi.useFakeTimers();
      const { response, body } = slow429();
      fetchMock.mockResolvedValueOnce(response);
      const session = mk();
      await utterance(session);
      body.enqueue(new TextEncoder().encode(JSON.stringify({ scope: "day" })));
      body.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(handlers.onAssistantTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ delta: "Você atingiu o limite de uso de hoje. Volte amanhã." }),
      );
    });

    it("a server that answers normally is not delayed by the body deadline (no timer needs to fire)", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(Response.json({ error: "Too many requests", scope: "burst" }, { status: 429 }));
      const session = mk();
      await utterance(session); // only 10 ms of fake time after the request, far below 1.5 s
      expect(handlers.onAssistantTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ delta: "Muitas tentativas, tente de novo em instantes." }),
      );
    });
  });
});

describe("SttTtsVoiceSession.interrupt ('Parar e falar')", () => {
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const source = { buffer: null as unknown, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as null | (() => void) };
  const nativeSpeak = vi.fn();
  const fetchMock = vi.fn<typeof fetch>();
  let handlers: VoiceSessionHandlers;
  let audio: Record<string, unknown>;

  beforeEach(() => {
    fetchMock.mockReset();
    nativeSpeak.mockReset();
    source.start.mockReset();
    source.stop.mockReset();
    source.connect.mockReset().mockReturnValue({ connect: vi.fn() });
    vi.stubGlobal("window", {
      speechSynthesis: { speaking: false, cancel: vi.fn(), resume: vi.fn(), getVoices: () => [], speak: nativeSpeak },
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    audio = {
      setSessionFrameSink: vi.fn(),
      resume: async () => {},
      output: { pause: vi.fn(), play: vi.fn(async () => {}), addEventListener: vi.fn(), removeEventListener: vi.fn() },
      context: {
        decodeAudioData: async () => ({ duration: 5 }),
        createBufferSource: () => source,
        createGain: () => ({ gain: { value: 1 }, connect: vi.fn().mockReturnValue({}) }),
        destination: {},
      },
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const make = () =>
    new SttTtsVoiceSession({
      audio: audio as unknown as AudioIO,
      getToken: () => "tok",
      getTtsMode: () => "openai",
      handlers,
      fetchImpl: fetchMock,
    });

  it("stops audio that is already playing and clears the speaking flag, keeping the session open", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(8)));
    const session = make();
    await session.connect();
    session.speak(null, "Bom dia");
    await flush();
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(session.isSpeaking()).toBe(true);

    session.interrupt();
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(session.isSpeaking()).toBe(false);
    expect(handlers.onClosed).not.toHaveBeenCalled();
    expect(audio.setSessionFrameSink).not.toHaveBeenLastCalledWith(null);
  });

  it("aborts a TTS still being fetched: it never plays and the native voice does not take over", async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    const session = make();
    await session.connect();
    session.speak(null, "Bom dia");
    expect(session.isSpeaking()).toBe(true);

    session.interrupt();
    expect(session.isSpeaking()).toBe(false);
    answer(new Response(new Uint8Array(8)));
    await flush();
    expect(source.start).not.toHaveBeenCalled();
    expect(nativeSpeak).not.toHaveBeenCalled();
    expect(session.isSpeaking()).toBe(false);
  });

  it("an interrupted TTS that then fails does not fall back to the native voice", async () => {
    let fail!: (e: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((_, rej) => (fail = rej)));
    const session = make();
    await session.connect();
    session.speak(null, "Bom dia");
    session.interrupt();
    fail(new Error("network"));
    await flush();
    expect(nativeSpeak).not.toHaveBeenCalled();
  });

  it("a reply spoken after the interruption plays normally", async () => {
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(8)));
    const session = make();
    await session.connect();
    session.speak(null, "um");
    session.interrupt();
    await flush();
    source.start.mockClear();
    session.speak(null, "dois");
    await flush();
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(session.isSpeaking()).toBe(true);
  });

  it("stops native speech and does nothing on a closed session", async () => {
    const session = make();
    await session.connect();
    session.interrupt();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
    await session.close();
    expect(() => session.interrupt()).not.toThrow();
  });
});
