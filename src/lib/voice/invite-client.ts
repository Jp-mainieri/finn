import type { TokenStore } from "./token-store";

/** Fixed messages. They never echo the code, the token or anything the server sent. */
export const INVITE_MESSAGES = {
  invalid: "Convite inválido.",
  badRequest: "Confira o código.",
  unavailable: "Servidor indisponível, tente de novo.",
} as const;

export const SESSION_PATH = "/api/session";

export type InviteResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "rate_limited" | "bad_request" | "unavailable"; message: string };

/** Trim and uppercase; the server compares the normalised form. */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function rateLimitedMessage(retryAfterHeader: string | null): string {
  const seconds = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(seconds) && seconds > 0) {
    return `Muitas tentativas, tente em ${Math.ceil(seconds / 60)} min.`;
  }
  return "Muitas tentativas, tente de novo mais tarde.";
}

/**
 * Redeems an invite code. On 200 with a well-formed body the session token goes into the
 * TokenStore (overwriting any previous one). The code itself is never stored or logged;
 * `driverId` and `label` from the response are ignored on purpose.
 */
export async function redeemInvite(
  rawCode: string,
  deps: { tokens: TokenStore; fetchImpl?: typeof fetch },
): Promise<InviteResult> {
  const inviteCode = normalizeInviteCode(rawCode);
  if (!inviteCode) return fail("bad_request", INVITE_MESSAGES.badRequest);

  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(SESSION_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode }),
      cache: "no-store",
    });
  } catch {
    return fail("unavailable", INVITE_MESSAGES.unavailable);
  }

  if (res.status === 200) {
    let token: unknown;
    try {
      token = ((await res.json()) as { token?: unknown } | null)?.token;
    } catch {
      return fail("unavailable", INVITE_MESSAGES.unavailable);
    }
    if (typeof token !== "string" || !token.trim()) return fail("unavailable", INVITE_MESSAGES.unavailable);
    deps.tokens.set(token);
    return { ok: true };
  }
  if (res.status === 401) return fail("invalid", INVITE_MESSAGES.invalid);
  if (res.status === 429) return fail("rate_limited", rateLimitedMessage(res.headers.get("Retry-After")));
  if (res.status === 400 || res.status === 413 || res.status === 415) return fail("bad_request", INVITE_MESSAGES.badRequest);
  return fail("unavailable", INVITE_MESSAGES.unavailable);
}

function fail(reason: Extract<InviteResult, { ok: false }>["reason"], message: string): InviteResult {
  return { ok: false, reason, message };
}
