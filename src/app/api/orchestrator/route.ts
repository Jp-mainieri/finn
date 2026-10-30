import { agents } from "@/agents/registry";
import { authorizeDriver } from "@/lib/auth";
import { boundedContinuation } from "@/lib/continuation";
import type { OrchestratorRequest } from "@/lib/contracts/client-events";
import { orchestrate } from "@/orchestrator/orchestrate";

export async function POST(request: Request) {
  const auth = await authorizeDriver(request);
  if (auth instanceof Response) return auth;

  let body: Partial<OrchestratorRequest>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return Response.json({ error: "`transcript` is required" }, { status: 400 });
  }

  // Nothing from the client's driverContext is trusted: not a Spotify token (the server reads the
  // driver's own from its encrypted store, by driverId), not addresses, not an id. Cookies are not read.
  // Only its PRESENCE counts: it is what makes the waze agent keep emitting `save_address` for the current PWA.
  const driverContext = typeof body.driverContext === "object" && body.driverContext !== null ? {} : undefined;

  const response = await orchestrate(transcript, {
    agents,
    contextId: typeof body.contextId === "string" && body.contextId ? body.contextId : crypto.randomUUID(),
    // Untrusted and unsigned: at most 2 KB, then parsed strictly by the agent. Never carries identity.
    continuation: boundedContinuation(body.continuation),
    driverId: auth.driverId,
    driverContext,
  });
  return Response.json(response);
}
