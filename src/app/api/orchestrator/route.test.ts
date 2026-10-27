import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentId, AgentResult, AgentTaskInput } from "@/lib/contracts/a2a";

const h = vi.hoisted(() => ({
  seen: [] as AgentTaskInput[],
  driverId: "drv_" + "B".repeat(22),
}));

vi.mock("@/lib/auth", () => ({
  authorizeDriver: async () => ({ driverId: h.driverId }),
}));
vi.mock("@/agents/registry", () => {
  const make = (id: AgentId) => ({
    id,
    keywords: id === "spotify" ? [/toca/] : [/leva/],
    card: () => {
      throw new Error("unused");
    },
    handle: async (input: AgentTaskInput): Promise<AgentResult> => {
      h.seen.push(input);
      return { agent: id, status: "completed", speech: "ok", clientActions: [], toolCalls: [] };
    },
  });
  return { agents: { spotify: make("spotify"), waze: make("waze") } };
});

import { POST } from "./route";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://x/api/orchestrator", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t", ...headers },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  h.seen.length = 0;
});

describe("POST /api/orchestrator driver identity", () => {
  it("driverId comes only from authorizeDriver; body, driverContext and continuation cannot set it", async () => {
    const HOSTILE = "drv_legacy_owner_000000000";
    const res = await post({
      transcript: "toca rock",
      driverId: HOSTILE,
      driverContext: { driverId: HOSTILE, spotifyRefreshToken: "mine", savedAddresses: { casa: "Rua X, 1" } },
      continuation: { agent: "waze", driverId: HOSTILE, state: { driverId: HOSTILE, pendingLabel: "casa" } },
    });
    expect(res.status).toBe(200);
    expect(h.seen.length).toBeGreaterThan(0);
    for (const input of h.seen) {
      expect(input.driverId).toBe(h.driverId);
      expect(input.driverContext).toEqual({ spotifyRefreshToken: "mine" });
    }
  });

  it("driverContext.savedAddresses never reaches the agents; cookie id is not an identity either", async () => {
    await post(
      { transcript: "toca rock", driverContext: { savedAddresses: { casa: "Rua X, 1" } } },
      { cookie: "driverId=drv_legacy_owner_000000000; finn_spotify_rt=cookie-rt" },
    );
    expect(h.seen[0].driverId).toBe(h.driverId);
    expect(h.seen[0].driverContext).toEqual({ spotifyRefreshToken: "cookie-rt" });
    expect(JSON.stringify(h.seen[0])).not.toContain("Rua X");
  });
});
