/**
 * Scripted stand-in for Neuralake. Test files wire it in with:
 *
 *   vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
 *     getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
 *   }));
 *
 * One stable instance (on globalThis) is returned for the whole run, so it
 * still works if an agent caches the client at module load. Each test sets
 * `llm.scripts.<agent>`; both agents may hit it concurrently (UC7), so calls
 * are routed by `memoryScope` ("finn-spotify" / "finn-waze"), falling back to
 * the tools offered.
 */
import type { AgentId } from "@/lib/contracts/a2a";
import type {
  AssistantMessage,
  CompletionRequest,
  CompletionResponse,
  NeuralakeClient,
} from "@/lib/contracts/neuralake";
import { MockNeuralakeClient, textMessage, toolCallMessage } from "@/lib/neuralake/mock";
import { mark } from "./timeline";

export { textMessage as say, toolCallMessage as call };

export type Turn = AssistantMessage | ((req: CompletionRequest) => AssistantMessage);

export interface AgentScript {
  /** Model reply per round-trip within one turn; past the end the model says "Pronto.". */
  turns: Turn[];
  /** Latency added to every model call of this agent. */
  delayMs?: number;
  /** Never answer until the request is aborted (simulates a hung model). */
  hang?: boolean;
  /** Reject every call with this error (simulates Neuralake being down). */
  fail?: Error;
}

const SPOTIFY_TOOL_NAMES = ["play_playlist", "toggle_playback", "list_playlists"];

export function agentOf(req: CompletionRequest): AgentId | undefined {
  if (req.memoryScope === "finn-spotify") return "spotify";
  if (req.memoryScope === "finn-waze") return "waze";
  const names = req.tools?.map((t) => t.function.name) ?? [];
  if (names.includes("navigate_to")) return "waze";
  if (names.some((n) => SPOTIFY_TOOL_NAMES.includes(n))) return "spotify";
  return undefined;
}

/** Round-trip index within the current turn = assistant messages already in the history. */
export function stepOf(req: CompletionRequest): number {
  return req.messages.filter((m) => m.role === "assistant").length;
}

/** Parsed content of the most recent tool message (what the executor returned). */
export function lastToolResult<T = unknown>(req: CompletionRequest): T | undefined {
  const tool = [...req.messages].reverse().find((m) => m.role === "tool");
  return tool && tool.role === "tool" ? (JSON.parse(tool.content) as T) : undefined;
}

/** Raw contents of every tool message in the request (what the model was fed). */
export function toolMessages(req: CompletionRequest | undefined): string[] {
  return (req?.messages ?? []).flatMap((m) => (m.role === "tool" ? [m.content] : []));
}

export function userMessage(req: CompletionRequest): string | undefined {
  const user = req.messages.find((m) => m.role === "user");
  return user?.role === "user" ? user.content : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    });
  });
}

export class ScriptedNeuralake implements NeuralakeClient {
  scripts: Partial<Record<AgentId, AgentScript>> = {};
  private readonly mock = new MockNeuralakeClient((req) => this.decide(req));
  private readonly snapshots: CompletionRequest[] = [];

  /**
   * Every request received, in arrival order, as it was AT CALL TIME. (The
   * runtime keeps mutating the same `messages` array after the call, so
   * `MockNeuralakeClient.calls` would show later messages too.)
   */
  get calls(): CompletionRequest[] {
    return this.snapshots;
  }

  callsFor(agent: AgentId): CompletionRequest[] {
    return this.calls.filter((r) => agentOf(r) === agent);
  }

  reset(): void {
    this.scripts = {};
    this.snapshots.length = 0;
    this.mock.calls.length = 0;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const agent = agentOf(req);
    const script = agent ? this.scripts[agent] : undefined;
    this.snapshots.push({ ...req, messages: structuredClone(req.messages) });
    mark(`llm:${agent ?? "unknown"}:start`);
    try {
      if (script?.fail) throw script.fail;
      // Longest delay setTimeout accepts; only an abort (orchestrator timeout) ends it.
      if (script?.hang) await sleep(2 ** 31 - 1, req.signal);
      if (script?.delayMs) await sleep(script.delayMs, req.signal);
      // Scripts run here, at call time, so `req.messages` is still the live history of this step.
      return await this.mock.complete(req);
    } finally {
      mark(`llm:${agent ?? "unknown"}:end`);
    }
  }

  private decide(req: CompletionRequest): AssistantMessage {
    const agent = agentOf(req);
    const script = agent ? this.scripts[agent] : undefined;
    if (!script) {
      // Surfaces as a `failed` result for that agent; tests assert on it.
      throw new Error(`Unexpected model call for agent "${agent ?? "?"}" (no script set)`);
    }
    const turn = script.turns[stepOf(req)];
    if (!turn) return textMessage("Pronto.");
    return typeof turn === "function" ? turn(req) : turn;
  }
}

const g = globalThis as { __finnScriptedLlm?: ScriptedNeuralake };
export const llm: ScriptedNeuralake = (g.__finnScriptedLlm ??= new ScriptedNeuralake());

/** Drop-in replacement for `getNeuralakeClient`. */
export function getScriptedClient(): NeuralakeClient {
  return llm;
}
