/**
 * Fixed pt-BR texts for server failures, plus the status -> failure mapping shared by
 * the orchestrator client and the realtime sessions. No network, no dynamic parts: the
 * "local" lines are spoken by the phone's own TTS so they work when the server is the
 * thing that is down or throttling.
 *
 * Wording is a proposal from the contract (pwa-convite-e-dono.md), owner decides.
 */

export type ServerFailureKind = "rate_limited" | "unavailable";

export const LOCAL_SPEECH = {
  rate_limited: "Muitas tentativas, tente de novo em instantes.",
  unavailable: "O Finn está fora do ar agora, tente de novo daqui a pouco.",
} as const satisfies Record<ServerFailureKind, string>;

/** 429 -> rate_limited, 503 -> unavailable, anything else is not one of the two. */
export function serverFailureKind(status: number): ServerFailureKind | null {
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return null;
}
