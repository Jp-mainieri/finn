import { withTimeout } from "./request-timeout";
import type { TokenStore } from "./token-store";

/** Fixed messages. They never echo the code, the token or anything the server sent. */
export const INVITE_MESSAGES = {
  invalid: "Convite inválido.",
  badRequest: "Confira o código.",
  unavailable: "Servidor indisponível, tente de novo.",
  rateLimitedGeneric: "Muitas tentativas, tente de novo mais tarde.",
} as const;

export const SESSION_PATH = "/api/session";

/** Same shape and size limit the server enforces on session tokens (`v1.` + url-safe/dots). */
const SESSION_TOKEN_RE = /^v1\.[A-Za-z0-9._-]+$/;
const MAX_TOKEN_LENGTH = 1024;
/** Same shape the server issues (src/lib/driver/invite.ts): checking it here spends no rate-limit attempt. */
const CODE_RE = /^FINN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
/** Longest Retry-After shown (seconds); anything above is capped, anything not a plain integer is ignored. */
const MAX_RETRY_AFTER_SECONDS = 3600;

export type InviteResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "rate_limited" | "bad_request" | "unavailable"; message: string };

export function isSessionTokenShape(token: unknown): token is string {
  return typeof token === "string" && token.length <= MAX_TOKEN_LENGTH && SESSION_TOKEN_RE.test(token);
}

/**
 * Cleans what a person (or a paste) can leave in the field: NFKC (full-width letters and
 * dashes), upper case, and spaces, any kind of dash and zero-width characters re-laid as `FINN-XXXX-XXXX`.
 * Returns null when the result is not shaped like an invite code.
 */
export function normalizeInviteCode(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 128) return null;
  // Everything that is not a letter or digit (spaces, any dash, zero-width) is separator noise:
  // drop it, then put the canonical dashes back.
  const flat = raw
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const m = /^FINN([A-Z0-9]{4})([A-Z0-9]{4})$/.exec(flat);
  const code = m ? `FINN-${m[1]}-${m[2]}` : "";
  return CODE_RE.test(code) ? code : null;
}

export function rateLimitedMessage(retryAfterHeader: string | null): string {
  if (retryAfterHeader !== null && /^\d{1,7}$/.test(retryAfterHeader.trim())) {
    const seconds = Math.min(Number(retryAfterHeader.trim()), MAX_RETRY_AFTER_SECONDS);
    if (seconds > 0) return `Muitas tentativas, tente em ${Math.ceil(seconds / 60)} min.`;
  }
  return INVITE_MESSAGES.rateLimitedGeneric;
}

/**
 * Redeems an invite code. A malformed code is refused on the phone without a request. On 200
 * with a well-formed token it goes into the TokenStore (overwriting any previous one). The
 * code itself is never stored or logged; `driverId` and `label` from the response are ignored.
 */
export async function redeemInvite(
  rawCode: string,
  deps: { tokens: TokenStore; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<InviteResult> {
  const inviteCode = normalizeInviteCode(rawCode);
  if (!inviteCode) return fail("bad_request", INVITE_MESSAGES.badRequest);

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    return await withTimeout(
      async (signal) => {
        const res = await fetchImpl(SESSION_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviteCode }),
          cache: "no-store",
          signal,
        });

        if (res.status === 200) {
          let token: unknown;
          try {
            token = ((await res.json()) as { token?: unknown } | null)?.token;
          } catch {
            return fail("unavailable", INVITE_MESSAGES.unavailable);
          }
          if (!isSessionTokenShape(token)) return fail("unavailable", INVITE_MESSAGES.unavailable);
          deps.tokens.set(token);
          return { ok: true } as const;
        }
        if (res.status === 401) return fail("invalid", INVITE_MESSAGES.invalid);
        if (res.status === 429) return fail("rate_limited", rateLimitedMessage(res.headers.get("Retry-After")));
        if (res.status === 400 || res.status === 413 || res.status === 415) return fail("bad_request", INVITE_MESSAGES.badRequest);
        return fail("unavailable", INVITE_MESSAGES.unavailable);
      },
      { timeoutMs: deps.timeoutMs, signal: deps.signal },
    );
  } catch {
    return fail("unavailable", INVITE_MESSAGES.unavailable);
  }
}

function fail(reason: Extract<InviteResult, { ok: false }>["reason"], message: string): InviteResult {
  return { ok: false, reason, message };
}
