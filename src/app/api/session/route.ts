import { authorizeDriver, unavailableResponse } from "@/lib/auth";
import { getClientIp } from "@/lib/client-ip";
import {
  REDEEM_RATE_LIMIT,
  checkRedeemRateLimit,
  getDriverStore,
  getSessionSecret,
  signSessionToken,
} from "@/lib/driver";

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

export async function POST(request: Request) {
  let inviteCode: unknown;
  try {
    const body: unknown = await request.json();
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
    return Response.json({ token, driverId: driver.driverId, label: driver.label }, { headers: NO_STORE });
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
