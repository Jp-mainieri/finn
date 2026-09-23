import { getAgent } from "@/agents/registry";
import { baseUrlFrom } from "@/lib/a2a-server";

/** Agent Card. Public path: /agents/<id>/.well-known/agent.json (rewrite in next.config.ts). */
export async function GET(request: Request, ctx: RouteContext<"/api/agents/[agent]/card">) {
  const { agent: id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "Unknown agent" }, { status: 404 });
  return Response.json(agent.card(baseUrlFrom(request)));
}
