import { timingSafeEqual } from "node:crypto";

/**
 * Simple shared-secret auth for personal use: `Authorization: Bearer <FINN_API_TOKEN>`.
 * Returns an error Response when the request is not authorized, null otherwise.
 * Fails closed when the token is not configured.
 */
export function authorize(request: Request): Response | null {
  const expected = process.env.FINN_API_TOKEN?.trim();
  if (!expected) {
    console.error("[auth] FINN_API_TOKEN is not set; rejecting request");
    return Response.json({ error: "Server auth not configured" }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const token = (header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "").trim();
  const given = Buffer.from(token);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  return null;
}
