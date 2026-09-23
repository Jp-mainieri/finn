import type { AgentId } from "@/lib/contracts/a2a";

/**
 * Keyword triage (no LLM call — latency is critical). Each domain is checked
 * independently, so a double command (UC7) matches both.
 * Patterns run against lowercased, accent-stripped text.
 */
const PATTERNS: Record<AgentId, RegExp[]> = {
  spotify: [
    /\b(toca|tocar|toque|tocando|play)\b/,
    /\bplaylists?\b/,
    /\b(musica|musicas|cancao|spotify|ouvir|ouve)\b/,
    /\b(pausa|pausar|pause|despausa|retoma|retomar)\b/,
    /\b(pula|pular|skip|proxima|avanca)\b/,
    /\bpara (a|o|essa|esse) (musica|som)\b/,
  ],
  waze: [
    // "vai pra próxima" is a music skip, not navigation.
    /\b(vai|vamos|ir|quero ir) (pra|para|pro|ao|a|ate)\b(?! (a )?proxima)/,
    /\b(me leva|leva (pra|para|pro)|levar)\b/,
    /\b(navega|navegar|navegacao|waze|gps)\b/,
    /\b(chegar|chego) (em|no|na|ao|a|ate)\b/,
    /\b(rota|destino|caminho)\b/,
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
export function classify(transcript: string): AgentId[] {
  const text = normalize(transcript);
  return (Object.keys(PATTERNS) as AgentId[]).filter((id) =>
    PATTERNS[id].some((re) => re.test(text)),
  );
}
