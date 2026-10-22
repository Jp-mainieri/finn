import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorResponse } from "@/lib/contracts/client-events";
import type { AudioIO } from "./audio-io";
import { DelegationHandler } from "./delegation-handler";
import type { OrchestratorClient, OrchestratorResult } from "./orchestrator-client";
import { SttTtsVoiceSession } from "./stt-tts-session";
import { TranscriptBuffer } from "./transcript-buffer";

describe("SttTtsVoiceSession + TranscriptBuffer + DelegationHandler integration", () => {
  let transcripts: TranscriptBuffer;
  let orchestratorMock: { send: ReturnType<typeof vi.fn> };
  let delegationHandler: DelegationHandler;
  let mockAudio: {
    frameSink: ((frame: Int16Array) => void) | null;
    setSessionFrameSink: (sink: ((frame: Int16Array) => void) | null) => void;
    output: HTMLAudioElement;
  };
  const fetchMock = vi.fn<typeof fetch>();
  let spokenReplies: Array<{ id: string | null; text: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    spokenReplies = [];

    transcripts = new TranscriptBuffer();

    orchestratorMock = {
      send: vi.fn(),
    };

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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("processes speech into transcript, feeds buffer, triggers delegation and speaks response", async () => {
    const activeSession: { current: SttTtsVoiceSession | null } = { current: null };

    delegationHandler = new DelegationHandler({
      transcripts,
      orchestrator: orchestratorMock as unknown as OrchestratorClient,
      speak: (id, text) => {
        spokenReplies.push({ id, text });
        activeSession.current?.speak(id, text);
      },
    });

    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "test-token",
      getTtsMode: () => "native",
      handlers: {
        onUserTranscript: (fragment) => {
          if (fragment.delta && fragment.delta !== "…") transcripts.add(fragment);
        },
        onAssistantTranscript: vi.fn(),
        onDelegation: (delegation) => void delegationHandler.handle(delegation),
        onRemoteStream: vi.fn(),
        onClosed: vi.fn(),
        onError: vi.fn(),
      },
      fetchImpl: fetchMock,
    });
    activeSession.current = session;

    await session.connect();

    // 1. Mock orchestrator answer
    const fakeResponse: OrchestratorResponse = {
      speech: "Tocando Capital Inicial.",
      clientActions: [],
      results: [
        {
          agent: "spotify",
          status: "completed",
          speech: "Tocando Capital Inicial.",
          clientActions: [],
          toolCalls: [],
        },
      ],
    };
    orchestratorMock.send.mockResolvedValueOnce({
      ok: true,
      response: fakeResponse,
    } as OrchestratorResult);

    // 2. Mock STT transcription response
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Toca Capital Inicial", provider: "groq" }, { status: 200 }),
    );

    // 3. Feed speech frames (RMS ~ 0.06 > 0.018 threshold)
    const speechFrame = new Int16Array(512).fill(2000);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(speechFrame);
    }

    // 4. Feed silence frames to trigger VAD_SILENCE_MS (900ms)
    const silenceFrame = new Int16Array(512);
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(silenceFrame);
    }

    // Run async tasks (fetch transcribe, delegation settle sleep, orchestrator call)
    await vi.runAllTimersAsync();

    // Verify STT fetch was called
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify orchestrator received exact reconstructed text from TranscriptBuffer
    expect(orchestratorMock.send).toHaveBeenCalledTimes(1);
    expect(orchestratorMock.send).toHaveBeenCalledWith("Toca Capital Inicial");

    // Verify speech was returned to driver
    expect(spokenReplies).toEqual([
      { id: "turn_1", text: "Tocando Capital Inicial." },
    ]);

    // Verify TranscriptBuffer was drained
    expect(transcripts.peek()).toBe("");

    await session.close();
    expect(mockAudio.frameSink).toBeNull();
  });

  it("handles multi-turn conversations cleanly without mixing transcripts", async () => {
    const activeSession: { current: SttTtsVoiceSession | null } = { current: null };

    delegationHandler = new DelegationHandler({
      transcripts,
      orchestrator: orchestratorMock as unknown as OrchestratorClient,
      speak: (id, text) => {
        spokenReplies.push({ id, text });
        activeSession.current?.speak(id, text);
      },
    });

    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "test-token",
      getTtsMode: () => "native",
      handlers: {
        onUserTranscript: (fragment) => {
          if (fragment.delta && fragment.delta !== "…") transcripts.add(fragment);
        },
        onAssistantTranscript: vi.fn(),
        onDelegation: (delegation) => void delegationHandler.handle(delegation),
        onRemoteStream: vi.fn(),
        onClosed: vi.fn(),
        onError: vi.fn(),
      },
      fetchImpl: fetchMock,
    });
    activeSession.current = session;

    await session.connect();

    // TURN 1: "Me leva pra casa"
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Me leva pra casa", provider: "groq" }, { status: 200 }),
    );
    orchestratorMock.send.mockResolvedValueOnce({
      ok: true,
      response: {
        speech: "Navegando para casa.",
        clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=casa" }],
        results: [],
      },
    } as OrchestratorResult);

    const speechFrame = new Int16Array(512).fill(2000);
    const silenceFrame = new Int16Array(512);

    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(speechFrame);
    }
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(silenceFrame);
    }
    await vi.runAllTimersAsync();

    expect(orchestratorMock.send).toHaveBeenNthCalledWith(1, "Me leva pra casa");
    expect(transcripts.peek()).toBe("");

    // TURN 2: "Pausa o som"
    fetchMock.mockResolvedValueOnce(
      Response.json({ text: "Pausa o som", provider: "groq" }, { status: 200 }),
    );
    orchestratorMock.send.mockResolvedValueOnce({
      ok: true,
      response: {
        speech: "Música pausada.",
        clientActions: [],
        results: [],
      },
    } as OrchestratorResult);

    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(speechFrame);
    }
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(32);
      session.processFrame(silenceFrame);
    }
    await vi.runAllTimersAsync();

    expect(orchestratorMock.send).toHaveBeenNthCalledWith(2, "Pausa o som");
    expect(transcripts.peek()).toBe("");

    expect(spokenReplies).toEqual([
      { id: "turn_1", text: "Navegando para casa." },
      { id: "turn_2", text: "Música pausada." },
    ]);

    await session.close();
  });

  it("supports user barge-in during speech synthesis", async () => {
    const originalWindow = global.window;
    const cancelMock = vi.fn();
    (global as unknown as { window: unknown }).window = {
      speechSynthesis: {
        speak: vi.fn(),
        cancel: cancelMock,
        getVoices: () => [],
      },
    };
    (global as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      lang = "";
      rate = 1;
      voice = null;
      onend = null;
      onerror = null;
      constructor(public text: string) {}
    };

    const activeSession: { current: SttTtsVoiceSession | null } = { current: null };

    delegationHandler = new DelegationHandler({
      transcripts,
      orchestrator: orchestratorMock as unknown as OrchestratorClient,
      speak: (id, text) => {
        spokenReplies.push({ id, text });
        activeSession.current?.speak(id, text);
      },
    });

    const session = new SttTtsVoiceSession({
      audio: mockAudio as unknown as AudioIO,
      getToken: () => "test-token",
      getTtsMode: () => "native",
      handlers: {
        onUserTranscript: (fragment) => {
          if (fragment.delta && fragment.delta !== "…") transcripts.add(fragment);
        },
        onAssistantTranscript: vi.fn(),
        onDelegation: (delegation) => void delegationHandler.handle(delegation),
        onRemoteStream: vi.fn(),
        onClosed: vi.fn(),
        onError: vi.fn(),
      },
      fetchImpl: fetchMock,
    });
    activeSession.current = session;

    await session.connect();

    // Start assistant speaking
    session.speak("turn_1", "Esta é uma resposta longa sendo falada pelo Finn.");
    expect(session.isSpeaking()).toBe(true);

    // User interrupts with loud speech frame (> 0.08 RMS -> frame value ~ 3000)
    const loudFrame = new Int16Array(512).fill(3000);
    session.processFrame(loudFrame);

    // Assistant speaking should immediately stop (barge-in)
    expect(session.isSpeaking()).toBe(false);
    expect(cancelMock).toHaveBeenCalled();

    await session.close();
    expect(mockAudio.frameSink).toBeNull();

    global.window = originalWindow;
  });
});
