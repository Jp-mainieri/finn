/**
 * Fixed pt-BR texts for server failures, plus the status -> failure mapping shared by
 * the orchestrator client and the realtime sessions. No network, no dynamic parts: the
 * "local" lines are spoken by the phone's own TTS so they work when the server is the
 * thing that is down or throttling.
 *
 * Wording is a proposal from the contract (pwa-convite-e-dono.md), owner decides.
 */

export type ServerFailureKind = "rate_limited" | "day_limited" | "unavailable";

export const LOCAL_SPEECH = {
  rate_limited: "Muitas tentativas, tente de novo em instantes.",
  day_limited: "Você atingiu o limite de uso de hoje. Volte amanhã.",
  unavailable: "O Finn está fora do ar agora, tente de novo daqui a pouco.",
} as const satisfies Record<ServerFailureKind, string>;

/**
 * Lines for a speech request that failed without a 429/503 (network error, HTTP 5xx, other).
 * Spoken locally; the raw error is never shown or spoken. Wording is a proposal, owner decides.
 */
export const SPEECH_FAILURE_LINES = {
  not_heard: "Não consegui te ouvir, tente de novo.",
  offline: "Sem internet.",
} as const;

/**
 * True when a failed fetch looks like missing connectivity: the browser says it is offline, or
 * fetch rejected with a TypeError (WebKit: "Load failed", Chrome: "Failed to fetch").
 */
export function isOffline(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return err instanceof TypeError;
}

/** The 429 body is `{ error, scope }`, a few dozen bytes; anything bigger is not read. */
const MAX_BODY_BYTES = 1024;
const BODY_DEADLINE_MS = 1500;

/**
 * Reads the `scope` of an AI-route 429 (`"burst" | "day"`). Only the exact string "day" counts;
 * missing body, non-JSON, huge body, slow body, other values: undefined. Never throws.
 * The text spoken is always the fixed local one; nothing from the body is ever shown or spoken.
 */
async function readScope(res: Response): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const read = (async () => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return undefined;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== "object") return undefined;
      const scope = (body as { scope?: unknown }).scope;
      return typeof scope === "string" ? scope : undefined;
    })();
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
        resolve(undefined);
      }, BODY_DEADLINE_MS);
    });
    return await Promise.race([read, deadline]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Failure kind for a response from an AI route: 503 -> unavailable; 429 -> day_limited when the
 * body says `scope === "day"` (strict), otherwise rate_limited; anything else null.
 * The body is read only for a 429. Not for the invite or Spotify routes (no "day" scope there).
 */
export async function classifyServerFailure(res: Response): Promise<ServerFailureKind | null> {
  if (res.status === 503) return "unavailable";
  if (res.status !== 429) return null;
  return (await readScope(res)) === "day" ? "day_limited" : "rate_limited";
}
