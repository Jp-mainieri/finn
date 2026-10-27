/**
 * QA, delivery 5a: an old cached PWA still sends `driverContext` (+ savedAddresses/spotifyRefreshToken).
 * Real /api/orchestrator route, real auth (legacy token -> owner), real waze agent, mock model.
 * The presence of the field must change nothing: same response, same writes, no save_address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_OWNER_ID } from "../helpers/owner";
import type { NeuralakeClient } from "@/lib/contracts/neuralake";
import { MockNeuralakeClient, textMessage, toolCallMessage, type MockScript } from "@/lib/neuralake/mock";
import { getAddressBook, resetAddressBook } from "@/lib/waze/address-book";

const mocks = vi.hoisted(() => ({ client: undefined as NeuralakeClient | undefined }));
vi.mock("@/lib/neuralake/client", () => ({
  getNeuralakeClient: () => {
    if (!mocks.client) throw new Error("no client");
    return mocks.client;
  },
}));

import { POST } from "@/app/api/orchestrator/route";

const API = "legacy-api-token-0123456789abcdef";

function navigateScript(destination: string): MockScript {
  return (req) => {
    const last = req.messages.at(-1);
    if (last?.role !== "tool") return toolCallMessage("navigate_to", { destination });
    const out = JSON.parse(last.content);
    if (out.needs_address) return textMessage(`Qual é o endereço da sua ${out.needs_address}?`);
    return textMessage(`Beleza, rota para ${out.navigating_to}.`);
  };
}

const post = (body: unknown, raw?: string) =>
  POST(
    new Request("http://x/api/orchestrator", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API}` },
      body: raw ?? JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.stubEnv("FINN_API_TOKEN", API);
  vi.stubEnv("FINN_LEGACY_TOKEN_ENABLED", "1");
  vi.stubEnv("FINN_OWNER_DRIVER_ID", TEST_OWNER_ID);
  vi.stubEnv("WAZE_SAVED_ADDRESSES", "");
  vi.stubEnv("NODE_ENV", "test");
  resetAddressBook();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetAddressBook();
  mocks.client = undefined;
});

const HOSTILE_CONTEXTS: unknown[] = [
  {},
  { savedAddresses: { casa: "Rua do Cache, 1", trabalho: "Av Cache, 2" }, spotifyRefreshToken: "SECRET-RT" },
  { savedAddresses: "not-an-object" },
  null,
  [],
  "string",
  42,
  { __proto__: { isAdmin: true }, driverId: "drv_" + "Z".repeat(22) },
  { savedAddresses: { casa: "x".repeat(200_000) } },
];

describe("old PWA body", () => {
  it("every shape of driverContext yields the same response as no driverContext (status, speech, actions), 200 and no save_address", async () => {
    mocks.client = new MockNeuralakeClient(navigateScript("Rua Oscar Freire, 100"));
    const first = await post({ transcript: "me leva pra casa" });
    const base = await post({ transcript: "Rua Oscar Freire, 100", continuation: { agent: "waze", state: { pendingLabel: "casa" } } });
    const baseJson = await base.json();
    expect(first.status).toBe(200);
    expect(base.status).toBe(200);
    for (const ctx of HOSTILE_CONTEXTS) {
      resetAddressBook();
      mocks.client = new MockNeuralakeClient(navigateScript("Rua Oscar Freire, 100"));
      const res = await post({ transcript: "Rua Oscar Freire, 100", continuation: { agent: "waze", state: { pendingLabel: "casa" } }, driverContext: ctx });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual(baseJson);
      expect(JSON.stringify(json)).not.toContain("save_address");
      expect(JSON.stringify(json)).not.toContain("SECRET-RT");
      // the server saved ONLY what the driver said (to the owner's book), never the cached client values
      expect(await getAddressBook(TEST_OWNER_ID).get("casa")).toBe("Rua Oscar Freire, 100");
      expect(await getAddressBook(TEST_OWNER_ID).get("trabalho")).toBeUndefined();
    }
  });

  it("a client-side saved 'casa' is NOT used by the server to navigate (asks again) with or without driverContext", async () => {
    for (const body of [
      { transcript: "me leva pra casa" },
      { transcript: "me leva pra casa", driverContext: { savedAddresses: { casa: "Rua do Cache, 1" } } },
    ]) {
      resetAddressBook();
      mocks.client = new MockNeuralakeClient(navigateScript("casa"));
      const res = await post(body);
      const json = (await res.json()) as { speech: string; continuation?: unknown };
      expect(res.status).toBe(200);
      expect(json.speech).toContain("Qual é o endereço da sua casa?");
      expect(JSON.stringify(json)).not.toContain("Rua do Cache");
    }
  });

  it("malformed / non-object bodies still 400 (unchanged)", async () => {
    expect((await post(null, "not json")).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post("str")).status).toBe(400);
    expect((await post({ driverContext: {} })).status).toBe(400);
  });
});
