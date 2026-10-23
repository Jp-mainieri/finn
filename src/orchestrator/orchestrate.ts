import {
  AGENT_IDS,
  type Agent,
  type AgentId,
  type AgentResult,
  type Continuation,
  type DriverContext,
} from "@/lib/contracts/a2a";
import type { OrchestratorResponse } from "@/lib/contracts/client-events";
import { getNeuralakeClient } from "@/lib/neuralake/client";
import { classify } from "./classify";

export const AGENT_TIMEOUT_MS = 8000;

const FAILURE_SPEECH: Record<AgentId, string> = {
  spotify: "Não consegui mexer na música agora.",
  waze: "Não consegui abrir a navegação agora.",
};

const NO_MATCH_SPEECH = "Posso tocar música ou te levar a algum lugar. O que você quer?";

export interface OrchestrateOptions {
  agents: Record<AgentId, Agent>;
  contextId: string;
  /** Echoed from the previous turn: its agent gets this turn even without a keyword match. */
  continuation?: Continuation;
  timeoutMs?: number;
  driverContext?: DriverContext;
}

/** Runs one agent with a time budget; never rejects. */
async function runAgent(
  agent: Agent,
  transcript: string,
  contextId: string,
  timeoutMs: number,
  continuation: unknown,
  driverContext?: DriverContext,
): Promise<AgentResult> {
  const controller = new AbortController();
  const failed = (): AgentResult => ({
    agent: agent.id,
    status: "failed",
    speech: agent.failureSpeech ?? FAILURE_SPEECH[agent.id] ?? "Não consegui fazer isso agora.",
    clientActions: [],
    toolCalls: [],
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AgentResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      console.warn(`[orchestrator] ${agent.id} timed out after ${timeoutMs}ms`);
      resolve(failed());
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      agent.handle({ transcript, contextId, signal: controller.signal, continuation, driverContext }),
      timeout,
    ]);
  } catch (err) {
    console.error(`[orchestrator] ${agent.id} threw`, err);
    return failed();
  } finally {
    clearTimeout(timer);
  }
}

/** Joins agent sentences into one confirmation, without extra LLM calls. */
export function aggregate(results: AgentResult[]): OrchestratorResponse {
  const sentences = results
    .map((r) => r.speech.trim())
    .filter(Boolean)
    .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`));
  const pending = results.find(
    (r) => r.status === "input-required" && r.continuation !== undefined,
  );
  return {
    speech: sentences.join(" ") || NO_MATCH_SPEECH,
    clientActions: results.flatMap((r) => r.clientActions),
    results,
    ...(pending ? { continuation: { agent: pending.agent, state: pending.continuation } } : {}),
  };
}

/**
 * Triage router: classify → fan-out in parallel to every matched agent with the
 * full transcript (each agent ignores what isn't its domain) → aggregate.
 * An agent with a pending continuation always gets the turn (the driver's
 * answer, e.g. an address, usually has no routing keyword).
 */
export async function orchestrate(
  transcript: string,
  { agents, contextId, continuation, timeoutMs = AGENT_TIMEOUT_MS, driverContext }: OrchestrateOptions,
): Promise<OrchestratorResponse> {
  if (transcript === "__GREETING__") {
    try {
      const client = getNeuralakeClient();
      const { message } = await client.complete({
        messages: [
          {
            role: "system",
            content:
              "Você é o Finn, copiloto de voz automotivo em português do Brasil. Cumprimente o motorista em uma frase curta e simpática (ex: 'Bom dia! Aqui é o Finn, conectado pela Neuralake. Para onde vamos ou o que quer ouvir hoje?').",
          },
          { role: "user", content: "Dê um bom dia curto ao motorista que acabou de ligar o carro." },
        ],
        memoryScope: "finn-greeting",
      });
      const speech =
        message.content?.trim() ||
        "Bom dia! Aqui é o Finn, conectado pela Neuralake. Para onde vamos hoje?";
      return { speech, clientActions: [], results: [] };
    } catch (err) {
      console.error("[orchestrator] greeting Neuralake call failed", err);
      return {
        speech: "Bom dia! Aqui é o Finn. O áudio está funcionando, mas não consegui conectar na Neuralake agora.",
        clientActions: [],
        results: [],
      };
    }
  }

  const matched = new Set(classify(transcript, agents));
  // A turn that clearly belongs only to other domains means the driver changed
  // topic ("toca rock" while waze waits for an address): drop the continuation.
  const changedTopic = matched.size > 0 && !!continuation && !matched.has(continuation.agent);
  const resumed =
    continuation && AGENT_IDS.includes(continuation.agent) && !changedTopic ? continuation : undefined;
  if (resumed) matched.add(resumed.agent);
  const targets = AGENT_IDS.filter((id) => matched.has(id));

  const results = await Promise.all(
    targets.map((id) =>
      runAgent(
        agents[id],
        transcript,
        contextId,
        timeoutMs,
        resumed?.agent === id ? resumed.state : undefined,
        driverContext,
      ),
    ),
  );
  return aggregate(results);
}
