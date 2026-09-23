import { getAgent } from "@/agents/registry";
import { handleA2ARequest } from "@/lib/a2a-server";

/** A2A task endpoint (JSON-RPC `message/send`). */
export async function POST(request: Request, ctx: RouteContext<"/api/agents/[agent]">) {
  const { agent: id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "Unknown agent" }, { status: 404 });
  return Response.json(await handleA2ARequest(agent, request));
}
