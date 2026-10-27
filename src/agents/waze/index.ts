import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent, AgentResult } from "@/lib/contracts/a2a";
import { WAZE_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";
import { getAddressBook } from "@/lib/waze/address-book";
import { wazeAgentCard } from "./card";
import { buildSystemPrompt } from "./prompt";
import { createNavigateTo, parseContinuation } from "./tools";

export const WAZE_KEYWORDS: readonly RegExp[] = [
  // "vai pra próxima" is a music skip, not navigation.
  /\b(vai|vamos|ir|quero ir) (pra|para|pro|ao|a|ate|no|na|em)\b(?! (a )?proxima)/,
  /\b(me leva|leva (pra|para|pro)|levar)\b/,
  /\b(navega|navegar|navegacao|waze|gps|mapa|maps)\b/,
  /\b(chegar|chego) (em|no|na|ao|a|ate)\b/,
  /\b(rota|destino|caminho|trajeto|direcao|transito)\b/,
  /\b(endereco|rua|avenida|av|alameda|rodovia|estrada|travessa)\b/,
  /\b(abre|abrir|coloca|colocar|bota|botar|inicia|iniciar)?\s*(o\s+)?(waze|gps|navegacao)\b/,
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

export function extractWazeDestination(transcript: string, continuation?: unknown): string | null {
  const cont = parseContinuation(continuation);
  const clean = transcript.trim().replace(/[.!?]+$/, "");
  if (!clean) return null;
  if (cont) return clean;

  const isGenericOpen = /^(abre|abrir|coloca|coloque|bota|bote|inicia|iniciar)?\s*(o\s+)?(waze|gps|mapa|maps|navegacao)$/i.test(clean);
  if (isGenericOpen) {
    return "";
  }

  const match = clean.match(
    /(?:me leva|leva|vai|vamos|ir|quero ir|navega|navegar|rota para|rota pra|rota pro|destino|caminho para|caminho pra|chegar)\s+(?:para\s+o|para\s+a|para|pra\s+o|pra\s+a|pra|pro|ao|a|ate\s+o|ate\s+a|ate|em|no|na)\s+(.+)/i,
  );
  if (match && match[1]) {
    return match[1].replace(/\s+no\s+waze$/i, "").trim();
  }

  const wazeMatch = clean.match(/(?:waze|gps|rota|destino)\s+(?:para\s+|pra\s+|pro\s+|na\s+|no\s+)?(.+)/i);
  if (wazeMatch && wazeMatch[1]) {
    return wazeMatch[1].trim();
  }

  const addrMatch = clean.match(/^(?:o\s+)?(?:endereco|endereço)\s+(?:e\s+|de\s+|da\s+|do\s+|para\s+|pra\s+)?(.+)/i);
  if (addrMatch && addrMatch[1]) {
    return addrMatch[1].trim();
  }

  const lower = clean.toLowerCase();
  if (lower.includes("casa")) return "casa";
  if (lower.includes("trabalho")) return "trabalho";
  return clean;
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
    // The book belongs to input.driverId (server-proven). driverContext.savedAddresses is ignored.
    const book = getAddressBook(input.driverId);
    const navigateTo = createNavigateTo(book, continuation);
    const result = await runToolLoop({
      agent: "waze",
      client: getNeuralakeClient(),
      systemPrompt: buildSystemPrompt(continuation),
      tools: WAZE_TOOLS,
      executors: { navigate_to: navigateTo },
      input,
      fallbackErrorSpeech: "Não consegui definir a rota agora.",
      fastSpeech: wazeFastSpeech,
      deterministicFallback: async (taskInput) => {
        const destination = extractWazeDestination(taskInput.transcript, taskInput.continuation);
        if (!destination) return null;
        const out = await navigateTo({ destination }, taskInput);
        const inputRequired = Boolean(out.inputRequired) || out.continuation !== undefined;
        const partial: AgentResult = {
          agent: "waze",
          status: inputRequired ? "input-required" : "completed",
          speech: "",
          clientActions: out.clientActions ?? [],
          toolCalls: [{ name: "navigate_to", arguments: { destination }, result: out.result, ok: true }],
          ...(inputRequired && out.continuation !== undefined ? { continuation: out.continuation } : {}),
        };
        const speech = wazeFastSpeech("navigate_to", out.result) || fallbackSpeech(partial) || `Abrindo o Waze para ${destination}.`;
        return { ...partial, speech };
      },
    });
    return result.speech || result.status === "failed"
      ? result
      : { ...result, speech: fallbackSpeech(result) };
  },
};
