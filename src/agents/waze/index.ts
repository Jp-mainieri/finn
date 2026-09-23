import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent, AgentResult } from "@/lib/contracts/a2a";
import { WAZE_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";
import { getAddressBook } from "@/lib/waze/address-book";
import { wazeAgentCard } from "./card";
import { buildSystemPrompt } from "./prompt";
import { createNavigateTo, parseContinuation } from "./tools";

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

  card: wazeAgentCard,

  handle: async (input) => {
    const continuation = parseContinuation(input.continuation);
    const result = await runToolLoop({
      agent: "waze",
      client: getNeuralakeClient(),
      systemPrompt: buildSystemPrompt(continuation),
      tools: WAZE_TOOLS,
      executors: { navigate_to: createNavigateTo(getAddressBook(), continuation) },
      input,
      fallbackErrorSpeech: "Não consegui definir a rota agora.",
    });
    return result.speech || result.status === "failed"
      ? result
      : { ...result, speech: fallbackSpeech(result) };
  },
};
