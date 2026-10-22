import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent, AgentResult } from "@/lib/contracts/a2a";
import { WAZE_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";
import { getAddressBook, LayeredAddressBook } from "@/lib/waze/address-book";
import { wazeAgentCard } from "./card";
import { buildSystemPrompt } from "./prompt";
import { createNavigateTo, parseContinuation } from "./tools";

export const WAZE_KEYWORDS: readonly RegExp[] = [
  // "vai pra próxima" is a music skip, not navigation.
  /\b(vai|vamos|ir|quero ir) (pra|para|pro|ao|a|ate)\b(?! (a )?proxima)/,
  /\b(me leva|leva (pra|para|pro)|levar)\b/,
  /\b(navega|navegar|navegacao|waze|gps)\b/,
  /\b(chegar|chego) (em|no|na|ao|a|ate)\b/,
  /\b(rota|destino|caminho)\b/,
];

export function wazeFastSpeech(toolName: string, result: unknown): string | null {
  if (toolName === "navigate_to" && typeof result === "object" && result !== null) {
    const res = result as Record<string, unknown>;
    if (typeof res.navigating_to === "string") {
      return `Abrindo a rota para ${res.navigating_to}.`;
    }
  }
  return null;
}

/** Something to say if the model ends the turn without text (the driver must always hear back). */
function fallbackSpeech(result: AgentResult): string {
  const pending = parseContinuation(result.continuation);
  if (pending && "pendingLabel" in pending) {
    return pending.pendingLabel === "casa"
      ? "Qual é o endereço da sua casa?"
      : "Qual é o endereço do seu trabalho?";
  }
  if (pending) return "Pra onde você quer ir?";
  if (result.clientActions.length) return "Rota definida.";
  return "";
}

export const wazeAgent: Agent = {
  id: "waze",
  keywords: WAZE_KEYWORDS,
  failureSpeech: "Não consegui abrir a navegação agora.",

  card: wazeAgentCard,

  handle: async (input) => {
    const continuation = parseContinuation(input.continuation);
    const book = input.driverContext?.savedAddresses
      ? new LayeredAddressBook(input.driverContext.savedAddresses, getAddressBook())
      : getAddressBook();
    const result = await runToolLoop({
      agent: "waze",
      client: getNeuralakeClient(),
      systemPrompt: buildSystemPrompt(continuation),
      tools: WAZE_TOOLS,
      executors: { navigate_to: createNavigateTo(book, continuation) },
      input,
      fallbackErrorSpeech: "Não consegui definir a rota agora.",
      fastSpeech: wazeFastSpeech,
    });
    return result.speech || result.status === "failed"
      ? result
      : { ...result, speech: fallbackSpeech(result) };
  },
};
