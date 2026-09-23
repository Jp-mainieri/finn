import { buildAgentCard } from "@/lib/a2a-server";
import type { AgentCard } from "@/lib/contracts/a2a";
import { NAVIGATE_TO_TOOL } from "@/lib/contracts/tools";

export function wazeAgentCard(baseUrl: string): AgentCard {
  return buildAgentCard({
    name: "waze-agent",
    description:
      "Agente de navegação do Finn: entende o destino falado pelo motorista e devolve um deep link do Waze para o celular abrir a rota. Lembra os endereços de casa e do trabalho.",
    url: `${baseUrl}/api/agents/waze`,
    skills: [
      {
        id: NAVIGATE_TO_TOOL.function.name,
        name: "Navegar até um destino",
        description:
          "Define a rota no Waze da localização atual até o destino falado (lugar, endereço ou ponto de referência). Para \"casa\" e \"trabalho\" usa o endereço salvo; se ainda não houver, pede o endereço completo ao motorista (status input-required) e o salva para as próximas vezes. Não abre o app: devolve uma ação open_url para o cliente executar.",
        tags: ["navegação", "waze", "rota", "destino", "endereços salvos"],
        examples: [
          "Me leva pro Shopping Iguatemi",
          "Vai pra Avenida Paulista, 1000",
          "Me leva pra casa",
          "Quero ir pro trabalho",
        ],
      },
    ],
  });
}
