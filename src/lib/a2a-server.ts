import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { boundedContinuation } from "@/lib/continuation";
import type {
  A2AMessage,
  A2AResponse,
  A2ASendRequest,
  A2ATask,
  Agent,
  AgentCard,
  AgentSkill,
} from "@/lib/contracts/a2a";

export const A2A_PROTOCOL_VERSION = "0.3.0";

/** Absolute base URL of the current deployment, derived from the request. */
export function baseUrlFrom(request: Request): string {
  return new URL(request.url).origin;
}

export function buildAgentCard(fields: {
  name: string;
  description: string;
  url: string;
  skills: AgentSkill[];
}): AgentCard {
  return {
    ...fields,
    version: "0.1.0",
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
  };
}

function rpcError(id: A2AResponse["id"], code: number, message: string): A2AResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** JSON-RPC `message/send` handler wrapping an in-process Agent. */
export async function handleA2ARequest(agent: Agent, request: Request): Promise<A2AResponse> {
  let body: A2ASendRequest;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (body?.jsonrpc !== "2.0" || body.method !== "message/send") {
    return rpcError(body?.id ?? null, -32601, "Method not found");
  }

  const message = body.params?.message;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const transcript = parts
    .filter((p) => p?.kind === "text" && typeof p.text === "string")
    .map((p) => (p as { text: string }).text)
    .join(" ")
    .trim();
  if (!transcript) return rpcError(body.id, -32602, "Invalid params: message needs a text part");

  // A follow-up to an `input-required` task carries the agent's state as { continuation } in a data part.
  // Untrusted and unsigned: at most 2 KB here, then parsed strictly by the agent (unknown shapes ignored).
  // It never carries a driverId: the id is fixed below.
  const continuation = boundedContinuation(
    parts
      .filter((p) => p?.kind === "data")
      .map((p) => (p.data as { continuation?: unknown } | null)?.continuation)
      .find((c) => c !== undefined),
  );

  const contextId =
    typeof message?.contextId === "string" && message.contextId.length > 0 && message.contextId.length <= 128
      ? message.contextId
      : crypto.randomUUID();
  // FINN_A2A_TOKEN is the OWNER's credential: A2A always runs as the owner, explicitly. The id is
  // fixed here and never read from the body.
  const result = await agent.handle({ transcript, contextId, continuation, driverId: LEGACY_OWNER_DRIVER_ID });

  const reply: A2AMessage = {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "agent",
    contextId,
    parts: [{ kind: "text", text: result.speech }],
  };
  const task: A2ATask = {
    kind: "task",
    id: crypto.randomUUID(),
    contextId,
    status: { state: result.status, message: reply },
    artifacts: [
      {
        artifactId: crypto.randomUUID(),
        name: "result",
        // Only these three fields leave the server (see A2APublicResult).
        parts: [{ kind: "data", data: { agent: result.agent, status: result.status, speech: result.speech } }],
      },
    ],
  };
  return { jsonrpc: "2.0", id: body.id, result: task };
}
