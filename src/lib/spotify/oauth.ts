import { SPOTIFY_AUTHORIZE_URL, SPOTIFY_SCOPES } from "./auth";

export const OAUTH_STATE_COOKIE = "finn_spotify_oauth_state";
export const OAUTH_STATE_MAX_AGE_S = 600;
export const CALLBACK_PATH = "/api/spotify/callback";

/**
 * Redirect URI registered in the Spotify dashboard. Prefer the env var:
 * Spotify rejects `localhost` for http URIs (use http://127.0.0.1:<port>),
 * and the value must match byte-for-byte in both the authorize and token calls.
 */
export function redirectUriFor(request: Request): string {
  return process.env.SPOTIFY_REDIRECT_URI || `${new URL(request.url).origin}${CALLBACK_PATH}`;
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SPOTIFY_SCOPES.join(" "),
    redirect_uri: redirectUri,
    state,
    show_dialog: "true",
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Minimal standalone HTML page; `bodyHtml` must already be escaped. */
export function htmlPage(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  code, pre { background: #f2f2f2; border-radius: 4px; padding: 0.1rem 0.3rem; }
  pre { padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } code, pre { background: #222; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}
