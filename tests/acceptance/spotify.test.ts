/**
 * spotify-agent acceptance (UC1, UC2, UC4, UC5, UC6), driven through
 * POST /api/orchestrator with a scripted model and a fake Spotify Web API.
 * Pre-merge these fail in beforeEach with "[pre-merge] cannot import @/lib/spotify/auth".
 */
import { describe, expect, it, vi } from "vitest";
import { expectFriendlySpeech, expectOrchestratorResponse, resultOf, toolCall } from "../helpers/assertions";
import { useHarness } from "../helpers/harness";
import { say as turn } from "../helpers/http";
import { call, lastToolResult, llm, say, toolMessages } from "../helpers/llm";
import {
  EXPIRED_TOKEN,
  INVALID_GRANT,
  NO_ACTIVE_DEVICE,
  PLAYLISTS,
  PREMIUM_REQUIRED,
  RATE_LIMITED,
  SERVER_ERROR,
  SPOTIFY_TOKEN_URL,
  playlistNamed,
} from "../helpers/spotify-fake";
import { SPOTIFY_CREDS } from "../helpers/harness";

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

const uri = (name: string) => `spotify:playlist:${playlistNamed(name).id}`;

function playThenConfirm(playlistName: string, confirmation = `Tocando ${playlistName}.`) {
  llm.scripts.spotify = {
    turns: [call("play_playlist", { playlist_name: playlistName }), say(confirmation)],
  };
}

describe("[spotify] UC1 — play a playlist by exact name", () => {
  const h = useHarness({ spotify: true });

  it("PUTs /me/player/play with the playlist's context_uri and confirms by voice", async () => {
    playThenConfirm("Rock Nacional");
    const res = await turn("toca a playlist Rock Nacional");

    expectOrchestratorResponse(res);
    expect(res.results.map((r) => r.agent)).toEqual(["spotify"]);
    const spotify = resultOf(res, "spotify");
    expect(spotify.status).toBe("completed");
    expect(toolCall(spotify, "play_playlist")).toMatchObject({
      ok: true,
      result: { found: true, playlist: playlistNamed("Rock Nacional") },
    });

    const plays = h.spotify.callsTo("play");
    expect(plays).toHaveLength(1);
    expect(plays[0].json).toMatchObject({ context_uri: uri("Rock Nacional") });
    expect(plays[0].headers.get("authorization")).toBe(`Bearer ${h.spotify.issuedTokens[0]}`);

    expectFriendlySpeech(res.speech);
    expect(res.clientActions).toEqual([]);
    expect(llm.callsFor("waze")).toHaveLength(0);
    expect(h.spotify.callsTo("spotify-other")).toEqual([]);
  });

  it("finds a playlist on the second page by following `next`", async () => {
    playThenConfirm("Viagem de Carro");
    await turn("toca a playlist Viagem de Carro");

    const pages = h.spotify.callsTo("playlists");
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0].url.searchParams.get("limit")).toBe("50");
    expect(pages.some((p) => p.url.searchParams.get("offset") === "50")).toBe(true);
    expect(h.spotify.callsTo("play")[0]?.json).toMatchObject({ context_uri: uri("Viagem de Carro") });
  });

  it("offers the model exactly the three Spotify tools", async () => {
    playThenConfirm("Rock Nacional");
    await turn("toca a playlist Rock Nacional");
    const offered = llm.callsFor("spotify")[0]?.tools?.map((t) => t.function.name).sort();
    expect(offered).toEqual(["list_playlists", "play_playlist", "toggle_playback"]);
  });
});

describe("[spotify] token handling", () => {
  const h = useHarness({ spotify: true });

  it("refreshes the access token as documented (POST, Basic client auth, refresh_token grant)", async () => {
    playThenConfirm("Rock Nacional");
    await turn("toca a playlist Rock Nacional");

    const [tokenCall] = h.spotify.callsTo("token");
    expect(tokenCall, "no call to the token endpoint").toBeDefined();
    expect(tokenCall.url.href).toBe(SPOTIFY_TOKEN_URL);
    const basic = Buffer.from(`${SPOTIFY_CREDS.clientId}:${SPOTIFY_CREDS.clientSecret}`).toString("base64");
    expect(tokenCall.headers.get("authorization")).toBe(`Basic ${basic}`);
    expect(tokenCall.headers.get("content-type")).toMatch(/application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(tokenCall.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(SPOTIFY_CREDS.refreshToken);
  });

  it("caches the access token across turns", async () => {
    llm.scripts.spotify = { turns: [call("toggle_playback", { action: "pause" }), say("Pausei.")] };
    await turn("pausa a música");
    llm.scripts.spotify = { turns: [call("toggle_playback", { action: "skip" }), say("Pulei.")] };
    await turn("pula essa música");

    expect(h.spotify.callsTo("token")).toHaveLength(1);
    expect(h.spotify.callsTo("pause")).toHaveLength(1);
    expect(h.spotify.callsTo("next")).toHaveLength(1);
  });
});

describe("[spotify] UC2 — pause / resume / skip", () => {
  const h = useHarness({ spotify: true });

  it.each([
    ["pausa a música", "pause", "pause", "PUT"],
    ["retoma a música", "play", "play", "PUT"],
    ["pula essa música", "skip", "next", "POST"],
  ] as const)("%s → toggle_playback(%s) → %s %s", async (transcript, action, endpoint, method) => {
    llm.scripts.spotify = { turns: [call("toggle_playback", { action }), say("Feito.")] };
    const res = await turn(transcript);

    const spotify = resultOf(res, "spotify");
    expect(spotify.status).toBe("completed");
    expect(toolCall(spotify, "toggle_playback")?.result).toMatchObject({ ok: true, action });
    const hits = h.spotify.callsTo(endpoint);
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe(method);
    const playerCalls = h.spotify.spotifyCalls.filter((c) => ["play", "pause", "next"].includes(c.endpoint));
    expect(playerCalls.map((c) => c.endpoint)).toEqual([endpoint]);
    expect(h.spotify.callsTo("spotify-other")).toEqual([]);
    expectFriendlySpeech(res.speech);
  });

  it("resume sends no context_uri (continues what was playing)", async () => {
    llm.scripts.spotify = { turns: [call("toggle_playback", { action: "play" }), say("Voltei a tocar.")] };
    await turn("retoma a música");
    const [play] = h.spotify.callsTo("play");
    expect(play.body === undefined || play.body === "" || play.body === "{}").toBe(true);
    expect(h.spotify.callsTo("playlists")).toHaveLength(0);
  });
});

describe("[spotify] UC4 — list playlists", () => {
  const h = useHarness({ spotify: true });

  it("returns every playlist ({ id, name }) and the spoken reply mentions them", async () => {
    llm.scripts.spotify = {
      turns: [
        call("list_playlists", {}),
        (req) => {
          const out = lastToolResult<{ playlists?: { name: string }[] }>(req);
          const names = (out?.playlists ?? []).map((p) => p.name);
          return say(`Você tem ${names.slice(0, 3).join(", ")} e mais ${names.length - 3} playlists.`);
        },
      ],
    };
    const res = await turn("quais playlists eu tenho?");

    const spotify = resultOf(res, "spotify");
    expect(spotify.status).toBe("completed");
    const listed = toolCall(spotify, "list_playlists")?.result as { playlists: { id: string; name: string }[] };
    expect(listed.playlists).toHaveLength(PLAYLISTS.length);
    expect(listed.playlists).toEqual(expect.arrayContaining(PLAYLISTS.map((p) => expect.objectContaining(p))));

    expect(res.speech).toContain("Rock Nacional");
    expect(res.speech).toContain("Pagode do Fim de Semana");
    expectFriendlySpeech(res.speech);
    expect(h.spotify.callsTo("play")).toHaveLength(0);
  });
});

describe("[spotify] UC5 — inexact playlist name", () => {
  const h = useHarness({ spotify: true });

  it.each([
    ["toca a playlist pagode fim de semana", "pagode fim de semana", "Pagode do Fim de Semana"],
    ["toca a playlist mpb acustico", "mpb acustico", "MPB Acústico"],
    ["toca a playlist viagem de carro", "viagem de carro", "Viagem de Carro"],
  ])("%s → list_playlists, then plays the fuzzy match", async (transcript, spoken, expected) => {
    llm.scripts.spotify = {
      turns: [
        call("list_playlists", {}),
        call("play_playlist", { playlist_name: spoken }),
        say(`Tocando ${expected}.`),
      ],
    };
    const res = await turn(transcript);

    const spotify = resultOf(res, "spotify");
    expect(spotify.toolCalls.map((c) => c.name)).toEqual(["list_playlists", "play_playlist"]);
    expect(spotify.status).toBe("completed");

    const firstPlay = h.spotify.calls.findIndex((c) => c.endpoint === "play");
    const firstList = h.spotify.calls.findIndex((c) => c.endpoint === "playlists");
    expect(firstList).toBeGreaterThanOrEqual(0);
    expect(firstList).toBeLessThan(firstPlay);
    expect(h.spotify.callsTo("play")).toHaveLength(1);
    expect(h.spotify.callsTo("play")[0].json).toMatchObject({ context_uri: uri(expected) });

    // The model saw the whole list before choosing (including page 2).
    const fed = toolMessages(llm.callsFor("spotify")[1]);
    expect(fed).toHaveLength(1);
    expect(fed[0]).toContain("Lo-fi para Estudar");
  });

  it("does NOT play anything for a name that matches nothing; returns { found: false, suggestions }", async () => {
    llm.scripts.spotify = {
      turns: [
        call("list_playlists", {}),
        call("play_playlist", { playlist_name: "xablau quântico" }),
        (req) => {
          const out = lastToolResult<{ found?: boolean }>(req);
          return say(out?.found === false ? "Não achei essa playlist. Quer ouvir Rock Nacional?" : "Tocando.");
        },
      ],
    };
    const res = await turn("toca a playlist xablau quântico");

    expect(h.spotify.callsTo("play")).toHaveLength(0);
    const played = toolCall(resultOf(res, "spotify"), "play_playlist");
    expect(played?.result).toMatchObject({ found: false, suggestions: expect.any(Array) });
    const { suggestions } = played?.result as { suggestions: unknown[] };
    expect(suggestions.length).toBeLessThanOrEqual(5);
    for (const s of suggestions) expect(s).toBeTypeOf("string"); // names the model can speak
    expect(res.speech).toMatch(/não achei/i);
    expectFriendlySpeech(res.speech);
  });

  it("does NOT play when the model skips list_playlists and asks for a nonsense name directly", async () => {
    llm.scripts.spotify = {
      turns: [call("play_playlist", { playlist_name: "zzz qwerty" }), say("Não achei essa playlist.")],
    };
    await turn("toca a playlist zzz qwerty");
    expect(h.spotify.callsTo("play")).toHaveLength(0);
  });

  it("does NOT guess between two close candidates ('rock' → Rock Nacional / Rock Clássico)", async () => {
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "rock" }), say("Qual delas?")] };
    const res = await turn("toca rock");
    expect(h.spotify.callsTo("play")).toHaveLength(0);
    const result = toolCall(resultOf(res, "spotify"), "play_playlist")?.result as { found: boolean; suggestions: string[] };
    expect(result.found).toBe(false);
    expect(result.suggestions).toEqual(expect.arrayContaining(["Rock Nacional", "Rock Clássico"]));
  });

  it("does not match a different genre with a similar spelling ('funk' ≠ 'Punk')", async () => {
    llm.scripts.spotify = { turns: [call("play_playlist", { playlist_name: "funk" }), say("Não achei.")] };
    await turn("toca a playlist funk");
    expect(h.spotify.callsTo("play")).toHaveLength(0);
  });

  it("fetches the playlist list only once per turn (latency)", async () => {
    llm.scripts.spotify = {
      turns: [call("list_playlists", {}), call("play_playlist", { playlist_name: "pagode fim de semana" }), say("Tocando.")],
    };
    await turn("toca a playlist pagode fim de semana");
    const firstPages = h.spotify.callsTo("playlists").filter((c) => (c.url.searchParams.get("offset") ?? "0") === "0");
    expect(firstPages).toHaveLength(1);
  });
});

describe("[spotify] UC6 — execution failures are spoken, conversation continues", () => {
  const h = useHarness({ spotify: true });

  const pause = () => {
    llm.scripts.spotify = { turns: [call("toggle_playback", { action: "pause" }), say("Pausei.")] };
  };

  it("401 → refreshes the token once and retries successfully", async () => {
    h.spotify.enqueue("pause", EXPIRED_TOKEN);
    pause();
    const res = await turn("pausa a música");

    expect(resultOf(res, "spotify").status).toBe("completed");
    const pauses = h.spotify.callsTo("pause");
    expect(pauses).toHaveLength(2);
    expect(h.spotify.callsTo("token")).toHaveLength(2);
    expect(pauses[1].headers.get("authorization")).toBe(`Bearer ${h.spotify.issuedTokens[1]}`);
  });

  it("401 while listing playlists is also retried after a refresh", async () => {
    h.spotify.enqueue("playlists", EXPIRED_TOKEN);
    playThenConfirm("Rock Nacional");
    const res = await turn("toca a playlist Rock Nacional");
    expect(resultOf(res, "spotify").status).toBe("completed");
    expect(h.spotify.callsTo("play")[0]?.json).toMatchObject({ context_uri: uri("Rock Nacional") });
  });

  it("401 twice → failed with a short spoken apology, HTTP 200, and the next turn works", async () => {
    h.spotify.enqueue("pause", EXPIRED_TOKEN, EXPIRED_TOKEN);
    pause();
    const res = await turn("pausa a música"); // throws if not HTTP 200

    const spotify = resultOf(res, "spotify");
    expect(spotify.status).toBe("failed");
    expect(h.spotify.callsTo("pause")).toHaveLength(2); // exactly one retry
    expect(spotify.speech).toMatch(/spotify/i); // confirmed copy: "Perdi o acesso ao seu Spotify."
    expectFriendlySpeech(res.speech, { maxChars: 120 });
    expectFriendlySpeech(spotify.speech, { maxChars: 120 });

    pause();
    const next = await turn("pausa a música");
    expect(resultOf(next, "spotify").status).toBe("completed");
  });

  it.each([
    ["play_playlist", () => playThenConfirm("Rock Nacional"), "play", "toca a playlist Rock Nacional"],
    ["toggle_playback(pause)", pause, "pause", "pausa a música"],
  ] as const)("404 NO_ACTIVE_DEVICE on %s → asks to open Spotify on some device", async (_l, script, endpoint, transcript) => {
    h.spotify.enqueue(endpoint, NO_ACTIVE_DEVICE);
    script();
    const res = await turn(transcript);

    const spotify = resultOf(res, "spotify");
    expect(spotify.status).toBe("failed");
    // confirmed copy: "Abre o Spotify em algum aparelho e me pede de novo."
    expect(spotify.speech).toMatch(/spotify/i);
    expect(spotify.speech).toMatch(/abr/i);
    expect(spotify.speech).toMatch(/aparelho|dispositivo|celular/i);
    expectFriendlySpeech(res.speech, { maxChars: 120 });
  });

  it.each([
    ["a 500 from Spotify", () => h.spotify.enqueue("pause", SERVER_ERROR)],
    ["a 429 rate limit", () => h.spotify.enqueue("pause", RATE_LIMITED, RATE_LIMITED)],
    ["a 403 PREMIUM_REQUIRED", () => h.spotify.enqueue("pause", PREMIUM_REQUIRED)],
    ["a network error", () => h.spotify.enqueue("pause", { networkError: true })],
    ["a revoked refresh token", () => h.spotify.enqueue("token", INVALID_GRANT, INVALID_GRANT, INVALID_GRANT)],
  ])("%s → failed with a short non-technical sentence", async (_label, arrange) => {
    arrange();
    pause();
    const res = await turn("pausa a música");
    expect(resultOf(res, "spotify").status).toBe("failed");
    expectFriendlySpeech(res.speech, { maxChars: 120 });
  });

  it("missing Spotify config → failed with a spoken hint, no request to Spotify", async () => {
    vi.stubEnv("SPOTIFY_REFRESH_TOKEN", undefined);
    pause();
    const res = await turn("pausa a música");
    expect(resultOf(res, "spotify").status).toBe("failed");
    expect(res.speech).toMatch(/configurad/i); // confirmed copy: "O Spotify ainda não está configurado."
    expectFriendlySpeech(res.speech, { maxChars: 120 });
    expect(h.spotify.spotifyCalls).toEqual([]);
  });
});
