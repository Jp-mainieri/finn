import { authorizeDriver, unavailableResponse } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import {
  REDEEM_RATE_LIMIT,
  checkRedeemRateLimit,
  getDriverStore,
  getSessionSecret,
  signSessionToken,
} from "@/lib/driver";
import { expireLegacyRefreshCookie } from "@/lib/spotify/oauth";

// Never log the invite code, the token or the request body in this file.

const NO_STORE = { "Cache-Control": "no-store" };

const badRequest = () => Response.json({ error: "Pedido inválido." }, { status: 400, headers: NO_STORE });

/** Same status, body and headers for unknown, malformed, expired, exhausted or revoked codes. */
const invalidInvite = () =>
  Response.json({ error: "Convite inválido." }, { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } });

const tooMany = () =>
  Response.json(
    { error: "Muitas tentativas. Tente de novo mais tarde." },
    { status: 429, headers: { ...NO_STORE, "Retry-After": String(REDEEM_RATE_LIMIT.windowSeconds) } },
  );

export const MAX_BODY_BYTES = 2048;

const unsupportedType = () =>
  Response.json({ error: "Pedido inválido." }, { status: 415, headers: NO_STORE });
const tooLarge = () => Response.json({ error: "Pedido grande demais." }, { status: 413, headers: NO_STORE });

/** Reads at most MAX_BODY_BYTES; null when the body is larger. */
async function readLimited(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(request: Request) {
  // Rejected before any Redis command. application/json also forces a CORS preflight on
  // cross-site browsers (text/plain "simple" requests are refused here).
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return unsupportedType();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();

  let inviteCode: unknown;
  try {
    const text = await readLimited(request);
    if (text === null) return tooLarge();
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest();
    inviteCode = (body as Record<string, unknown>).inviteCode;
  } catch {
    return badRequest();
  }
  if (typeof inviteCode !== "string" || inviteCode.length === 0) return badRequest();

  try {
    // Resolve configuration BEFORE spending an invite use: a signing failure after the
    // redeem would burn the invite without giving the driver a token.
    const store = getDriverStore();
    const secret = getSessionSecret();

    if (!(await checkRedeemRateLimit(store, getClientIp(request)))) return tooMany();

    const driver = await store.redeemInvite(inviteCode);
    if (!driver) return invalidInvite();

    const token = signSessionToken({ driverId: driver.driverId, tokenVersion: driver.tokenVersion }, secret);
    // Success only: also expires the legacy refresh-token cookie left on the device (never read here).
    return Response.json(
      { token, driverId: driver.driverId, label: driver.label },
      { headers: { ...NO_STORE, "Set-Cookie": expireLegacyRefreshCookie() } },
    );
  } catch {
    return unavailableResponse();
  }
}

export async function GET(request: Request) {
  const auth = await authorizeDriver(request);
  if (auth instanceof Response) return auth;
  try {
    const driver = await getDriverStore().getDriver(auth.driverId);
    // The legacy owner id has no store record.
    return Response.json({ driverId: auth.driverId, label: driver?.label ?? "Dono" }, { headers: NO_STORE });
  } catch {
    return unavailableResponse();
  }
}
