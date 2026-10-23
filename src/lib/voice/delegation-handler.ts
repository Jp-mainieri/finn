import type { OrchestratorResponse } from "@/lib/contracts/client-events";
import { DELEGATION_SETTLE_MS, DELEGATION_TRANSCRIPT_WAIT_MS } from "./config";
import type { OrchestratorClient, OrchestratorFailure } from "./orchestrator-client";
import type { TranscriptBuffer } from "./transcript-buffer";
import type { Delegation } from "./voice-session";

/** Spoken via the voice layer when something goes wrong (GPT-Live paraphrases them). */
export const SPEECH = {
  notUnderstood: "Não entendi o pedido. Pode repetir?",
  unavailable: "Não consegui falar com o servidor agora. Tenta de novo daqui a pouco.",
  unauthorized: "Meu acesso ao servidor foi recusado. Quando estiver parado, configure o token de novo na tela.",
} as const;

export interface DelegationHandlerDeps {
  transcripts: TranscriptBuffer;
  orchestrator: OrchestratorClient;
  /** Hands text to the voice layer to be spoken for this delegation. */
  speak: (delegationId: string, text: string) => void;
  onWorkStarted?: () => void;
  onWorkFinished?: () => void;
  onTurn?: (turn: { transcript: string; response: OrchestratorResponse }) => void;
  onFailure?: (failure: OrchestratorFailure, transcript: string) => void;
}

/**
 * Turns a GPT-Live client delegation into one orchestrator call:
 * rebuild the driver's words from the transcript, POST them, speak `speech`.
 * Delegations are handled one at a time so each turn sees the previous turn's
 * `continuation`.
 */
export class DelegationHandler {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DelegationHandlerDeps) {}

  handle(delegation: Delegation): Promise<void> {
    this.deps.onWorkStarted?.();
    const run = this.queue.then(() => this.process(delegation));
    this.queue = run.catch(() => undefined);
    return run.finally(() => this.deps.onWorkFinished?.());
  }

  private async process({ id, offsetMs }: Delegation): Promise<void> {
    const transcript = await this.collectTranscript(offsetMs);
    if (!transcript) {
      this.deps.transcripts.clear();
      this.deps.speak(id, SPEECH.notUnderstood);
      return;
    }

    const result = await this.deps.orchestrator.send(transcript);
    if (result.ok) {
      this.deps.speak(id, result.response.speech);
      this.deps.onTurn?.({ transcript, response: result.response });
      return;
    }

    console.warn("[voice] orchestrator failed", result.failure, result.status);
    this.deps.speak(id, result.failure === "unauthorized" ? SPEECH.unauthorized : SPEECH.unavailable);
    this.deps.onFailure?.(result.failure, transcript);
  }

  /** Fragments can land just after the delegation event; give them a moment. */
  private async collectTranscript(offsetMs: number): Promise<string> {
    const { transcripts } = this.deps;
    await sleep(DELEGATION_SETTLE_MS);
    let waited = DELEGATION_SETTLE_MS;
    while (!transcripts.hasTextBefore(offsetMs) && waited < DELEGATION_TRANSCRIPT_WAIT_MS) {
      await sleep(100);
      waited += 100;
    }
    const transcript = transcripts.takeUntil(offsetMs);
    if (!transcript && transcripts.peek()) {
      // If takeUntil(offsetMs) missed because fragments started at or after offsetMs
      // (due to timestamp jitter or STT completion after delegation cutoff),
      // consume all pending fragments so the utterance is not lost or left to corrupt the next turn.
      const fallback = transcripts.peek();
      transcripts.clear();
      return fallback;
    }
    return transcript;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
