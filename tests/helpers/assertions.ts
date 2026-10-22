import { expect } from "vitest";
import type { AgentId, AgentResult } from "@/lib/contracts/a2a";
import type { ClientAction, OpenUrlAction, OrchestratorResponse } from "@/lib/contracts/client-events";

/** Things the driver must never hear (spec: "sem tecnicismo"). */
export const TECHNICAL_TERMS: RegExp[] = [
  /spotify:/i, // URIs
  /https?:|www\./i,
  /\bids?\b/i,
  /\b(400|401|403|404|405|429|500|502|503)\b/, // HTTP status codes (street numbers are fine)
  /\b(token|api|http|json|error|exception|status|undefined|null|nan)\b/i,
  /no_active_device|invalid_grant|unauthorized/i,
  /pl_[a-z0-9_]+/i, // fixture playlist ids
  /[{}[\]<>]/,
  /\bfetch\b/i,
];

export function technicalTermsIn(speech: string): string[] {
  return TECHNICAL_TERMS.filter((re) => re.test(speech)).map(String);
}

/** Non-empty, short, spoken-friendly pt-BR sentence with no technical leakage. */
export function expectFriendlySpeech(speech: unknown, { maxChars = 200 } = {}): void {
  expect(typeof speech, "speech must be a string").toBe("string");
  const s = (speech as string).trim();
  expect(s.length, "speech must not be empty").toBeGreaterThan(0);
  expect(s.length, `speech too long for driving (${s.length} chars): "${s}"`).toBeLessThanOrEqual(maxChars);
  expect(technicalTermsIn(s), `technical terms in speech: "${s}"`).toEqual([]);
}

export function expectAgentResult(value: unknown, agent?: AgentId): asserts value is AgentResult {
  expect(value).toBeTypeOf("object");
  const r = value as AgentResult;
  expect(["spotify", "waze"]).toContain(r.agent);
  if (agent) expect(r.agent).toBe(agent);
  expect(["completed", "input-required", "failed"]).toContain(r.status);
  expect(r.speech).toBeTypeOf("string");
  expect(Array.isArray(r.clientActions)).toBe(true);
  for (const a of r.clientActions) {
    if (a.type === "open_url") {
      expect(a.url).toBeTypeOf("string");
    } else if (a.type === "save_address") {
      expect(a.address).toBeTypeOf("string");
      expect(["casa", "trabalho"]).toContain(a.label);
    }
  }
  expect(Array.isArray(r.toolCalls)).toBe(true);
  for (const c of r.toolCalls) {
    expect(c.name).toBeTypeOf("string");
    expect(c.arguments).toBeTypeOf("object");
    expect(c.ok).toBeTypeOf("boolean");
  }
  if (r.status !== "input-required") expect(r.continuation).toBeUndefined();
  // Must survive the A2A / HTTP JSON round-trip.
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
}

export function expectOrchestratorResponse(value: unknown): asserts value is OrchestratorResponse {
  const r = value as OrchestratorResponse;
  expect(r.speech).toBeTypeOf("string");
  expect(Array.isArray(r.clientActions)).toBe(true);
  expect(Array.isArray(r.results)).toBe(true);
  for (const result of r.results) expectAgentResult(result);
}

export const wazeUrl = (destination: string): string =>
  `https://waze.com/ul?q=${encodeURIComponent(destination)}&navigate=yes`;

export function openUrls(res: { clientActions: ClientAction[] }): string[] {
  return res.clientActions
    .filter((a): a is OpenUrlAction => a.type === "open_url")
    .map((a) => a.url);
}

export function resultOf(res: OrchestratorResponse, agent: AgentId): AgentResult {
  const r = res.results.find((x) => x.agent === agent);
  if (!r) throw new Error(`no ${agent} result; agents that ran: ${res.results.map((x) => x.agent).join(", ") || "none"}`);
  return r;
}

export function toolCall(result: AgentResult, name: string) {
  return result.toolCalls.find((c) => c.name === name);
}
