import { getAgent } from "@/agents/registry";
import { handleA2ARequest } from "@/lib/a2a-server";
import { guardA2A } from "@/lib/auth";

/**
 * A2A task endpoint (JSON-RPC `message/send`). Always runs as the OWNER (FINN_A2A_TOKEN is the owner's
 * credential). Gate: failure rate limit in Redis, then the Bearer (guardA2A).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/agents/[agent]">) {
  const denied = await guardA2A(request);
  if (denied) return denied;

  const { agent: id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "Unknown agent" }, { status: 404 });
  return Response.json(await handleA2ARequest(agent, request));
}
