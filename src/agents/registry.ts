import type { Agent, AgentId } from "@/lib/contracts/a2a";
import { spotifyAgent } from "./spotify";
import { wazeAgent } from "./waze";

export const agents: Record<AgentId, Agent> = {
  spotify: spotifyAgent,
  waze: wazeAgent,
};

export function getAgent(id: string): Agent | undefined {
  return Object.hasOwn(agents, id) ? agents[id as AgentId] : undefined;
}
