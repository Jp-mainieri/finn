import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  htmlPage,
  isDevelopmentFlow,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_S,
  redirectUriFor,
} from "@/lib/spotify/oauth";

/**
 * Development only (NODE_ENV=development): one-time setup that sends the owner to Spotify's consent
 * screen; the callback then shows the refresh token to store as SPOTIFY_REFRESH_TOKEN. Anywhere else it
 * is closed (410) and touches neither Spotify nor Redis: drivers connect from inside the Finn.
 */
export async function GET(request: NextRequest) {
  if (!isDevelopmentFlow()) {
    return htmlPage("Conectar Spotify", "<p>Use o botão <strong>Conectar Spotify</strong> dentro do Finn.</p>", 410);
  }
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return htmlPage(
      "Spotify não configurado",
      "<p>Defina <code>SPOTIFY_CLIENT_ID</code>, <code>SPOTIFY_CLIENT_SECRET</code> e <code>SPOTIFY_REDIRECT_URI</code> e tente de novo.</p>",
      500,
    );
  }

  const redirectUri = redirectUriFor(request);
  // The state cookie must be set on the same origin the callback lands on
  // (e.g. opened at localhost:3000 but registered as 127.0.0.1:3000).
  // `request.url` may report a normalized host, so compare against the Host header.
  const callback = new URL(redirectUri);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");

  if (host && host !== callback.host && !request.nextUrl.searchParams.has("hop")) {
    return NextResponse.redirect(new URL("/api/spotify/login?hop=1", callback.origin));
  }

  const state = randomBytes(32).toString("hex");
  const isSecure =
    callback.protocol === "https:" ||
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    request.url.startsWith("https:");

  const response = NextResponse.redirect(buildAuthorizeUrl(clientId, redirectUri, state));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    // Always https in production; the http loopback URI is dev-only.
    secure: isSecure,
    sameSite: "lax",
    path: "/api/spotify",
    maxAge: OAUTH_STATE_MAX_AGE_S,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
