import { agents } from "@/agents/registry";
import type { OrchestratorRequest } from "@/lib/contracts/client-events";
import { orchestrate } from "@/orchestrator/orchestrate";

export async function POST(request: Request) {
  let body: Partial<OrchestratorRequest>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return Response.json({ error: "`transcript` is required" }, { status: 400 });
  }

  const response = await orchestrate(transcript, {
    agents,
    contextId: body.contextId || crypto.randomUUID(),
  });
  return Response.json(response);
}
