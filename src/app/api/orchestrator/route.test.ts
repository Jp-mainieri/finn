import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentId, AgentResult, AgentTaskInput } from "@/lib/contracts/a2a";

const h = vi.hoisted(() => ({
  seen: [] as AgentTaskInput[],
  driverId: "drv_" + "B".repeat(22),
}));

vi.mock("@/lib/auth", () => ({
  authorizeDriver: async () => ({ driverId: h.driverId }),
  isOwner: () => false,
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
      expect("driverContext" in input).toBe(false); // nothing of it is read
      expect(JSON.stringify(input)).not.toContain("mine");
    }
  });

  it("driverContext.savedAddresses never reaches the agents; cookie id is not an identity either", async () => {
    await post(
      { transcript: "toca rock", driverContext: { savedAddresses: { casa: "Rua X, 1" } } },
      { cookie: "driverId=drv_legacy_owner_000000000; finn_spotify_rt=cookie-rt" },
    );
    expect(h.seen[0].driverId).toBe(h.driverId);
    expect("driverContext" in h.seen[0]).toBe(false);
    expect(JSON.stringify(h.seen[0])).not.toContain("Rua X");
  });

  it("a Spotify token in the body, driverContext or any finn_spotify_* cookie never reaches the agents (owner and guest)", async () => {
    for (const driverId of ["drv_legacy_owner_000000000", "drv_" + "B".repeat(22)]) {
      h.driverId = driverId;
      h.seen.length = 0;
      await post(
        {
          transcript: "toca rock",
          spotifyRefreshToken: "tok-body",
          refreshToken: "tok-body2",
          driverContext: { spotifyRefreshToken: "tok-ctx" },
        },
        { cookie: "finn_spotify_rt=tok-cookie1; finn_spotify_token=tok-cookie2; finn_spotify_mode=tok-cookie3" },
      );
      expect(h.seen.length).toBeGreaterThan(0);
      for (const input of h.seen) {
        expect(input.driverId).toBe(driverId);
        expect(JSON.stringify(input)).not.toMatch(/tok-/);
      }
    }
    h.driverId = "drv_" + "B".repeat(22);
  });

  it("without a driverContext in the request none is made up (nor with one: the field does not exist for agents)", async () => {
    await post({ transcript: "toca rock" }, { cookie: "finn_spotify_rt=cookie-rt" });
    expect("driverContext" in h.seen[0]).toBe(false);
  });

  it("a continuation over 2 KB is ignored; one within the limit is passed on (the agent parses it strictly)", async () => {
    await post({ transcript: "oi me leva", continuation: { agent: "waze", state: { pendingLabel: "casa", pad: "x".repeat(3000) } } });
    expect(h.seen.length).toBeGreaterThan(0);
    for (const input of h.seen) expect(input.continuation).toBeUndefined();
    h.seen.length = 0;
    await post({ transcript: "Rua A, 1", continuation: { agent: "waze", state: { pendingLabel: "casa" } } });
    expect(h.seen.find((i) => i.continuation !== undefined)?.continuation).toEqual({ pendingLabel: "casa" });
  });

  it.each([["null", "null"], ["array", "[]"], ["number", "5"], ["string", '"x"'], ["true", "true"]])(
    "a JSON body that is %s is 400, never an exception",
    async (_n, raw) => {
      const res = await POST(
        new Request("http://x/api/orchestrator", { method: "POST", headers: { authorization: "Bearer t" }, body: raw }),
      );
      expect(res.status).toBe(400);
      expect(h.seen).toHaveLength(0);
    },
  );

  it("a malformed %-escape in a cookie is never read, so never an exception", async () => {
    const res = await post({ transcript: "toca rock" }, { cookie: "finn_spotify_rt=%E0%A4%A; finn_spotify_token=bad%zz" });
    expect(res.status).toBe(200);
    expect("driverContext" in h.seen[0]).toBe(false);
  });
});
