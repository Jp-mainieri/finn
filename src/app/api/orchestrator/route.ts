import { agents } from "@/agents/registry";
import { authorize } from "@/lib/auth";
import type { OrchestratorRequest } from "@/lib/contracts/client-events";
import { orchestrate } from "@/orchestrator/orchestrate";

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

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
  if (!driverContext?.spotifyRefreshToken) {
    const cookieToken =
      getCookie(request, "finn_spotify_token") ?? getCookie(request, "finn_spotify_rt");
    if (cookieToken) {
      driverContext = { ...driverContext, spotifyRefreshToken: cookieToken };
    }
  }

  const response = await orchestrate(transcript, {
    agents,
    contextId: body.contextId || crypto.randomUUID(),
    continuation: body.continuation,
    driverContext,
  });
  return Response.json(response);
}
