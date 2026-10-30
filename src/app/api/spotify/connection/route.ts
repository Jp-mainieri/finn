import { handleConnectionStatus, handleDisconnect } from "@/lib/spotify/connect";

export async function GET(request: Request) {
  return handleConnectionStatus(request);
}

export async function DELETE(request: Request) {
  return handleDisconnect(request);
}
