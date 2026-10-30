import { getAgent } from "@/agents/registry";
import { handleA2ARequest } from "@/lib/a2a-server";
import { enforceAiLimit } from "@/lib/ai-limits";
import { getOwnerDriverId, guardA2A } from "@/lib/auth";

/**
 * A2A task endpoint (JSON-RPC `message/send`). Always runs as the OWNER (FINN_A2A_TOKEN is the owner's
 * credential). Gate: failure rate limit in Redis, then the Bearer (guardA2A), then the per-driver AI ceiling (class `a2a`).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/agents/[agent]">) {
  const denied = await guardA2A(request);
  if (denied) return denied;

  // Per-driver ceiling (the A2A caller is the owner). Before the body is read or any agent/LLM runs.
  const owner = getOwnerDriverId();
  if (!owner) return Response.json({ error: "A2A endpoint disabled" }, { status: 503 });
  const limited = await enforceAiLimit("a2a", owner, { ownerFailsOpen: false });
  if (limited) return limited;

  const { agent: id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "Unknown agent" }, { status: 404 });
  return Response.json(await handleA2ARequest(agent, request));
}
