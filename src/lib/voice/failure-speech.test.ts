import { describe, expect, it } from "vitest";
import { LOCAL_SPEECH, serverFailureKind } from "./failure-speech";

describe("failure-speech", () => {
  it("maps only 429 and 503", () => {
    expect(serverFailureKind(429)).toBe("rate_limited");
    expect(serverFailureKind(503)).toBe("unavailable");
    for (const s of [200, 400, 401, 500, 502, 504]) expect(serverFailureKind(s)).toBeNull();
  });
  it("keeps the two fixed lines from the contract", () => {
    expect(LOCAL_SPEECH.rate_limited).toBe("Muitas tentativas, tente de novo em instantes.");
    expect(LOCAL_SPEECH.unavailable).toBe("O Finn está fora do ar agora, tente de novo daqui a pouco.");
  });
});
