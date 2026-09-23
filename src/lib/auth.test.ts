import { afterEach, describe, expect, it, vi } from "vitest";
import { authorize } from "./auth";

const req = (auth?: string) =>
  new Request("http://x/api/orchestrator", { headers: auth ? { authorization: auth } : {} });

describe("authorize", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed when FINN_API_TOKEN is unset", () => {
    vi.stubEnv("FINN_API_TOKEN", "");
    expect(authorize(req("Bearer anything"))?.status).toBe(503);
  });

  it("rejects missing or wrong tokens", () => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    expect(authorize(req())?.status).toBe(401);
    expect(authorize(req("Bearer nope"))?.status).toBe(401);
    expect(authorize(req("s3cret"))?.status).toBe(401);
  });

  it("accepts the right bearer token", () => {
    vi.stubEnv("FINN_API_TOKEN", "s3cret");
    expect(authorize(req("Bearer s3cret"))).toBeNull();
  });
});
