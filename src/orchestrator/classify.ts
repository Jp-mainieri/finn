import { agents as defaultAgents } from "@/agents/registry";
import type { Agent, AgentId } from "@/lib/contracts/a2a";

/**
 * Keyword triage (no LLM call — latency is critical). Each domain is checked
 * independently, so a double command (UC7) matches both.
 * Patterns run against lowercased, accent-stripped text.
 */
export const DEFAULT_PATTERNS: Record<AgentId, readonly RegExp[]> = {
  spotify: [
    /\b(toca|tocar|toque|tocando|play)\b/,
    /\bplaylists?\b/,
    /\b(musica|musicas|cancao|cancoes|spotify|ouvir|ouve|ouca|escutar|escuta)\b/,
    /\b(pausa|pausar|pause|despausa|retoma|retomar)\b/,
    /\b(pula|pular|skip|proxima|avanca)\b/,
    /\bpara (a|o|essa|esse) (musica|som)\b/,
    /\b(bota|botar|bote|coloca|colocar|coloque|poe|solta|soltar)\b.*\b(musica|musicas|cancao|som|playlist|playlists|faixa|album|disco|podcast|sertanejo|rock|pagode|samba|funk|pop|mpb|jazz|forro|axe|rap|trap|lofi)\b/,
    /\b(sertanejo|pagode|rock nacional|funk|samba|mpb|lofi)\b/,
    /\b(bota|coloca|solta) (um |uma |o )?(som|musica)\b/,
  ],
  waze: [
    // "vai pra próxima" is a music skip, not navigation.
    /\b(vai|vamos|ir|quero ir) (pra|para|pro|ao|a|ate|no|na|em)\b(?! (a )?proxima)/,
    /\b(me leva|leva (pra|para|pro|ao|a|ate|no|na)|levar)\b/,
    /\b(navega|navegar|navegacao|waze|gps|mapa|maps)\b/,
    /\b(chegar|chego) (em|no|na|ao|a|ate)\b/,
    /\b(rota|destino|caminho|trajeto|direcao|transito)\b/,
    /\b(endereco|rua|avenida|av|alameda|rodovia|estrada|travessa)\b/,
    /\b(abre|abrir|coloca|colocar|bota|botar|inicia|iniciar)?\s*(o\s+)?(waze|gps|navegacao)\b/,
  ],
};

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns every agent whose domain the transcript touches, in stable order. */
export function classify(
  transcript: string,
  customAgents?: Record<string, Pick<Agent, "keywords">>,
): AgentId[] {
  const text = normalize(transcript);
  const registry = customAgents ?? defaultAgents;
  const candidateIds = Object.keys(registry) as AgentId[];
  return candidateIds.filter((id) => {
    const patterns =
      registry[id]?.keywords ??
      (DEFAULT_PATTERNS as Record<string, readonly RegExp[]>)[id] ??
      [];
    return patterns.some((re) => re.test(text));
  });
}
