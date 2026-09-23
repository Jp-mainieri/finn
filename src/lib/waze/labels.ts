/**
 * Canonical labels for the driver's saved places. Spoken variants ("minha
 * casa", "pra casa", "lá em casa", "meu trabalho", "escritório"…) normalize to
 * one of these; anything else is a free-form destination passed to Waze as is.
 */
export const SAVED_LABELS = ["casa", "trabalho"] as const;

export type SavedLabel = (typeof SAVED_LABELS)[number];

const SYNONYMS: Record<string, SavedLabel> = {
  casa: "casa",
  lar: "casa",
  residencia: "casa",
  trabalho: "trabalho",
  servico: "trabalho",
  escritorio: "trabalho",
  emprego: "trabalho",
  firma: "trabalho",
};

/**
 * Leading words that don't change the place ("de volta pra minha casa" → "casa").
 * Includes the command verbs in case the whole phrase is passed ("me leva pra casa").
 */
const LEADING_FILLERS = new Set([
  "me", "leva", "levar", "vai", "vamos", "ir", "quero", "voltar", "navega", "navegar", "rota",
  "de", "volta", "pra", "para", "pro", "ate", "a", "o", "ao", "la", "em", "no", "na",
  "minha", "meu", "nossa", "nosso",
]);

function simplify(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\bpor favor\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isSavedLabel(value: unknown): value is SavedLabel {
  return typeof value === "string" && (SAVED_LABELS as readonly string[]).includes(value);
}

/**
 * Returns the canonical label when the whole destination refers to a saved
 * place, otherwise undefined ("Casa do Pão de Queijo" stays free-form).
 */
export function toSavedLabel(destination: string): SavedLabel | undefined {
  const words = simplify(destination);
  let start = 0;
  while (start < words.length - 1 && LEADING_FILLERS.has(words[start])) start++;
  const rest = words.slice(start);
  return rest.length === 1 && Object.hasOwn(SYNONYMS, rest[0]) ? SYNONYMS[rest[0]] : undefined;
}
