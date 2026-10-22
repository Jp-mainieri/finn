/**
 * Contract between the backend and the PWA.
 *
 * The PWA receives a delegation event from GPT-Live-1, POSTs the transcript to
 * /api/orchestrator, gets an OrchestratorResponse back, executes every
 * ClientAction locally (e.g. opens the Waze deep link) and hands `speech` back
 * to Live-1 as the delegation result so it is spoken to the driver.
 */

import type { AgentResult, Continuation, DriverContext } from "./a2a";

/** Something the backend can't do itself and the PWA must do on the phone. */
export type ClientAction = OpenUrlAction | SaveAddressAction;

export interface OpenUrlAction {
  type: "open_url";
  /** e.g. https://waze.com/ul?q=...&navigate=yes */
  url: string;
  /** Short human label for the on-screen fallback button (iOS may block auto-open). */
  label?: string;
}

export interface SaveAddressAction {
  type: "save_address";
  label: "casa" | "trabalho";
  address: string;
}

export interface OrchestratorRequest {
  transcript: string;
  /** Stable id for the current Live-1 conversation window; used as A2A contextId. */
  contextId?: string;
  /** Echo of the previous response's `continuation`, if any (within the same conversation window). */
  continuation?: Continuation;
  /** Optional per-driver context (saved addresses, Spotify token) for multi-user support. */
  driverContext?: DriverContext;
}

export interface OrchestratorResponse {
  /** Single natural-language confirmation for Live-1 to speak. */
  speech: string;
  /** Every client action from every agent, in agent order. */
  clientActions: ClientAction[];
  /** Raw per-agent results, for debugging / on-screen support UI. */
  results: AgentResult[];
  /** Present when an agent is waiting for the driver's answer; the PWA must send it back next turn. */
  continuation?: Continuation;
}
