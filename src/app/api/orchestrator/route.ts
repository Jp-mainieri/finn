import { agents } from "@/agents/registry";
import { authorizeDriver } from "@/lib/auth";
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

  let driverContext = body.driverContext;
  const cookieToken =
    getCookie(request, "finn_spotify_token") ?? getCookie(request, "finn_spotify_rt");
  const bodyRt = driverContext?.spotifyRefreshToken?.trim();
  const validBodyRt = bodyRt && bodyRt !== "undefined" && bodyRt !== "null" ? bodyRt : undefined;

  if (!validBodyRt && cookieToken) {
    driverContext = { ...driverContext, spotifyRefreshToken: cookieToken };
  } else if (validBodyRt) {
    driverContext = { ...driverContext, spotifyRefreshToken: validBodyRt };
  }

  const response = await orchestrate(transcript, {
    agents,
    contextId: body.contextId || crypto.randomUUID(),
    continuation: body.continuation,
    driverContext,
  });
  return Response.json(response);
}
