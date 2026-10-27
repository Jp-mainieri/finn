/**
 * Spotify connection flow (docs/contratos/custodia-token-spotify.md). Plain functions; the route files
 * only delegate (Next route files may not export anything else).
 *
 * - connect: an authenticated driver gets the consent URL; the state record (server side, Redis) is what
 *   later says whose token it is. Never a cookie, body or URL parameter of the callback.
 * - callback: public, only works with a live single-use state (GETDEL). One generic error page for every failure.
 * - connection: connected or not; disconnect.
 * Nothing here logs; errors from the SDK, Spotify and decryption are neither logged nor passed on.
 */
import { authorizeDriver, LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { getDriverStore, type DriverStore } from "@/lib/driver";
import { evictSpotifyAccessToken, exchangeAuthorizationCode, getOwnerSpotifyUserId } from "./auth";
import { buildAuthorizeUrl, escapeHtml, htmlPage, isDevelopmentFlow, OAUTH_STATE_COOKIE, redirectUriFor } from "./oauth";
import { fetchSpotifyProfile } from "./profile";
import { deleteSpotifyRefreshToken, isTokenVaultEnabled, loadSpotifyRefreshToken, saveSpotifyRefreshToken } from "./token-vault";

type Env = Record<string, string | undefined>;
export interface ConnectDeps {
  store?: DriverStore;
  env?: Env;
}

export const CONNECT_RATE_LIMIT = { max: 10, windowSeconds: 600 } as const;
const MAX_CODE_LENGTH = 2048;

const noStore = { "Cache-Control": "no-store" };
const unavailable = () => Response.json({ error: "Spotify connection unavailable" }, { status: 503, headers: noStore });

/** POST /api/spotify/connect */
export async function handleConnect(request: Request, deps: ConnectDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const auth = await authorizeDriver(request, deps.store ? { store: deps.store } : {});
  if (auth instanceof Response) return auth;
  // The owner uses SPOTIFY_REFRESH_TOKEN of the server; a stored token for the owner id would be ignored.
  if (auth.driverId === LEGACY_OWNER_DRIVER_ID) {
    return Response.json({ error: "The owner does not connect Spotify here" }, { status: 403, headers: noStore });
  }

  // Fail closed: without a valid key the connection flow is off and nothing is written or read.
  if (!isTokenVaultEnabled(env)) return unavailable();
  const clientId = env.SPOTIFY_CLIENT_ID;
  if (!clientId || !env.SPOTIFY_CLIENT_SECRET) return unavailable();

  let redirectUri: string;
  try {
    redirectUri = redirectUriFor(request, env); // required in production
  } catch {
    return unavailable();
  }

  let state: string;
  try {
    const store = deps.store ?? getDriverStore();
    const n = await store.incrementRateLimit(`ratelimit:spotify-connect:${auth.driverId}`, CONNECT_RATE_LIMIT.windowSeconds);
    if (n > CONNECT_RATE_LIMIT.max) {
      return Response.json(
        { error: "Too many attempts" },
        { status: 429, headers: { "Retry-After": String(CONNECT_RATE_LIMIT.windowSeconds), ...noStore } },
      );
    }
    state = await store.createOAuthState(auth.driverId);
  } catch {
    return unavailable();
  }
  return Response.json({ url: buildAuthorizeUrl(clientId, redirectUri, state) }, { headers: noStore });
}

/** The same page for every failure: it must not tell a probe why. */
function failurePage(status: number): Response {
  return htmlPage(
    "Não foi possível conectar o Spotify",
    "<p>Volte ao Finn e toque em <strong>Conectar Spotify</strong> para tentar de novo.</p>",
    status,
  );
}

function cookieValue(request: Request, name: string): string | undefined {
  const m = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m?.[1];
}

/** GET /api/spotify/callback */
export async function handleCallback(request: Request, deps: ConnectDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");

  // Development only: the owner generating SPOTIFY_REFRESH_TOKEN (login sets a cookie with the state).
  if (isDevelopmentFlow(env) && state) {
    const expected = cookieValue(request, OAUTH_STATE_COOKIE);
    if (expected && expected === state) return devOwnerCallback(request, code, params.get("error"));
  }

  if (!isTokenVaultEnabled(env)) return failurePage(503);
  let redirectUri: string;
  try {
    redirectUri = redirectUriFor(request, env); // production without SPOTIFY_REDIRECT_URI: nothing is consumed or stored
  } catch {
    return failurePage(503);
  }

  // The state is consumed (single use, atomic) BEFORE anything else, so even a failed attempt burns it.
  let driverId: string | null = null;
  const store = deps.store ?? (() => {
    try {
      return getDriverStore();
    } catch {
      return null;
    }
  })();
  if (!store) return failurePage(503);
  try {
    driverId = state ? await store.consumeOAuthState(state) : null;
  } catch {
    return failurePage(503);
  }
  if (!driverId) return failurePage(400);
  if (params.get("error") || !code || code.length > MAX_CODE_LENGTH) return failurePage(400);

  let label: string;
  try {
    // The record must still point at a live, active driver (revoked, purged or unknown: nothing is stored);
    // the owner id never gets a stored token.
    if (driverId === LEGACY_OWNER_DRIVER_ID) return failurePage(400);
    const driver = await store.getDriver(driverId);
    if (!driver || driver.status !== "active") return failurePage(400);

    const { refresh_token: refreshToken, access_token: accessToken } = await exchangeAuthorizationCode(code, redirectUri);
    if (!refreshToken) return failurePage(502);

    // Whose Spotify account consented? Unknown account = refuse (fail closed).
    const profile = await fetchSpotifyProfile(accessToken);
    if (!profile) return failurePage(502);
    const ownerId = await getOwnerSpotifyUserId(); // throws if the owner token exists but cannot be resolved
    if (ownerId && ownerId === profile.id) return failurePage(400);
    // One Spotify account belongs to one driver (SET NX); the same driver reconnecting is fine.
    if ((await store.linkSpotifyAccount(driverId, profile.id)) === "conflict") return failurePage(400);

    // The owner of the token is the driverId of the SERVER state record, nothing else.
    await saveSpotifyRefreshToken(driverId, refreshToken, { store, env });
    label = profile.label;
  } catch {
    return failurePage(502);
  }
  evictSpotifyAccessToken(driverId);

  return htmlPage(
    "Spotify conectado",
    `<p>Pronto! O Spotify está conectado: <strong>${escapeHtml(label)}</strong>. Volte ao Finn.</p>`,
  );
}

/** Development only (NODE_ENV=development) and only with the state cookie set by /api/spotify/login. */
async function devOwnerCallback(request: Request, code: string | null, error: string | null): Promise<Response> {
  if (error || !code) return htmlPage("Autorização cancelada", `<p>O Spotify respondeu <code>${escapeHtml(error ?? "sem code")}</code>.</p>`, 400);
  try {
    const { refresh_token: refreshToken } = await exchangeAuthorizationCode(code, redirectUriFor(request));
    if (!refreshToken) return htmlPage("Falha ao obter o token", "<p>O Spotify não devolveu um refresh token.</p>", 502);
    // The only place a refresh token is ever shown: the owner copies it into SPOTIFY_REFRESH_TOKEN. No script, no cookie.
    return htmlPage(
      "Refresh token do Spotify",
      `<p>Copie para <code>SPOTIFY_REFRESH_TOKEN</code> no seu <code>.env.local</code> e feche esta página.</p><pre>${escapeHtml(refreshToken)}</pre>`,
    );
  } catch {
    return htmlPage("Falha ao obter o token", "<p>Confira <code>SPOTIFY_CLIENT_ID</code>, <code>SPOTIFY_CLIENT_SECRET</code> e a redirect URI cadastrada.</p>", 502);
  }
}

const ownerConnected = (env: Env) => Boolean(env.SPOTIFY_REFRESH_TOKEN?.trim());

/** GET /api/spotify/connection */
export async function handleConnectionStatus(request: Request, deps: ConnectDeps = {}): Promise<Response> {
  const auth = await authorizeDriver(request, deps.store ? { store: deps.store } : {});
  if (auth instanceof Response) return auth;
  // The owner is "connected" through the server token; the vault (and its key) are not involved.
  if (auth.driverId === LEGACY_OWNER_DRIVER_ID) return Response.json({ connected: ownerConnected(deps.env ?? process.env) }, { headers: noStore });
  try {
    // A blob that does not decrypt reads as null: not connected.
    const token = await loadSpotifyRefreshToken(auth.driverId, deps);
    return Response.json({ connected: token !== null }, { headers: noStore });
  } catch {
    return unavailable(); // vault off or Redis down
  }
}

/** DELETE /api/spotify/connection (idempotent) */
export async function handleDisconnect(request: Request, deps: ConnectDeps = {}): Promise<Response> {
  const auth = await authorizeDriver(request, deps.store ? { store: deps.store } : {});
  if (auth instanceof Response) return auth;
  try {
    await deleteSpotifyRefreshToken(auth.driverId, deps); // also releases this driver's Spotify account link
  } catch {
    return unavailable();
  }
  if (auth.driverId === LEGACY_OWNER_DRIVER_ID) {
    // Only clears a residual blob; the server token stays, so the answer is the same as GET's.
    return Response.json({ connected: ownerConnected(deps.env ?? process.env) }, { headers: noStore });
  }
  evictSpotifyAccessToken(auth.driverId);
  return Response.json({ connected: false }, { headers: noStore });
}
