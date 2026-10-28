import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVER_SETTINGS_STORAGE_KEY, TOKEN_STORAGE_KEY } from "./config";
import type { DelegationHandler } from "./delegation-handler";
import { LOCAL_SPEECH } from "./failure-speech";
import { TokenStore } from "./token-store";
import type { TranscriptBuffer } from "./transcript-buffer";
import { VoiceController } from "./voice-controller";
import type { VoiceSession } from "./voice-session";

/**
 * The VoiceController runs in the node environment with a stubbed `window` and `fetch`:
 * no DOM library needed. Everything here is the glue the pure modules cannot prove on
 * their own (which screen shows, which token survives, what a late answer may touch).
 */

const CODE = "FINN-ABCD-2345";
const SESSION_TOKEN = "v1.eyJzdWIiOiJkcnZfeCJ9.c2ln";
const SPOTIFY_URL = "https://accounts.spotify.com/authorize?state=s";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

type Internals = {
  transcripts: TranscriptBuffer;
  delegations: DelegationHandler;
  session: VoiceSession | null;
  update: (patch: Record<string, unknown>) => void;
  greetDriver: (session: VoiceSession) => Promise<void>;
};
const internals = (c: VoiceController) => c as unknown as Internals;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bearerOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get("authorization");

describe("VoiceController", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let assign: ReturnType<typeof vi.fn>;
  let replaceState: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  function stubWindow(location: { search?: string; hash?: string } = {}) {
    vi.stubGlobal("window", {
      localStorage: storage,
      location: { assign, search: "", hash: "", pathname: "/", ...location },
      history: { replaceState },
      dispatchEvent: () => true,
    });
  }
  const make = (token?: string, location?: { search?: string; hash?: string }) => {
    storage = memoryStorage(token ? { [TOKEN_STORAGE_KEY]: token } : {});
    stubWindow(location);
    return new VoiceController(new TokenStore(() => storage));
  };

  beforeEach(() => {
    assign = vi.fn();
    replaceState = vi.fn();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** One delegation through the real handler/orchestrator client, as the voice session would. */
  async function delegate(c: VoiceController, text = "toca rock") {
    vi.useFakeTimers();
    internals(c).transcripts.add({ delta: text, startMs: 0, endMs: 500 });
    const p = internals(c).delegations.handle({ id: "d1", offsetMs: 1000 });
    await vi.runAllTimersAsync();
    await p;
    vi.useRealTimers();
  }

  function fakeSession() {
    return {
      connect: async () => {},
      close: async () => {},
      speak: vi.fn(() => "evt"),
      speakLocal: vi.fn(),
    } satisfies VoiceSession;
  }

  describe("stored token", () => {
    it("a stored legacy token skips the invite screen and is the one sent to the server", async () => {
      const c = make("legacy-api-token");
      expect(c.getView()).toMatchObject({ needsToken: false, tokenRejected: false });
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce(json({ speech: "ok", clientActions: [], results: [] }));
      await delegate(c);
      expect(fetchMock.mock.calls[0][0]).toBe("/api/orchestrator");
      expect(bearerOf(fetchMock.mock.calls[0])).toBe("Bearer legacy-api-token");
    });

    it("no token: the invite screen shows and cannot be dismissed", () => {
      const c = make();
      expect(c.getView().needsToken).toBe(true);
      c.cancelInvite();
      expect(c.getView().needsToken).toBe(true);
    });

    it("a garbage token in storage is discarded: invite screen, storage cleaned", () => {
      const c = make("v1.<script>");
      expect(c.getView().needsToken).toBe(true);
      expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
    });
  });

  describe("401 from the server", () => {
    it("from the orchestrator: back to the invite screen, token erased, no cancel offered", async () => {
      const c = make("v1.rejected");
      fetchMock.mockResolvedValueOnce(json({}, 401));
      await delegate(c);
      expect(c.getView()).toMatchObject({ needsToken: true, tokenRejected: true, canCancelInvite: false });
      expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
    });

    it.each([
      ["connection", (c: VoiceController) => c.refreshSpotify()],
      ["connect", (c: VoiceController) => c.connectSpotify()],
      ["disconnect", (c: VoiceController) => c.disconnectSpotify()],
    ])("from the Spotify %s route: back to the invite screen, token erased, nothing navigated", async (_n, act) => {
      const c = make("v1.rejected");
      fetchMock.mockResolvedValue(json({}, 401));
      await act(c);
      expect(c.getView()).toMatchObject({ needsToken: true, tokenRejected: true, canCancelInvite: false });
      expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe("another invite and sign out", () => {
    it("'Entrar com outro convite' keeps the token until a new one is redeemed, and Cancel changes nothing", () => {
      const c = make("v1.old");
      c.openInvite();
      expect(c.getView()).toMatchObject({ needsToken: true, canCancelInvite: true, tokenRejected: false });
      expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe("v1.old");
      c.cancelInvite();
      expect(c.getView()).toMatchObject({ needsToken: false, canCancelInvite: false });
      expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe("v1.old");
    });

    it("failed redeems keep the old token and the screen; a success overwrites the token", async () => {
      const c = make("v1.old");
      c.openInvite();
      fetchMock.mockResolvedValueOnce(json({}, 401));
      expect(await c.redeemInvite(CODE)).toMatchObject({ ok: false, reason: "invalid" });
      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "600" } }));
      expect(await c.redeemInvite(CODE)).toMatchObject({ ok: false, reason: "rate_limited" });
      fetchMock.mockRejectedValueOnce(new TypeError("net"));
      expect(await c.redeemInvite(CODE)).toMatchObject({ ok: false, reason: "unavailable" });
      expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe("v1.old");
      expect(c.getView().needsToken).toBe(true);

      fetchMock.mockResolvedValueOnce(json({ token: SESSION_TOKEN, driverId: "drv_x", label: "L" }));
      expect(await c.redeemInvite(CODE)).toEqual({ ok: true });
      expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe(SESSION_TOKEN);
      expect(c.getView()).toMatchObject({ needsToken: false, tokenRejected: false, canCancelInvite: false });
    });

    it("the redeem request carries the cleaned code and no Authorization header", async () => {
      const c = make();
      fetchMock.mockResolvedValueOnce(json({ token: SESSION_TOKEN }));
      await c.redeemInvite(" finn abcd 2345 ");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/session");
      expect(JSON.parse(init.body as string)).toEqual({ inviteCode: CODE });
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    });

    it("'Sair deste aparelho' erases the token and shows the invite screen", () => {
      const c = make("v1.old");
      c.signOut();
      expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
      expect(c.getView()).toMatchObject({ needsToken: true, canCancelInvite: false });
    });

    it.each([
      ["signOut", (c: VoiceController) => c.signOut()],
      ["openInvite", (c: VoiceController) => c.openInvite()],
    ])("%s clears the previous driver's captions, pending actions and Spotify state", (_n, leave) => {
      const c = make("v1.old");
      internals(c).update({
        userText: "me leva pra Rua Augusta, 123",
        assistantText: "Indo para Rua Augusta",
        pendingActions: [{ id: "a", url: "https://waze.com/ul?q=x", label: "Abrir no Waze" }],
        spotify: { status: "connected" },
      });
      leave(c);
      expect(c.getView()).toMatchObject({ userText: "", assistantText: "", pendingActions: [], spotify: { status: "unknown" } });
    });

    it("a new invite also clears the previous driver's captions", async () => {
      const c = make("v1.old");
      c.openInvite();
      internals(c).update({ userText: "endereço do motorista A", assistantText: "resposta para A" });
      fetchMock.mockResolvedValueOnce(json({ token: SESSION_TOKEN }));
      await c.redeemInvite(CODE);
      expect(c.getView()).toMatchObject({ userText: "", assistantText: "" });
    });

    it("an orchestrator answer that lands after sign out is dropped: no speech, no actions", async () => {
      const c = make("v1.a");
      const session = fakeSession();
      internals(c).session = session;
      let release!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));

      vi.useFakeTimers();
      internals(c).transcripts.add({ delta: "me leva pra casa", startMs: 0, endMs: 500 });
      const p = internals(c).delegations.handle({ id: "d1", offsetMs: 1000 });
      await vi.runAllTimersAsync();
      c.signOut();
      release(json({ speech: "Indo para a casa da Ana", clientActions: [{ type: "open_url", url: "https://waze.com/ul?q=casa", label: "Waze" }], results: [] }));
      await p;
      vi.useRealTimers();

      expect(session.speak).not.toHaveBeenCalled();
      expect(c.getView().pendingActions).toEqual([]);
    });

    it("signing out while 'Conectar Spotify' is in flight never navigates", async () => {
      const c = make("v1.a");
      let release!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
      const pending = c.connectSpotify();
      c.signOut();
      release(json({ url: SPOTIFY_URL }));
      await pending;
      expect(assign).not.toHaveBeenCalled();
      expect(c.getView().spotify).toEqual({ status: "unknown" });
    });

    it("switching invite while 'Conectar Spotify' is in flight never navigates either", async () => {
      const c = make("v1.a");
      let release!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
      const pending = c.connectSpotify();
      c.openInvite();
      release(json({ url: SPOTIFY_URL }));
      await pending;
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe("Spotify connection", () => {
    it("navigates (same window) only to the consent page; a tampered URL never reaches location.assign", async () => {
      const c = make("v1.t");
      fetchMock.mockResolvedValueOnce(json({ url: "https://evil.example/" }));
      await c.connectSpotify();
      expect(assign).not.toHaveBeenCalled();
      fetchMock.mockResolvedValueOnce(json({ url: SPOTIFY_URL }));
      await c.connectSpotify();
      expect(assign).toHaveBeenCalledExactlyOnceWith(SPOTIFY_URL);
    });

    it("onVisible re-reads the state only while Settings are open and a token exists", async () => {
      const c = make("v1.t");
      fetchMock.mockImplementation(async () => json({ connected: true }));
      await c.onVisible();
      expect(fetchMock).not.toHaveBeenCalled();

      c.setSettingsOpen(true); // read #1, on open
      await vi.waitFor(() => expect(c.getView().spotify).toEqual({ status: "connected" }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bearerOf(fetchMock.mock.calls[0])).toBe("Bearer v1.t");

      fetchMock.mockImplementation(async () => json({ connected: false }));
      await c.onVisible(); // back from the Spotify page
      await vi.waitFor(() => expect(c.getView().spotify).toEqual({ status: "disconnected" }));
      expect(fetchMock).toHaveBeenCalledTimes(2);

      c.setSettingsOpen(false);
      await c.onVisible();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("an older read that resolves last does not overwrite the newer state", async () => {
      const c = make("v1.t");
      let releaseOld!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (releaseOld = r)));
      const old = c.refreshSpotify();
      fetchMock.mockResolvedValueOnce(json({ connected: false }));
      await c.refreshSpotify();
      expect(c.getView().spotify).toEqual({ status: "disconnected" });
      releaseOld(json({ connected: true }));
      await old;
      expect(c.getView().spotify).toEqual({ status: "disconnected" });
    });

    it("a request that never answers ends as the fixed error instead of staying on 'loading'", async () => {
      const c = make("v1.t");
      fetchMock.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      const p = c.refreshSpotify();
      await vi.advanceTimersByTimeAsync(15_000);
      await p;
      vi.useRealTimers();
      expect(c.getView().spotify).toMatchObject({ status: "error" });
    });

    it("never writes a Spotify refresh token or an address to localStorage", async () => {
      const c = make("v1.t");
      const set = vi.spyOn(storage, "setItem");
      fetchMock.mockResolvedValue(json({ connected: true }));
      await c.refreshSpotify();
      await c.disconnectSpotify();
      expect(set.mock.calls.filter(([k]) => k !== TOKEN_STORAGE_KEY && k !== DRIVER_SETTINGS_STORAGE_KEY)).toEqual([]);
    });
  });

  describe("startup cleanup", () => {
    it("purges the old settings blob (Spotify token, typed addresses) and keeps the voice preference", () => {
      storage = memoryStorage({
        [DRIVER_SETTINGS_STORAGE_KEY]: JSON.stringify({ ttsMode: "openai", spotifyRefreshToken: "SECRET", casa: "Rua X", trabalho: "Av Y" }),
      });
      stubWindow();
      new VoiceController(new TokenStore(() => storage));
      const raw = storage.data.get(DRIVER_SETTINGS_STORAGE_KEY)!;
      expect(raw).not.toMatch(/SECRET|Rua X|Av Y/);
      expect(JSON.parse(raw).ttsMode).toBe("openai");
    });

    it("strips ?spotify_refresh_token= from the URL", () => {
      make("v1.t", { search: "?spotify_refresh_token=AQD-secret" });
      expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/");
    });

    it("leaves a normal URL alone", () => {
      make("v1.t");
      expect(replaceState).not.toHaveBeenCalled();
    });
  });

  describe("local speech for 429 and 503 (phone TTS, no network)", () => {
    it.each([
      [429, LOCAL_SPEECH.rate_limited],
      [503, LOCAL_SPEECH.unavailable],
    ])("a %i from the orchestrator is spoken with speakLocal, never with the networked speak", async (status, line) => {
      const c = make("v1.t");
      const session = fakeSession();
      internals(c).session = session;
      fetchMock.mockResolvedValueOnce(json({}, status));
      await delegate(c);
      expect(session.speakLocal).toHaveBeenCalledExactlyOnceWith(line);
      expect(session.speak).not.toHaveBeenCalled();
    });

    it.each([
      [429, LOCAL_SPEECH.rate_limited],
      [503, LOCAL_SPEECH.unavailable],
    ])("a %i on the greeting is spoken with speakLocal, never with the networked speak", async (status, line) => {
      const c = make("v1.t");
      const session = fakeSession();
      internals(c).session = session;
      fetchMock.mockResolvedValueOnce(json({}, status));
      await internals(c).greetDriver(session);
      expect(session.speakLocal).toHaveBeenCalledExactlyOnceWith(line);
      expect(session.speak).not.toHaveBeenCalled();
    });
  });

  describe("daily limit (429 with scope 'day')", () => {
    const dayBody = () => json({ error: "Too many requests", scope: "day" }, 429);

    it("is spoken with speakLocal on a delegation, never with the networked speak", async () => {
      const c = make("v1.t");
      const session = fakeSession();
      internals(c).session = session;
      fetchMock.mockResolvedValueOnce(dayBody());
      await delegate(c);
      expect(session.speakLocal).toHaveBeenCalledExactlyOnceWith(LOCAL_SPEECH.day_limited);
      expect(session.speak).not.toHaveBeenCalled();
    });

    it("is spoken with speakLocal on the greeting", async () => {
      const c = make("v1.t");
      const session = fakeSession();
      internals(c).session = session;
      fetchMock.mockResolvedValueOnce(dayBody());
      await internals(c).greetDriver(session);
      expect(session.speakLocal).toHaveBeenCalledExactlyOnceWith(LOCAL_SPEECH.day_limited);
      expect(session.speak).not.toHaveBeenCalled();
    });

    it("scope 'burst' on the greeting is still the generic line", async () => {
      const c = make("v1.t");
      const session = fakeSession();
      internals(c).session = session;
      fetchMock.mockResolvedValueOnce(json({ scope: "burst" }, 429));
      await internals(c).greetDriver(session);
      expect(session.speakLocal).toHaveBeenCalledExactlyOnceWith(LOCAL_SPEECH.rate_limited);
    });
  });
});
