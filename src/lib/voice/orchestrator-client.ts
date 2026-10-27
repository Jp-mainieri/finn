import type { Continuation } from "@/lib/contracts/a2a";
import type { OrchestratorRequest, OrchestratorResponse } from "@/lib/contracts/client-events";
import { ORCHESTRATOR_PATH, ORCHESTRATOR_TIMEOUT_MS } from "./config";
import { serverFailureKind } from "./failure-speech";

export type OrchestratorFailure = "unauthorized" | "rate_limited" | "unavailable" | "network" | "server" | "timeout";

export type OrchestratorResult =
  | { ok: true; response: OrchestratorResponse }
  | { ok: false; failure: OrchestratorFailure; status?: number };

export interface OrchestratorClientOptions {
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
  newContextId?: () => string;
  timeoutMs?: number;
  url?: string;
}

/**
 * Talks to POST /api/orchestrator for one conversation window at a time.
 * `contextId` is stable within the window; `continuation` echoes the previous
 * response's value within the window (ARCHITECTURE.md "Continuação").
 * `startWindow()` / `endWindow()` bound the window (one Live session).
 */
export class OrchestratorClient {
  private contextId: string;
  private continuation: Continuation | undefined;
  private readonly options: Required<Omit<OrchestratorClientOptions, "fetchImpl">> & {
    fetchImpl?: typeof fetch;
  };

  constructor(options: OrchestratorClientOptions) {
    this.options = {
      newContextId: randomId,
      timeoutMs: ORCHESTRATOR_TIMEOUT_MS,
      url: ORCHESTRATOR_PATH,
      ...options,
    };
    this.contextId = this.options.newContextId();
  }

  get window(): { contextId: string; continuation: Continuation | undefined } {
    return { contextId: this.contextId, continuation: this.continuation };
  }

  /** Both ends rotate the id, so a late reply from a closed window is recognised and dropped. */
  startWindow(): void {
    this.contextId = this.options.newContextId();
    this.continuation = undefined;
  }

  endWindow(): void {
    this.startWindow();
  }

  async send(transcript: string): Promise<OrchestratorResult> {
    const token = this.options.getToken();
    if (!token) return { ok: false, failure: "unauthorized" };

    const body: OrchestratorRequest = { transcript, contextId: this.contextId };
    if (this.continuation) body.continuation = this.continuation;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const windowAtSend = this.contextId;

    let res: Response;
    try {
      res = await fetchImpl(this.options.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return { ok: false, failure: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) return { ok: false, failure: "unauthorized", status: 401 };
    const kind = serverFailureKind(res.status);
    if (kind) return { ok: false, failure: kind, status: res.status };
    if (!res.ok) return { ok: false, failure: "server", status: res.status };

    let response: OrchestratorResponse;
    try {
      response = parseResponse(await res.json());
    } catch {
      return { ok: false, failure: "server", status: res.status };
    }

    // A late reply from a window that already closed must not leak its continuation.
    if (windowAtSend === this.contextId) this.continuation = response.continuation;
    return { ok: true, response };
  }
}

/** `crypto.randomUUID` only exists in secure contexts; fall back for plain-http LAN testing. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseResponse(raw: unknown): OrchestratorResponse {
  if (!raw || typeof raw !== "object") throw new Error("Invalid orchestrator response");
  const r = raw as Partial<OrchestratorResponse>;
  if (typeof r.speech !== "string") throw new Error("Invalid orchestrator response");
  return {
    speech: r.speech,
    clientActions: Array.isArray(r.clientActions) ? r.clientActions : [],
    results: Array.isArray(r.results) ? r.results : [],
    ...(r.continuation ? { continuation: r.continuation } : {}),
  };
}
