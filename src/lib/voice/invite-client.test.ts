import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVITE_MESSAGES, normalizeInviteCode, rateLimitedMessage, redeemInvite } from "./invite-client";
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
const TOKEN = "v1.eyJzdWIiOiJkcnZfeCJ9.c2ln";

describe("redeemInvite", () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  beforeEach(() => spies.forEach((s) => s.mockClear()));
  afterEach(() => spies.forEach((s) => s.mockClear()));

  const consoleOutput = () => JSON.stringify(spies.flatMap((s) => s.mock.calls));

  it("sends the cleaned code, as JSON", async () => {
    const { tokens, fetchImpl } = setup(Response.json({ token: TOKEN, driverId: "drv_x", label: "Ana" }));
    await redeemInvite("  finn-abcd-2345 \n", { tokens, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/session");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ inviteCode: CODE });
  });

  it.each([
    ["trim + lower case", " finn-abcd-2345 "],
    ["inner spaces", "FINN ABCD 2345"],
    ["no dashes typed as spaces", "finn abcd-2345"],
    ["en dash", "FINN\u2013ABCD\u20132345"],
    ["minus sign and hyphen variants", "FINN\u2212ABCD\u20102345"],
    ["zero-width characters", "FI\u200BNN-AB\u200DCD-23\uFEFF45\u2060"],
    ["full-width letters and dash", "ＦＩＮＮ－ＡＢＣＤ－２３４５"],
    ["non-breaking space", "FINN-ABCD-2345\u00A0"],
  ])("normalises: %s", (_n, raw) => {
    expect(normalizeInviteCode(raw)).toBe(CODE);
  });

  it.each([
    "",
    "   ",
    "FINN-ABCD-234",
    "FINN-ABCD-23456",
    "FINN-ABCI-2345", // I is not in the alphabet
    "FINN-ABCD-2O45", // O neither
    "FINN-ABC0-2345",
    "XXXX-ABCD-2345",
    "<script>",
    "FINN-ABCD-2345-EXTRA",
    "x".repeat(10_000),
  ])("refuses malformed %j on the phone, with no request (spends no rate-limit attempt)", async (raw) => {
    const { tokens, fetchImpl } = setup(Response.json({}));
    expect(normalizeInviteCode(raw)).toBeNull();
    expect(await redeemInvite(raw, { tokens, fetchImpl })).toEqual({ ok: false, reason: "bad_request", message: INVITE_MESSAGES.badRequest });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("valid invite stores the session token only (never the code, driverId or label)", async () => {
    const { tokens, storage, fetchImpl } = setup(Response.json({ token: TOKEN, driverId: "drv_secretid", label: "Ana" }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: true });
    expect(tokens.get()).toBe(TOKEN);
    expect([...storage.data.entries()]).toEqual([[TOKEN_STORAGE_KEY, TOKEN]]);
    const dump = JSON.stringify([...storage.data.values()]);
    expect(dump).not.toContain(CODE);
    expect(dump).not.toContain("drv_secretid");
    expect(consoleOutput()).not.toMatch(/eyJzdWIi|drv_secretid|FINN-ABCD/);
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
    ["3600", "Muitas tentativas, tente em 60 min."],
    ["99999", "Muitas tentativas, tente em 60 min."], // capped
    ["1666666667", INVITE_MESSAGES.rateLimitedGeneric], // not plain short integer
  ])("429 with Retry-After %s", async (retry, message) => {
    const { tokens, fetchImpl } = setup(new Response("{}", { status: 429, headers: { "Retry-After": retry } }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "rate_limited", message });
  });

  it.each(["0", "-5", "-1", "Infinity", "NaN", "0x10", "1e3", "1.5", "+60", "", "abc", "Wed, 21 Oct 2026 07:28:00 GMT"])(
    "429 with unusable Retry-After %j gets the generic message, never a made-up number",
    (retry) => {
      expect(rateLimitedMessage(retry)).toBe(INVITE_MESSAGES.rateLimitedGeneric);
    },
  );

  it("429 without a Retry-After header gets the generic message", async () => {
    const { tokens, fetchImpl } = setup(new Response("{}", { status: 429 }));
    expect(await redeemInvite(CODE, { tokens, fetchImpl })).toEqual({ ok: false, reason: "rate_limited", message: INVITE_MESSAGES.rateLimitedGeneric });
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

  it("401, 429, 400 and 503/network give four distinct messages (taken from real results)", async () => {
    const msg = async (res: Response | Error) => {
      const { tokens, fetchImpl } = setup(res);
      const r = await redeemInvite(CODE, { tokens, fetchImpl });
      return r.ok ? "ok" : r.message;
    };
    const messages = [
      await msg(Response.json({}, { status: 401 })),
      await msg(new Response("{}", { status: 429, headers: { "Retry-After": "60" } })),
      await msg(Response.json({}, { status: 400 })),
      await msg(Response.json({}, { status: 503 })),
      await msg(new TypeError("net")),
    ];
    expect(new Set(messages).size).toBe(4);
    expect(messages[3]).toBe(messages[4]); // 503 and network share one message
  });

  it.each([
    ["no token", { driverId: "drv_x" }],
    ["empty token", { token: "" }],
    ["blank token", { token: "   " }],
    ["non-string token", { token: 123 }],
    ["token without the v1. prefix", { token: "x" }],
    ["HTML token", { token: "<script>alert(1)</script>" }],
    ["token with a newline", { token: "v1.abc\ndef" }],
    ["token with a non-Latin-1 character", { token: "v1.abc\u2603" }],
    ["token over 1024 characters", { token: `v1.${"a".repeat(1100)}` }],
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
    const { tokens, fetchImpl } = setup(Response.json({ token: TOKEN, driverId: "d", label: "L" }), "v1.old");
    expect(tokens.get()).toBe("v1.old");
    await redeemInvite(CODE, { tokens, fetchImpl });
    expect(tokens.get()).toBe(TOKEN);
  });

  it("'Sair deste aparelho': clearing the store erases the saved token", () => {
    const { tokens, storage } = setup(Response.json({}), "v1.old");
    tokens.clear();
    expect(tokens.get()).toBeNull();
    expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
  });

  it("a request that never answers ends as 'unavailable' instead of hanging on 'Entrando…'", async () => {
    vi.useFakeTimers();
    try {
      const { tokens } = setup(Response.json({}));
      const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
      const p = redeemInvite(CODE, { tokens, fetchImpl, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await p).toEqual({ ok: false, reason: "unavailable", message: INVITE_MESSAGES.unavailable });
      expect(tokens.get()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an external cancel ends the request without storing anything", async () => {
    const { tokens } = setup(Response.json({}));
    const abort = new AbortController();
    let release!: (r: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((r) => (release = r)));
    const p = redeemInvite(CODE, { tokens, fetchImpl, signal: abort.signal });
    abort.abort();
    release(Response.json({ token: TOKEN }));
    expect(await p).toMatchObject({ ok: false, reason: "unavailable" });
    expect(tokens.get()).toBeNull();
  });
});
