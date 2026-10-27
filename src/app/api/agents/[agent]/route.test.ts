import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetA2ADisabledLogForTests } from "@/lib/auth";
import { TEST_OWNER_ID } from "../../../../../tests/helpers/owner";
import type { AgentResult, AgentTaskInput } from "@/lib/contracts/a2a";

const seen: AgentTaskInput[] = [];
const RESULT: AgentResult = {
  agent: "waze",
  status: "input-required",
  speech: "Qual é o endereço da sua casa?",
  clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=Rua%20Secreta%2C%201&navigate=yes", label: "Navegar para Rua Secreta, 1" }],
  toolCalls: [{ name: "navigate_to", arguments: { destination: "Rua Secreta, 1" }, result: { navigating_to: "Rua Secreta, 1" }, ok: true }],
  continuation: { pendingLabel: "casa" },
};

vi.mock("@/agents/registry", () => {
  const agent = {
    id: "waze",
    card: () => ({}),
    handle: async (input: AgentTaskInput) => {
      seen.push(input);
      return RESULT;
    },
  };
  return { getAgent: (id: string) => (id === "waze" ? agent : undefined), agents: { waze: agent } };
});

import { POST } from "./route";

const A2A = "9c1e47d2b86a30f5e7d4c2a91b68f03e5d7a24c9e1b0836f4a5d2c7e91f0b3a8";
const WRONG = "e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f30211203f4e5d6c7b8a9f0";
const NEXT = "5d2b8f1a7c3e904d6b1a8e5f2c7d03a94b6e1f8c5a2d7039e4b1c6f8a5d20e73";
let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

function call(body: unknown, opts: { token?: string; ip?: string; agent?: string } = {}) {
  return POST(
    new Request("http://x/api/agents/waze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token ?? A2A}`,
        "x-vercel-forwarded-for": opts.ip ?? freshIp(),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ agent: opts.agent ?? "waze" }) } as never,
  );
}

const rpc = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "message/send",
  params: { message: { kind: "message", messageId: "m", role: "user", parts, ...extra } },
});

beforeEach(() => {
  seen.length = 0;
  resetA2ADisabledLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("FINN_A2A_TOKEN", A2A);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/agents/[agent]", () => {
  it("returns 429 after 10 failures from one IP, then keeps refusing, with Retry-After", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 10; i++) expect((await call(rpc([]), { token: WRONG, ip })).status).toBe(401);
    const res = await call(rpc([{ kind: "text", text: "oi" }]), { ip });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(seen).toHaveLength(0);
  });

  it("without an IP the 'noip' bucket (limit 3) applies", async () => {
    const mk = (token: string) =>
      POST(
        new Request("http://x/api/agents/waze", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" }),
        { params: Promise.resolve({ agent: "waze" }) } as never,
      );
    for (let i = 0; i < 3; i++) expect((await mk(WRONG)).status).toBe(401);
    expect((await mk(WRONG)).status).toBe(429);
    expect((await mk(A2A)).status).toBe(429);
  });

  it("accepts both secrets during a rotation", async () => {
    vi.stubEnv("FINN_A2A_TOKEN_NEXT", NEXT);
    for (const token of [A2A, NEXT]) {
      const res = await call(rpc([{ kind: "text", text: "me leva pra casa" }]), { token });
      expect(res.status).toBe(200);
    }
    expect(seen).toHaveLength(2);
  });

  it("runs as the owner and ignores any driverId in the message, its parts, data parts or continuation", async () => {
    const OTHER = "drv_" + "B".repeat(22);
    await call({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      driverId: OTHER,
      params: {
        driverId: OTHER,
        driverContext: { driverId: OTHER, savedAddresses: { casa: "x" } },
        message: {
          kind: "message",
          messageId: "m",
          role: "user",
          driverId: OTHER,
          metadata: { driverId: OTHER },
          parts: [
            { kind: "text", text: "me leva pra casa", driverId: OTHER },
            { kind: "data", data: { driverId: OTHER, continuation: { pendingLabel: "casa", driverId: OTHER } } },
          ],
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].driverId).toBe(TEST_OWNER_ID);
    expect(seen[0].driverContext).toBeUndefined();
    // The raw continuation is handed over (the real agent parses it strictly); nothing else carries the id.
    expect(JSON.stringify({ ...seen[0], continuation: undefined })).not.toContain(OTHER);
  });

  it("the artifact for the external client is only { agent, status, speech }: no toolCalls, no clientActions", async () => {
    const res = await call(rpc([{ kind: "text", text: "me leva pra casa" }]));
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.result.artifacts[0].parts[0].data).toEqual({
      agent: "waze",
      status: "input-required",
      speech: "Qual é o endereço da sua casa?",
    });
    expect(text).not.toMatch(/toolCalls|clientActions|Secreta|waze\.com|pendingLabel|continuation/);
  });

  it("hostile or oversized continuation never reaches the agent in a usable form", async () => {
    const huge = { pendingLabel: "casa", pad: "x".repeat(3000) };
    await call(rpc([{ kind: "text", text: "oi" }, { kind: "data", data: { continuation: huge } }]));
    expect(seen[0].continuation).toBeUndefined();
    await call(rpc([{ kind: "text", text: "oi" }, { kind: "data", data: { continuation: { pendingLabel: "casa" } } }]));
    expect(seen[1].continuation).toEqual({ pendingLabel: "casa" }); // within 2 KB: the agent parses it strictly
  });

  it("malformed JSON-RPC bodies are answered, not 500", async () => {
    for (const body of [{ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: "nope" } } }, { jsonrpc: "2.0", id: 1, method: "message/send" }, { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [null, 1, { kind: "text", text: 5 }] } } }]) {
      const res = await call(body);
      expect(res.status).toBe(200);
      expect((await res.json()).error?.code).toBe(-32602);
    }
    expect(seen).toHaveLength(0);
  });

  it("unknown agent 404 only after authorization", async () => {
    expect((await call(rpc([]), { agent: "nope" })).status).toBe(404);
    expect((await call(rpc([]), { agent: "nope", token: WRONG })).status).toBe(401);
  });
});
