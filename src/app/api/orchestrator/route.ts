import { agents } from "@/agents/registry";
import { authorizeDriver } from "@/lib/auth";
import { boundedContinuation } from "@/lib/continuation";
import type { OrchestratorRequest } from "@/lib/contracts/client-events";
import { orchestrate } from "@/orchestrator/orchestrate";

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function POST(request: Request) {
  const auth = await authorizeDriver(request);
  if (auth instanceof Response) return auth;

  let body: Partial<OrchestratorRequest>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return Response.json({ error: "`transcript` is required" }, { status: 400 });
  }

  // Only the Spotify token of the device is taken from the client (theirs, until delivery 4).
  // Any other driverContext field (savedAddresses, a stray driverId...) is dropped here.
  const cookieToken =
    getCookie(request, "finn_spotify_token") ?? getCookie(request, "finn_spotify_rt");
  const rawRt = body.driverContext?.spotifyRefreshToken;
  const bodyRt = typeof rawRt === "string" ? rawRt.trim() : undefined;
  const validBodyRt = bodyRt && bodyRt !== "undefined" && bodyRt !== "null" ? bodyRt : undefined;
  const spotifyRefreshToken = validBodyRt ?? cookieToken;
  // Presence of a context (even empty) is what makes the waze agent keep emitting `save_address`
  // for the current PWA; its content is never trusted beyond the Spotify token.
  const driverContext =
    (typeof body.driverContext === "object" && body.driverContext !== null) || cookieToken
      ? spotifyRefreshToken
        ? { spotifyRefreshToken }
        : {}
      : undefined;

  const response = await orchestrate(transcript, {
    agents,
    contextId: typeof body.contextId === "string" && body.contextId ? body.contextId : crypto.randomUUID(),
    // Untrusted and unsigned: at most 2 KB, then parsed strictly by the agent. Never carries identity.
    continuation: boundedContinuation(body.continuation),
    driverId: auth.driverId,
    driverContext,
  });
  return Response.json(response);
}
