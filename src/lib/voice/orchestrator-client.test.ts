import { describe, expect, it, vi } from "vitest";
import type { OrchestratorResponse } from "@/lib/contracts/client-events";
import { OrchestratorClient } from "./orchestrator-client";

const needsAddress: OrchestratorResponse = {
  speech: "Qual o endereço de casa?",
  clientActions: [],
  results: [],
  continuation: { agent: "waze", state: { pendingLabel: "casa" } },
};

const navigating: OrchestratorResponse = {
  speech: "Indo para casa.",
  clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=Rua%20A&navigate=yes", label: "Abrir no Waze" }],
  results: [],
};

function setup(responses: Array<Response | Error>, token: string | null = "s3cret") {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fetchImpl.mockRejectedValueOnce(r);
    else fetchImpl.mockResolvedValueOnce(r);
  }
  let n = 0;
  const client = new OrchestratorClient({
    getToken: () => token,
    fetchImpl,
    newContextId: () => `ctx-${++n}`,
  });
  const bodyOf = (call: number) => JSON.parse(fetchImpl.mock.calls[call][1]!.body as string);
  return { client, fetchImpl, bodyOf };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("OrchestratorClient", () => {
  it("POSTs the transcript with the bearer token and the window's contextId", async () => {
    const { client, fetchImpl, bodyOf } = setup([json(navigating)]);
    client.startWindow();

    const result = await client.send("me leva pra casa");

    expect(result).toEqual({ ok: true, response: navigating });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/orchestrator");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer s3cret");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(bodyOf(0)).toEqual({ transcript: "me leva pra casa", contextId: "ctx-2" });
  });

  it("round-trips the continuation within a window and keeps the contextId stable", async () => {
    const { client, bodyOf } = setup([json(needsAddress), json(navigating), json(navigating)]);
    client.startWindow();

    await client.send("me leva pra casa");
    await client.send("Rua A, 100");
    await client.send("e pro trabalho?");

    expect(bodyOf(0)).toEqual({ transcript: "me leva pra casa", contextId: "ctx-2" });
    expect(bodyOf(1)).toEqual({
      transcript: "Rua A, 100",
      contextId: "ctx-2",
      continuation: { agent: "waze", state: { pendingLabel: "casa" } },
    });
    // The answer had no continuation, so it is not sent again.
    expect(bodyOf(2)).toEqual({ transcript: "e pro trabalho?", contextId: "ctx-2" });
  });

  it("clears the continuation and rotates the contextId when the window closes", async () => {
    const { client, bodyOf } = setup([json(needsAddress), json(navigating)]);
    client.startWindow();
    await client.send("me leva pra casa");
    expect(client.window.continuation).toEqual(needsAddress.continuation);

    client.endWindow();
    client.startWindow();
    await client.send("toca rock");

    expect(bodyOf(1)).toEqual({ transcript: "toca rock", contextId: "ctx-4" });
  });

  it("drops a continuation that arrives after its window closed", async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((r) => (resolve = r)));
    const client = new OrchestratorClient({ getToken: () => "t", fetchImpl });
    const pending = client.send("me leva pra casa");
    client.endWindow();
    resolve(json(needsAddress));
    await pending;
    expect(client.window.continuation).toBeUndefined();
  });

  it("reports 401 as unauthorized", async () => {
    const { client } = setup([json({ error: "Unauthorized" }, 401)]);
    expect(await client.send("toca rock")).toEqual({ ok: false, failure: "unauthorized", status: 401 });
  });

  it("does not call the backend without a token", async () => {
    const { client, fetchImpl } = setup([], null);
    expect(await client.send("toca rock")).toEqual({ ok: false, failure: "unauthorized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 5xx, bad bodies and network errors", async () => {
    const { client } = setup([json({ error: "boom" }, 500), json({ nope: true }), new TypeError("Failed to fetch")]);
    expect(await client.send("a")).toEqual({ ok: false, failure: "server", status: 500 });
    expect(await client.send("b")).toEqual({ ok: false, failure: "server", status: 200 });
    expect(await client.send("c")).toEqual({ ok: false, failure: "network" });
  });

  it("times out slow requests", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")))),
      );
      const client = new OrchestratorClient({ getToken: () => "t", fetchImpl, timeoutMs: 1_000 });
      const pending = client.send("toca rock");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ ok: false, failure: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes driverContext when configured and non-empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(navigating));
    const client = new OrchestratorClient({
      getToken: () => "t",
      fetchImpl,
      getDriverContext: () => ({
        spotifyRefreshToken: "sp-tok",
        savedAddresses: { casa: "Rua A, 1" },
      }),
    });

    await client.send("me leva pra casa");
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.driverContext).toEqual({
      spotifyRefreshToken: "sp-tok",
      savedAddresses: { casa: "Rua A, 1" },
    });
  });
});
