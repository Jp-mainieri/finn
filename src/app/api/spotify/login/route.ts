import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  htmlPage,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_S,
  redirectUriFor,
} from "@/lib/spotify/oauth";

/**
 * One-time setup: sends the owner to Spotify's consent screen. The callback
 * then shows the refresh token to store as SPOTIFY_REFRESH_TOKEN.
 */
export async function GET(request: NextRequest) {
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

  const state = randomBytes(16).toString("hex");
  const response = NextResponse.redirect(buildAuthorizeUrl(clientId, redirectUri, state));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    // Always https in production; the http loopback URI is dev-only.
    secure: callback.protocol === "https:",
    sameSite: "lax",
    path: "/api/spotify",
    maxAge: OAUTH_STATE_MAX_AGE_S,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
