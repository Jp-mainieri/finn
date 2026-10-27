import { handleConnect } from "@/lib/spotify/connect";

/** Authenticated driver starts the Spotify consent; returns `{ url }`. */
export async function POST(request: Request) {
  return handleConnect(request);
}
