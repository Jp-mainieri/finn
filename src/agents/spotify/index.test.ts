import { TEST_OWNER_ID } from "../../../tests/helpers/owner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, CompletionRequest } from "@/lib/contracts/neuralake";
import { SPOTIFY_TOOLS } from "@/lib/contracts/tools";
import { MockNeuralakeClient, textMessage, toolCallMessage, type MockScript } from "@/lib/neuralake/mock";
import { NO_DEVICE_SPEECH } from "@/lib/spotify/api";
import { AUTH_FAILED_SPEECH, NOT_CONFIGURED_SPEECH, resetSpotifyTokenCache } from "@/lib/spotify/auth";
import { API, createFakeSpotify, spotifyError, stubSpotifyEnv, useTestTokenVault, type FakeSpotifyOptions } from "@/lib/spotify/testing";
import { spotifyAgent, spotifyFastSpeech } from ".";

const holder = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@/lib/neuralake/client", () => ({ getNeuralakeClient: () => holder.client }));

const PLAYLISTS = [
  { id: "p1", name: "Rock Nacional" },
  { id: "p2", name: "Músicas para Viajar" },
  { id: "p3", name: "Treino Pesado" },
  { id: "p4", name: "Lo-Fi Beats" },
  { id: "p5", name: "Jazz" },
  { id: "p6", name: "Sertanejo" },
];

/**
 * Replays assistant messages in order, one per model call. `seen[i]` is the
 * tool result the model had just received on call i (the runtime mutates the
 * messages array, so it must be captured at call time).
 */
function scripted(...steps: AssistantMessage[]) {
  let i = 0;
  const seen: unknown[] = [];
  const script: MockScript = (req) => {
    seen.push(lastToolResult(req));
    const step = steps[i++];
    if (!step) throw new Error(`unexpected model call #${i}`);
    return step;
  };
  const client = new MockNeuralakeClient(script);
  holder.client = client;
  return Object.assign(client, { seen });
}

function install(opts: FakeSpotifyOptions = {}) {
  const fake = createFakeSpotify({ playlists: PLAYLISTS, ...opts });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  return fake;
}

const run = (transcript: string) => spotifyAgent.handle({ transcript, contextId: "ctx", driverId: TEST_OWNER_ID });

function lastToolResult(req: CompletionRequest): unknown {
  const last = req.messages.at(-1);
  return last?.role === "tool" ? JSON.parse(last.content) : undefined;
}

beforeEach(() => {
  resetSpotifyTokenCache();
  stubSpotifyEnv(vi.stubEnv);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("spotifyAgent", () => {
  it("sends the system prompt and the three Spotify tools", async () => {
    install();
    const client = scripted(textMessage(""));
    await run("me leva pra casa");
    const [req] = client.calls;
    expect(req.tools).toEqual(SPOTIFY_TOOLS);
    expect(req.messages[0]).toMatchObject({ role: "system" });
    expect(req.messages[0].content).toContain("list_playlists");
    expect(req.messages[1]).toEqual({ role: "user", content: "me leva pra casa" });
    expect(client.seen).toEqual([undefined]);
  });

  it("UC1: plays a playlist by name", async () => {
    const fake = install();
    const client = scripted(
      toolCallMessage("play_playlist", { playlist_name: "rock nacional" }),
      textMessage("Tocando Rock Nacional."),
    );
    const res = await run("toca minha playlist rock nacional");

    expect(res).toMatchObject({ agent: "spotify", status: "completed", speech: "Tocando Rock Nacional." });
    expect(res.toolCalls[0]).toMatchObject({
      name: "play_playlist",
      ok: true,
      result: { found: true, playlist: { id: "p1", name: "Rock Nacional" } },
    });
    const [play] = fake.find("PUT", `${API}/me/player/play`);
    expect(JSON.parse(play.body ?? "")).toEqual({ context_uri: "spotify:playlist:p1" });
    expect(client.seen[1]).toMatchObject({ found: true });
  });

  it.each([
    ["pause", "PUT", `${API}/me/player/pause`, "pausa a música"],
    ["play", "PUT", `${API}/me/player/play`, "volta a tocar"],
    ["skip", "POST", `${API}/me/player/next`, "pula essa"],
  ] as const)("UC2: toggle_playback %s", async (action, method, url, transcript) => {
    const fake = install();
    scripted(toolCallMessage("toggle_playback", { action }), textMessage("Feito."));
    const res = await run(transcript);
    expect(res).toMatchObject({ status: "completed", speech: "Feito." });
    expect(res.toolCalls[0]).toMatchObject({ result: { ok: true, action }, ok: true });
    expect(fake.calls.filter((c) => c.url.startsWith(API))).toEqual([
      expect.objectContaining({ method, url, body: null }),
    ]);
  });

  it("UC4: lists playlists as { playlists: [{ id, name }] }", async () => {
    install();
    const client = scripted(
      toolCallMessage("list_playlists", {}),
      textMessage("Você tem Rock Nacional, Jazz e Sertanejo, entre outras."),
    );
    const res = await run("quais playlists eu tenho?");
    expect(res.status).toBe("completed");
    expect(res.toolCalls[0]).toMatchObject({ name: "list_playlists", result: { playlists: PLAYLISTS } });
    expect(client.seen[1]).toEqual({ playlists: PLAYLISTS });
  });

  it("UC5: ambiguous name → list_playlists → play_playlist, fetching the list once", async () => {
    const fake = install();
    scripted(
      toolCallMessage("list_playlists", {}),
      toolCallMessage("play_playlist", { playlist_name: "Treino Pesado" }),
      textMessage("Tocando Treino Pesado."),
    );
    const res = await run("toca aquela minha de treino");

    expect(res).toMatchObject({ status: "completed", speech: "Tocando Treino Pesado." });
    expect(res.toolCalls.map((c) => c.name)).toEqual(["list_playlists", "play_playlist"]);
    expect(fake.find("GET", `${API}/me/playlists`)).toHaveLength(1);
    const [play] = fake.find("PUT", `${API}/me/player/play`);
    expect(JSON.parse(play.body ?? "")).toEqual({ context_uri: "spotify:playlist:p3" });
  });

  it("UC5: fuzzy-matches an inexact name directly", async () => {
    const fake = install();
    scripted(
      toolCallMessage("play_playlist", { playlist_name: "musicas pra viajar" }),
      textMessage("Tocando Músicas para Viajar."),
    );
    const res = await run("toca musicas pra viajar");
    expect(res.toolCalls[0].result).toEqual({
      found: true,
      playlist: { id: "p2", name: "Músicas para Viajar" },
    });
    expect(fake.find("PUT", `${API}/me/player/play`)).toHaveLength(1);
  });

  it("UC5: no confident match → suggestions for the model, no play call", async () => {
    const fake = install();
    const client = scripted(
      toolCallMessage("play_playlist", { playlist_name: "pagode anos noventa" }),
      textMessage("Não achei essa. Quer Jazz, Sertanejo ou Rock Nacional?"),
    );
    const res = await run("toca pagode anos noventa");

    const result = client.seen[1] as { found: boolean; suggestions: string[] };
    expect(result.found).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.every((s) => PLAYLISTS.some((p) => p.name === s))).toBe(true);
    expect(fake.find("PUT", `${API}/me/player/play`)).toHaveLength(0);
    expect(res.status).toBe("completed");
  });

  it("UC6: no active device → short spoken failure", async () => {
    install({
      override: (call) =>
        call.url.startsWith(`${API}/me/player`)
          ? spotifyError(404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE")
          : undefined,
    });
    scripted(toolCallMessage("play_playlist", { playlist_name: "Jazz" }));
    const res = await run("toca jazz");
    expect(res).toMatchObject({ status: "failed", speech: NO_DEVICE_SPEECH });
    expect(res.toolCalls[0]).toMatchObject({ name: "play_playlist", ok: false });
  });

  it("UC6: expired token is renewed transparently", async () => {
    const fake = install({
      override: (call) =>
        call.url.startsWith(API) && call.authorization === "Bearer access-1"
          ? spotifyError(401, "The access token expired")
          : undefined,
    });
    scripted(toolCallMessage("toggle_playback", { action: "pause" }), textMessage("Pausei."));
    const res = await run("pausa");
    expect(res).toMatchObject({ status: "completed", speech: "Pausei." });
    expect(fake.find("PUT", `${API}/me/player/pause`)).toHaveLength(2);
  });

  it("UC6: revoked credentials → short spoken failure", async () => {
    install({
      override: (call) => (call.url.startsWith(API) ? spotifyError(401, "Invalid access token") : undefined),
    });
    scripted(toolCallMessage("toggle_playback", { action: "skip" }));
    const res = await run("pula");
    expect(res).toMatchObject({ status: "failed", speech: AUTH_FAILED_SPEECH });
  });

  it("UC6: Spotify not configured → short spoken failure", async () => {
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "");
    install();
    scripted(toolCallMessage("list_playlists", {}));
    const res = await run("quais playlists eu tenho");
    expect(res).toMatchObject({ status: "failed", speech: NOT_CONFIGURED_SPEECH });
  });

  it("UC7: handles only the music part of a double command", async () => {
    install();
    scripted(
      toolCallMessage("play_playlist", { playlist_name: "Sertanejo" }),
      textMessage("Tocando Sertanejo."),
    );
    const res = await run("toca minha playlist sertanejo e me leva pra casa");
    expect(res).toMatchObject({ status: "completed", speech: "Tocando Sertanejo.", clientActions: [] });
  });

  it("rejects an invalid playback action without calling Spotify", async () => {
    const fake = install();
    scripted(toolCallMessage("toggle_playback", { action: "rewind" }), textMessage("Não sei fazer isso."));
    const res = await run("volta a música");
    expect(res.toolCalls[0].result).toMatchObject({ ok: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("spotifyAgent wiring: the driverId given to the agent decides whose token is used", () => {
  const B = "drv_" + "B".repeat(22);
  const C = "drv_" + "C".repeat(22);
  const TOKEN_URL = "https://accounts.spotify.com/api/token";
  const runAs = (driverId: string, transcript: string, driverContext?: { spotifyRefreshToken?: string }) =>
    spotifyAgent.handle({ transcript, contextId: "ctx", driverId, driverContext });
  let vault: Awaited<ReturnType<typeof useTestTokenVault>>;
  beforeEach(async () => {
    vault = await useTestTokenVault(vi.stubEnv);
  });
  afterEach(() => vault.restore());

  it("non-owner not connected: 'Conecte seu Spotify', zero calls to Spotify", async () => {
    const fake = install();
    scripted(toolCallMessage("play_playlist", { playlist_name: "rock nacional" }), textMessage("Tocando."));
    const res = await runAs(B, "toca rock nacional");
    expect(res).toMatchObject({ agent: "spotify", status: "failed", speech: "Conecte seu Spotify." });
    expect(fake.calls).toEqual([]);
  });

  it("a refresh token sent in driverContext is ignored (non-owner stays 'not connected')", async () => {
    const fake = install();
    scripted(toolCallMessage("play_playlist", { playlist_name: "rock nacional" }), textMessage("Tocando."));
    const res = await runAs(B, "toca rock nacional", { spotifyRefreshToken: "b-from-client" });
    expect(res).toMatchObject({ status: "failed", speech: "Conecte seu Spotify." });
    expect(fake.calls).toEqual([]);
  });

  it("a connected driver uses their own token, not the server one nor another driver's", async () => {
    await vault.connect(B, "b-own-token");
    await vault.connect(C, "c-own-token");
    const fake = install();
    scripted(toolCallMessage("play_playlist", { playlist_name: "rock nacional" }), textMessage("Tocando."));
    const res = await runAs(B, "toca rock nacional", { spotifyRefreshToken: "b-from-client" });
    expect(res.status).toBe("completed");
    const bodies = fake.find("POST", TOKEN_URL).map((c) => c.body ?? "");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("refresh_token=b-own-token");
    expect(bodies[0]).not.toContain("c-own-token");
    expect(bodies[0]).not.toContain("b-from-client");
  });

  it("a connected driver with a bad token fails; the server refresh token never appears in any token request", async () => {
    await vault.connect(B, "b-bad-token");
    const fake = install({ override: (c) => (c.url === TOKEN_URL ? Response.json({ error: "invalid_grant" }, { status: 400 }) : undefined) });
    scripted(toolCallMessage("play_playlist", { playlist_name: "rock nacional" }), textMessage("Tocando."));
    const res = await runAs(B, "toca rock nacional");
    expect(res.status).toBe("failed");
    const bodies = fake.find("POST", TOKEN_URL).map((c) => c.body ?? "");
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b).toContain("refresh_token=b-bad-token");
      expect(b).not.toContain("refresh_token=refresh-token"); // value set by stubSpotifyEnv
    }
    expect(fake.find("PUT", `${API}/me/player/play`)).toEqual([]);
  });

  it("the owner still uses the server token, whatever driverContext carries", async () => {
    const fake = install();
    scripted(toolCallMessage("play_playlist", { playlist_name: "rock nacional" }), textMessage("Tocando."));
    const res = await runAs(TEST_OWNER_ID, "toca rock nacional", { spotifyRefreshToken: "owner-from-client" });
    expect(res.status).toBe("completed");
    const body = fake.find("POST", TOKEN_URL)[0].body ?? "";
    expect(body).toContain("refresh_token=refresh-token");
    expect(body).not.toContain("owner-from-client");
  });
});

describe("spotifyAgent card", () => {
  it("describes one skill per tool at the A2A endpoint", () => {
    const card = spotifyAgent.card("https://finn.example");
    expect(card).toMatchObject({
      name: "spotify-agent",
      url: "https://finn.example/api/agents/spotify",
      preferredTransport: "JSONRPC",
    });
    expect(card.skills.map((s) => s.id).sort()).toEqual(
      SPOTIFY_TOOLS.map((t) => t.function.name).sort(),
    );
    for (const skill of card.skills) {
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.tags.length).toBeGreaterThan(0);
      expect(skill.examples?.length).toBeGreaterThan(0);
    }
  });

  it("exposes keywords and failureSpeech", () => {
    expect(spotifyAgent.keywords).toBeDefined();
    expect(spotifyAgent.failureSpeech).toBe("Não consegui mexer na música agora.");
  });

  it("synthesizes deterministic fastSpeech confirmation", () => {
    expect(
      spotifyFastSpeech("play_playlist", { found: true, playlist: { name: "Rock Nacional" } }),
    ).toBe("Tocando Rock Nacional.");
    expect(spotifyFastSpeech("play_playlist", { found: false })).toBeNull();
    expect(spotifyFastSpeech("toggle_playback", { ok: true, action: "pause" })).toBe("Música pausada.");
    expect(spotifyFastSpeech("toggle_playback", { ok: true, action: "play" })).toBe("Continuando a música.");
    expect(spotifyFastSpeech("toggle_playback", { ok: true, action: "skip" })).toBe("Próxima música.");
    expect(spotifyFastSpeech("list_playlists", { playlists: [] })).toBeNull();
  });
});
