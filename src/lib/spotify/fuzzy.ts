/**
 * Playlist name matching for spoken requests: case/accent-insensitive exact
 * match, then containment, then token-level edit-distance similarity.
 */

/**
 * Minimum score for a non-exact match to be played without asking. Above one
 * edit on a 4-letter word (0.75) so "funk" doesn't silently play "Punk".
 */
export const MATCH_THRESHOLD = 0.78;
/** Two candidates closer than this (and not exact) make the request ambiguous. */
export const AMBIGUITY_MARGIN = 0.05;

// Words drivers wrap around a playlist name ("toca minha playlist de rock").
const FILLER = new Set([
  "playlist", "playlists", "lista", "musica", "musicas",
  "minha", "meu", "minhas", "meus", "a", "o", "as", "os",
  "de", "do", "da", "dos", "das", "the", "my",
]);

export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function coreTokens(normalized: string): string[] {
  const tokens = normalized.split(" ").filter(Boolean);
  const core = tokens.filter((t) => !FILLER.has(t));
  return core.length ? core : tokens;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/** Length-weighted average of each token's best match among `others`. */
function directedTokenScore(tokens: string[], others: string[]): number {
  let total = 0;
  let weight = 0;
  for (const t of tokens) {
    const best = Math.max(...others.map((o) => similarity(t, o)));
    total += best * t.length;
    weight += t.length;
  }
  return weight ? total / weight : 0;
}

/** Score in [0, 1] of how well a spoken query matches a playlist name. */
export function scoreName(query: string, name: string): number {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;

  const qTokens = coreTokens(q);
  const nTokens = coreTokens(n);
  const qCompact = qTokens.join("");
  const nCompact = nTokens.join("");
  if (qCompact === nCompact) return 0.98;

  // Whole-word containment ("rock" in "Rock Nacional", or the reverse).
  const qCore = qTokens.join(" ");
  const nCore = nTokens.join(" ");
  const [shorter, longer] = qCore.length <= nCore.length ? [qCore, nCore] : [nCore, qCore];
  if (shorter.length >= 3 && ` ${longer} `.includes(` ${shorter} `)) return 0.9;
  // Spacing/punctuation-insensitive prefix from a word start ("lofi" in "Lo-Fi Beats",
  // "treino" in "Treinos Pesados", but not "rock" in "Brockhampton").
  const [shortC, longTokens] =
    qCompact.length <= nCompact.length ? [qCompact, nTokens] : [nCompact, qTokens];
  if (
    shortC.length >= 4 &&
    longTokens.some((_, i) => longTokens.slice(i).join("").startsWith(shortC))
  ) {
    return 0.85;
  }

  const tokenScore =
    (directedTokenScore(qTokens, nTokens) + directedTokenScore(nTokens, qTokens)) / 2;
  return Math.max(tokenScore, similarity(qCompact, nCompact));
}

export type MatchResult<T> =
  | { kind: "match"; item: T; score: number }
  | { kind: "none"; suggestions: T[] };

/**
 * Picks the item whose name best matches the query. Returns `none` (with the
 * closest names as suggestions) when nothing is confident enough or when two
 * candidates are too close to call.
 */
export function findBestMatch<T>(
  query: string,
  items: readonly T[],
  nameOf: (item: T) => string,
  maxSuggestions = 5,
): MatchResult<T> {
  const ranked = items
    .map((item) => ({ item, score: scoreName(query, nameOf(item)) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = ranked;

  if (best && best.score >= MATCH_THRESHOLD) {
    const ambiguous =
      best.score < 1 && second !== undefined && best.score - second.score < AMBIGUITY_MARGIN;
    if (!ambiguous) return { kind: "match", item: best.item, score: best.score };
  }
  return { kind: "none", suggestions: ranked.slice(0, maxSuggestions).map((r) => r.item) };
}
