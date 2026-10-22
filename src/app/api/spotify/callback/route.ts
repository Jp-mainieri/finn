import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { UserFacingError } from "@/lib/agent-runtime";
import { exchangeAuthorizationCode } from "@/lib/spotify/auth";
import { escapeHtml, htmlPage, OAUTH_STATE_COOKIE, redirectUriFor } from "@/lib/spotify/oauth";

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function clearStateCookie(response: Response, isSecure = false): Response {
  response.headers.append(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=; Path=/api/spotify; Max-Age=0; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`,
  );
  return response;
}

/** OAuth redirect target: verifies `state`, exchanges the code and shows the refresh token. */
export async function GET(request: NextRequest) {
  const isSecure =
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    request.url.startsWith("https:");

  const params = request.nextUrl.searchParams;
  const error = params.get("error");
  if (error) {
    return clearStateCookie(
      htmlPage(
        "Autorização cancelada",
        `<p>O Spotify respondeu <code>${escapeHtml(error)}</code>. <a href="/api/spotify/login">Tentar de novo</a>.</p>`,
        400,
      ),
      isSecure,
    );
  }

  const code = params.get("code");
  const state = params.get("state");
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !state || !expected || !sameState(state, expected)) {
    return clearStateCookie(
      htmlPage(
        "Sessão de login inválida",
        '<p>O <code>state</code> não confere ou expirou. Comece de novo por <a href="/api/spotify/login">/api/spotify/login</a>, no mesmo endereço (host e porta) registrado como redirect URI.</p>',
        400,
      ),
      isSecure,
    );
  }

  let refreshToken: string | undefined;
  try {
    ({ refresh_token: refreshToken } = await exchangeAuthorizationCode(code, redirectUriFor(request)));
  } catch (err) {
    console.error("[spotify] authorization code exchange failed", err);
    const detail = err instanceof UserFacingError ? err.speech : "Erro inesperado.";
    return clearStateCookie(
      htmlPage(
        "Falha ao obter o token",
        `<p>${escapeHtml(detail)} Confira <code>SPOTIFY_CLIENT_ID</code>, <code>SPOTIFY_CLIENT_SECRET</code> e se <code>SPOTIFY_REDIRECT_URI</code> é idêntica à cadastrada no Spotify Developer Dashboard. Detalhes no log do servidor.</p>`,
        502,
      ),
      isSecure,
    );
  }
  if (!refreshToken) {
    return clearStateCookie(
      htmlPage("Falha ao obter o token", "<p>O Spotify não devolveu um refresh token.</p>", 502),
      isSecure,
    );
  }

  const token = escapeHtml(refreshToken);
  const response = clearStateCookie(
    htmlPage(
      "Spotify conectado",
      `<p>Guarde este refresh token como <code>SPOTIFY_REFRESH_TOKEN</code>. Ele dá acesso à sua conta: não compartilhe e feche esta página depois.</p>
<pre>${token}</pre>
<p><strong>Vercel</strong> (para cada ambiente que precisar):</p>
<pre>vercel env add SPOTIFY_REFRESH_TOKEN production
vercel env add SPOTIFY_REFRESH_TOKEN preview
vercel env add SPOTIFY_REFRESH_TOKEN development</pre>
<p>Depois faça um novo deploy para a variável valer.</p>
<p><strong>Local</strong>: adicione em <code>.env.local</code> e reinicie o <code>npm run dev</code>:</p>
<pre>SPOTIFY_REFRESH_TOKEN=${token}</pre>
<p style="margin-top: 1.5rem;">
  <button id="save-btn" data-token="${token}" style="background: #1db954; color: #fff; border: none; border-radius: 9999px; padding: 0.75rem 1.5rem; font-weight: bold; cursor: pointer; font-size: 1rem;">
    Voltar para o Finn (Salvar neste aparelho)
  </button>
</p>
<script>
  document.getElementById('save-btn')?.addEventListener('click', function() {
    try {
      var btn = document.getElementById('save-btn');
      var tokenVal = btn ? btn.getAttribute('data-token') : '';
      if (tokenVal) {
        var current = JSON.parse(localStorage.getItem('finn.driverSettings') || '{}');
        current.spotifyRefreshToken = tokenVal;
        localStorage.setItem('finn.driverSettings', JSON.stringify(current));
      }
    } catch (e) {
      console.error(e);
    }
    window.location.href = '/';
  });
</script>`,
    ),
    isSecure,
  );

  response.headers.append(
    "Set-Cookie",
    `finn_spotify_rt=${encodeURIComponent(refreshToken)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`,
  );
  response.headers.append(
    "Set-Cookie",
    `finn_spotify_mode=; Path=/api/spotify; Max-Age=0; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`,
  );
  return response;
}
