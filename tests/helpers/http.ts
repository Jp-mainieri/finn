/**
 * Calls the real Next.js route handlers in-process, as the PWA / an external
 * A2A client would over HTTP.
 */
import { POST as agentPOST } from "@/app/api/agents/[agent]/route";
import { GET as cardGET } from "@/app/api/agents/[agent]/card/route";
import { POST as orchestratorPOST } from "@/app/api/orchestrator/route";
import type { A2AResponse, Continuation } from "@/lib/contracts/a2a";
import type { OrchestratorResponse } from "@/lib/contracts/client-events";

export const ORIGIN = "https://finn.test";
export const TEST_TOKEN = "test-finn-token-0123456789";
export const TEST_A2A_TOKEN = "9c1e47d2b86a30f5e7d4c2a91b68f03e5d7a24c9e1b0836f4a5d2c7e91f0b3a8";

export interface CallOptions {
  /** Bearer token; `null` sends no Authorization header. Defaults to TEST_TOKEN (TEST_A2A_TOKEN for callA2A). */
  token?: string | null;
  /** Send this string verbatim instead of JSON-encoding `body`. */
  rawBody?: string;
  /**
   * Client IP (x-vercel-forwarded-for). `undefined` gives callA2A a fresh IP per call so the A2A failure
   * rate limit (per IP, shared store) never couples unrelated tests; `null` sends no IP (the "noip" bucket).
   */
  ip?: string | null;
}

let ipSeq = 0;
const freshIp = () => `198.51.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  json: T;
}

function buildRequest(path: string, body: unknown, opts: CallOptions, defaultToken: string = TEST_TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = opts.token === undefined ? defaultToken : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const ip = opts.ip === undefined ? (defaultToken === TEST_A2A_TOKEN ? freshIp() : null) : opts.ip;
  if (ip) headers["x-vercel-forwarded-for"] = ip;
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

async function unwrap<T>(res: Response): Promise<HttpResult<T>> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json: json as T };
}

export async function callOrchestrator(
  body: { transcript?: unknown; contextId?: string; continuation?: Continuation | unknown },
  opts: CallOptions = {},
): Promise<HttpResult<OrchestratorResponse>> {
  return unwrap(await orchestratorPOST(buildRequest("/api/orchestrator", body, opts)));
}

/** One driver turn; fails loudly on a non-200 so UC tests read straight. */
export async function say(
  transcript: string,
  extra: { contextId?: string; continuation?: Continuation } = {},
): Promise<OrchestratorResponse> {
  const res = await callOrchestrator({ transcript, contextId: extra.contextId ?? "ctx-acceptance", ...extra });
  if (res.status !== 200) {
    throw new Error(`orchestrator returned HTTP ${res.status}: ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

export async function callA2A(
  agent: string,
  body: unknown,
  opts: CallOptions = {},
): Promise<HttpResult<A2AResponse>> {
  return unwrap(
    await agentPOST(buildRequest(`/api/agents/${agent}`, body, opts, TEST_A2A_TOKEN), {
      params: Promise.resolve({ agent }),
    }),
  );
}

export async function getCard(agent: string): Promise<HttpResult<Record<string, unknown>>> {
  // Public path is /agents/<id>/.well-known/agent.json, rewritten to this handler (next.config.ts).
  const req = new Request(`${ORIGIN}/api/agents/${agent}/card`);
  return unwrap(await cardGET(req, { params: Promise.resolve({ agent }) }));
}

export function messageSend(
  text: string | null,
  opts: { id?: string | number; contextId?: string; continuation?: unknown; method?: string } = {},
): unknown {
  const parts: unknown[] = [];
  if (text !== null) parts.push({ kind: "text", text });
  if (opts.continuation !== undefined) parts.push({ kind: "data", data: { continuation: opts.continuation } });
  return {
    jsonrpc: "2.0",
    id: opts.id ?? 1,
    method: opts.method ?? "message/send",
    params: {
      message: {
        kind: "message",
        messageId: "msg-1",
        role: "user",
        parts,
        ...(opts.contextId ? { contextId: opts.contextId } : {}),
      },
    },
  };
}
