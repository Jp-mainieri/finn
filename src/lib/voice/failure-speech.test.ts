import { describe, expect, it } from "vitest";
import { LOCAL_SPEECH, classifyServerFailure } from "./failure-speech";

const res = (status: number, body?: BodyInit | null) => new Response(body ?? null, { status });
const withScope = (scope: unknown, status = 429) => res(status, JSON.stringify({ error: "Too many requests", scope }));

describe("failure-speech", () => {
  it("keeps the fixed lines", () => {
    expect(LOCAL_SPEECH.rate_limited).toBe("Muitas tentativas, tente de novo em instantes.");
    expect(LOCAL_SPEECH.day_limited).toBe("Você atingiu o limite de uso de hoje. Volte amanhã.");
    expect(LOCAL_SPEECH.unavailable).toBe("O Finn está fora do ar agora, tente de novo daqui a pouco.");
  });

  it("maps 503 to unavailable and ignores other statuses (without reading the body)", async () => {
    expect(await classifyServerFailure(res(503))).toBe("unavailable");
    for (const s of [200, 400, 401, 500, 502, 504]) expect(await classifyServerFailure(withScope("day", s))).toBeNull();
  });

  it("a 429 with scope exactly 'day' is day_limited", async () => {
    expect(await classifyServerFailure(withScope("day"))).toBe("day_limited");
  });

  it("a 429 with scope 'burst' is the generic rate limit", async () => {
    expect(await classifyServerFailure(withScope("burst"))).toBe("rate_limited");
  });

  it.each([
    ["missing scope", res(429, JSON.stringify({ error: "Too many requests" }))],
    ["null", withScope(null)],
    ["number", withScope(1)],
    ["object", withScope({ day: true })],
    ["array", withScope(["day"])],
    ["DAY", withScope("DAY")],
    ["Day", withScope("Day")],
    [" day", withScope(" day")],
    ["day ", withScope("day ")],
    ["day\\n", withScope("day\n")],
    ["today", withScope("today")],
    ["day,burst", withScope("day,burst")],
    ["empty string", withScope("")],
    ["body is a string", res(429, JSON.stringify("day"))],
    ["body is an array", res(429, JSON.stringify(["day"]))],
    ["body is null", res(429, "null")],
    ["no body", res(429)],
    ["empty body", res(429, "")],
    ["non-JSON body", res(429, "<html>day</html>")],
    ["truncated JSON", res(429, '{"scope":"day"')],
    ["huge body with scope day inside", res(429, JSON.stringify({ scope: "day", pad: "x".repeat(200_000) }))],
  ])("429 with %s falls to the generic text and does not throw", async (_n, response) => {
    await expect(classifyServerFailure(response)).resolves.toBe("rate_limited");
  });

  it("a body that never ends does not hang the app", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    expect(await classifyServerFailure(new Response(stream, { status: 429 }))).toBe("rate_limited");
  }, 5_000);

  it("a body that errors mid-read does not throw", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("boom"));
      },
    });
    expect(await classifyServerFailure(new Response(stream, { status: 429 }))).toBe("rate_limited");
  });

  it("the day text never shows up for a 503, whatever the body says", async () => {
    expect(await classifyServerFailure(withScope("day", 503))).toBe("unavailable");
  });
});
