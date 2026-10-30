import { handleCallback } from "@/lib/spotify/connect";

/** OAuth redirect target. Public, but only does anything with a live single-use `state` (see lib/spotify/connect). */
export async function GET(request: Request) {
  return handleCallback(request);
}
