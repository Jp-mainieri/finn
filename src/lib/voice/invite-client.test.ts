import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVITE_MESSAGES, normalizeInviteCode, redeemInvite } from "./invite-client";
import { TokenStore } from "./token-store";
import { TOKEN_STORAGE_KEY } from "./config";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function setup(res: Response | Error, existing?: string) {
  const storage = memoryStorage();
  if (existing) storage.data.set(TOKEN_STORAGE_KEY, existing);
  const tokens = new TokenStore(() => storage);
  const fetchImpl = vi.fn<typeof fetch>();
  if (res instanceof Error) fetchImpl.mockRejectedValueOnce(res);
  else fetchImpl.mockResolvedValueOnce(res);
  return { storage, tokens, fetchImpl };
}

const CODE = "FINN-ABCD-2345";

describe("redeemInvite", () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  beforeEach(() => spies.forEach((s) => s.mockClear()));
  afterEach(() => spies.forEach((s) => s.mockClear()));

  const consoleOutput = () => JSON.stringify(spies.flatMap((s) => s.mock.calls));

  it("normalises the code (trim, uppercase) before sending, as JSON", async () => {
    const { tokens, fetchImpl } = setup(Response.json({ token: "v1.abc", driverId: "drv_x", label: "Ana" }));
    await redeemInvite("  finn-abcd-2345 \n", { tokens, fetchImpl });
    expect(normalizeInviteCode(" finn-abcd-2345 ")).toBe(CODE);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/session");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ inviteCode: CODE });
  });

  it("valid invite stores the session token only (never the code, driverId or label)", async () => {
    const { tokens, storage, fetchImpl } = setup(Response.json({ token: "v1.abc", driverId: "drv_secretid", label: "Ana" }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: true });
    expect(tokens.get()).toBe("v1.abc");
    expect([...storage.data.entries()]).toEqual([[TOKEN_STORAGE_KEY, "v1.abc"]]);
    const dump = JSON.stringify([...storage.data.values()]);
    expect(dump).not.toContain(CODE);
    expect(dump).not.toContain("drv_secretid");
    expect(consoleOutput()).not.toMatch(/v1\.abc|drv_secretid|FINN-ABCD/);
  });

  it("401 -> the single 'Convite inválido.' message, nothing stored", async () => {
    const { tokens, fetchImpl } = setup(Response.json({ error: "Convite inválido." }, { status: 401 }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "invalid", message: INVITE_MESSAGES.invalid });
    expect(tokens.get()).toBeNull();
  });

  it.each([
    ["900", "Muitas tentativas, tente em 15 min."],
    ["61", "Muitas tentativas, tente em 2 min."],
    ["1", "Muitas tentativas, tente em 1 min."],
  ])("429 with Retry-After %s s shows minutes rounded up", async (retry, message) => {
    const { tokens, fetchImpl } = setup(new Response("{}", { status: 429, headers: { "Retry-After": retry } }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "rate_limited", message });
  });

  it("429 without a usable Retry-After still gets a fixed message", async () => {
    const { tokens, fetchImpl } = setup(new Response("{}", { status: 429 }));
    const r = await redeemInvite(CODE, { tokens, fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((r as { message: string }).message).not.toMatch(/NaN|undefined/);
  });

  it.each([400, 413, 415])("%i -> 'Confira o código.'", async (status) => {
    const { tokens, fetchImpl } = setup(Response.json({ error: "x" }, { status }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "bad_request", message: INVITE_MESSAGES.badRequest });
  });

  it.each([503, 500, 502])("%i -> 'Servidor indisponível, tente de novo.'", async (status) => {
    const { tokens, fetchImpl } = setup(Response.json({ error: "x" }, { status }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "unavailable", message: INVITE_MESSAGES.unavailable });
    expect(tokens.get()).toBeNull();
  });

  it("network failure -> same unavailable message", async () => {
    const { tokens, fetchImpl } = setup(new TypeError("Failed to fetch"));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "unavailable", message: INVITE_MESSAGES.unavailable });
  });

  it("the five failures have distinct messages (401, 429, 400, 503)", () => {
    const messages = new Set([INVITE_MESSAGES.invalid, INVITE_MESSAGES.badRequest, INVITE_MESSAGES.unavailable, "Muitas tentativas, tente em 1 min."]);
    expect(messages.size).toBe(4);
  });

  it.each([
    ["no token", { driverId: "drv_x" }],
    ["empty token", { token: "" }],
    ["blank token", { token: "   " }],
    ["non-string token", { token: 123 }],
    ["null body", null],
  ])("a 200 with %s is not stored and reads as unavailable", async (_n, body) => {
    const { tokens, fetchImpl } = setup(Response.json(body));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(tokens.get()).toBeNull();
  });

  it("a 200 that is not JSON is not stored", async () => {
    const { tokens, fetchImpl } = setup(new Response("<html>", { status: 200 }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(tokens.get()).toBeNull();
  });

  it("an empty code never reaches the network", async () => {
    const { tokens, fetchImpl } = setup(Response.json({}));
    expect(await redeemInvite("   ", { tokens, fetchImpl })).toMatchObject({ ok: false, reason: "bad_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a failed redeem keeps the token that was already saved (legacy or session)", async () => {
    const { tokens, fetchImpl } = setup(Response.json({ error: "x" }, { status: 401 }), "legacy-api-token");
    await redeemInvite(CODE, { tokens, fetchImpl });
    expect(tokens.get()).toBe("legacy-api-token");
  });

  it("'Entrar com outro convite': a new session token overwrites the old one", async () => {
    const { tokens, fetchImpl } = setup(Response.json({ token: "v1.new", driverId: "d", label: "L" }), "v1.old");
    expect(tokens.get()).toBe("v1.old");
    await redeemInvite(CODE, { tokens, fetchImpl });
    expect(tokens.get()).toBe("v1.new");
  });

  it("'Sair deste aparelho': clearing the store erases the saved token", () => {
    const { tokens, storage } = setup(Response.json({}), "v1.old");
    tokens.clear();
    expect(tokens.get()).toBeNull();
    expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
  });
});
