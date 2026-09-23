/**
 * Minimal A2A (agent-to-agent) contract.
 *
 * Wire format follows the A2A JSON-RPC shape (`message/send` → Task with
 * artifacts). Agents are hosted in this same Next.js app, so the orchestrator
 * calls `Agent.handle()` in-process (no network hop); the HTTP endpoint at
 * /api/agents/[agent] wraps the exact same handler for external A2A callers.
 */

import type { ClientAction } from "./client-events";

export type AgentId = "spotify" | "waze";

export const AGENT_IDS: readonly AgentId[] = ["spotify", "waze"] as const;

// ---------------------------------------------------------------------------
// In-process contract (what each agent implements)
// ---------------------------------------------------------------------------

export interface AgentTaskInput {
  /** Full driver transcript for the turn. Agents ignore parts outside their domain. */
  transcript: string;
  /** Conversation window id (A2A contextId). */
  contextId: string;
  /** Aborted by the orchestrator when the agent exceeds its time budget. */
  signal?: AbortSignal;
}

/**
 * - completed:      action done (or info returned), `speech` confirms it
 * - input-required: agent needs more info from the driver (e.g. full address)
 * - failed:         execution failed, `speech` is a short non-technical apology
 */
export type TaskState = "completed" | "input-required" | "failed";

export interface ToolInvocation {
  name: string;
  arguments: Record<string, unknown>;
  /** JSON-serializable tool output (or error summary). */
  result: unknown;
  ok: boolean;
}

/** Structured result the orchestrator aggregates without an LLM call. */
export interface AgentResult {
  agent: AgentId;
  status: TaskState;
  /** Short spoken sentence in pt-BR, no technical details. */
  speech: string;
  clientActions: ClientAction[];
  toolCalls: ToolInvocation[];
}

export interface Agent {
  id: AgentId;
  card(baseUrl: string): AgentCard;
  handle(input: AgentTaskInput): Promise<AgentResult>;
}

// ---------------------------------------------------------------------------
// Agent Card (served at /agents/<id>/.well-known/agent.json)
// ---------------------------------------------------------------------------

export interface AgentSkill {
  /** One skill per exposed tool; id = tool name. */
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  /** Absolute URL of the A2A task endpoint. */
  url: string;
  version: string;
  protocolVersion: string;
  preferredTransport: "JSONRPC";
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

// ---------------------------------------------------------------------------
// Wire format (JSON-RPC 2.0, method "message/send")
// ---------------------------------------------------------------------------

export interface A2ATextPart {
  kind: "text";
  text: string;
}

export interface A2ADataPart<T = unknown> {
  kind: "data";
  data: T;
}

export type A2APart = A2ATextPart | A2ADataPart;

export interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2APart[];
  contextId?: string;
}

export interface A2ASendRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "message/send";
  params: { message: A2AMessage };
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; message?: A2AMessage };
  artifacts: {
    artifactId: string;
    name: "result";
    parts: [A2ADataPart<AgentResult>];
  }[];
}

export interface A2AError {
  code: number;
  message: string;
}

export interface A2AResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: A2ATask;
  error?: A2AError;
}
