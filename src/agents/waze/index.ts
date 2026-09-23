/**
 * PHASE 0 STUB — replaced by the feat/waze-agent worktree.
 * Keeps the Agent contract so the orchestrator and routes work end-to-end.
 */
import { buildAgentCard } from "@/lib/a2a-server";
import { runToolLoop } from "@/lib/agent-runtime";
import type { Agent } from "@/lib/contracts/a2a";
import { WAZE_TOOLS } from "@/lib/contracts/tools";
import { getNeuralakeClient } from "@/lib/neuralake/client";

export const wazeAgent: Agent = {
  id: "waze",

  card: (baseUrl) =>
    buildAgentCard({
      name: "waze-agent",
      description: "(stub) Abre navegação no Waze.",
      url: `${baseUrl}/api/agents/waze`,
      skills: WAZE_TOOLS.map((t) => ({
        id: t.function.name,
        name: t.function.name,
        description: t.function.description,
        tags: ["navigation", "waze"],
      })),
    }),

  handle: (input) =>
    runToolLoop({
      agent: "waze",
      client: getNeuralakeClient(),
      systemPrompt: "(stub) Você abre navegação no Waze. Ignore o que não for navegação.",
      tools: WAZE_TOOLS,
      executors: {
        navigate_to: async (args) => ({
          result: { stub: true, destination: args.destination },
          clientActions: [
            {
              type: "open_url",
              url: `https://waze.com/ul?q=${encodeURIComponent(String(args.destination))}&navigate=yes`,
              label: `Navegar para ${args.destination}`,
            },
          ],
        }),
      },
      input,
    }),
};
