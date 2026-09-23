/**
 * Opt-in eval of the agents' PROMPTS against the real Neuralake (costs a few
 * cents; ~9 model calls). Spotify stays faked, so nothing plays for real.
 *
 *   npm run test:live        # needs NEURALAKE_API_KEY (shell or .env.local)
 *
 * Skipped unless FINN_LIVE=1 (set by the npm script) AND NEURALAKE_API_KEY is
 * set, so a key exported in the shell never makes `npm test` spend money.
 * These are behavioral evals: a failure means the prompt needs work, and an
 * occasional flake is possible — rerun before filing a bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectFriendlySpeech, openUrls, resultOf, toolCall } from "../helpers/assertions";
import { SPOTIFY_CREDS, stubBaseEnv } from "../helpers/harness";
import { say as turn } from "../helpers/http";
import { resetSpotifyTokenCache } from "../helpers/modules";
import { installFakeSpotify, playlistNamed, type FakeSpotify } from "../helpers/spotify-fake";

const LIVE = process.env.FINN_LIVE === "1" && Boolean(process.env.NEURALAKE_API_KEY);
const TIMEOUT = 60_000;

const PT_WORDS = new Set(
  "você pra para pro tocando toca tocar vou estou agora qual onde seu sua rota abrindo endereço não de do da no na em indo te".split(" "),
);
const EN_WORDS = new Set("the you your playing route what is are opening to".split(" "));

/** Crude pt-BR check: Portuguese function words present, English ones absent. */
function expectPortuguese(speech: string) {
  const words = speech.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  expect(words.filter((w) => PT_WORDS.has(w)), `not pt-BR? "${speech}"`).not.toEqual([]);
  expect(words.filter((w) => EN_WORDS.has(w)), `English in speech: "${speech}"`).toEqual([]);
}

function expectSpokenReply(speech: string) {
  expectFriendlySpeech(speech, { maxChars: 200 });
  expectPortuguese(speech);
}

describe.skipIf(!LIVE)("[live] agent prompts against the real Neuralake", () => {
  let spotify: FakeSpotify;

  beforeEach(async () => {
    stubBaseEnv({ FINN_USE_MOCKS: "0" });
    spotify = installFakeSpotify(SPOTIFY_CREDS, { passthroughExternal: true });
    await resetSpotifyTokenCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it(
    "UC7: each agent acts only on its own half of a double command",
    async () => {
      const res = await turn("toca a playlist Rock Nacional e me leva pro aeroporto de Congonhas");
      const music = resultOf(res, "spotify");
      const nav = resultOf(res, "waze");
      console.info("[live UC7]", JSON.stringify({ speech: res.speech, music: music.toolCalls, nav: nav.toolCalls }));

      // spotify-agent: plays Rock Nacional, never mentions the trip.
      const play = toolCall(music, "play_playlist");
      expect(play, "spotify-agent did not call play_playlist").toBeDefined();
      expect(String(play?.arguments.playlist_name)).toMatch(/rock/i);
      expect(String(play?.arguments.playlist_name)).not.toMatch(/congonhas|aeroporto/i);
      expect(spotify.callsTo("play")[0]?.json).toMatchObject({
        context_uri: `spotify:playlist:${playlistNamed("Rock Nacional").id}`,
      });
      expect(music.speech).not.toMatch(/congonhas|aeroporto|rota|waze/i);

      // waze-agent: navigates to Congonhas, never mentions the music.
      const go = toolCall(nav, "navigate_to");
      expect(go, "waze-agent did not call navigate_to").toBeDefined();
      expect(String(go?.arguments.destination)).toMatch(/congonhas/i);
      expect(String(go?.arguments.destination)).not.toMatch(/rock|playlist|toca/i);
      expect(openUrls(res)).toHaveLength(1);
      expect(nav.speech).not.toMatch(/rock|playlist|música|spotify/i);

      expectSpokenReply(music.speech);
      expectSpokenReply(nav.speech);
    },
    TIMEOUT,
  );

  it(
    // Decision (2026-09-23): the model may skip list_playlists — play_playlist's executor
    // fuzzy-matches against the driver's playlists itself, saving one model round-trip.
    // What matters is that the right playlist plays.
    "UC5: an inexact playlist name plays the right playlist",
    async () => {
      const res = await turn("toca a playlist pagode fim de semana");
      const music = resultOf(res, "spotify");
      console.info("[live UC5]", JSON.stringify({ speech: res.speech, calls: music.toolCalls.map((c) => c.name) }));

      expect(music.toolCalls.map((c) => c.name)).toContain("play_playlist");
      expect(spotify.callsTo("play")[0]?.json).toMatchObject({
        context_uri: `spotify:playlist:${playlistNamed("Pagode do Fim de Semana").id}`,
      });
      expectSpokenReply(music.speech);
    },
    TIMEOUT,
  );

  it(
    "saved address: an unknown 'casa' makes the waze-agent ask for the address in short pt-BR",
    async () => {
      const { resetAddressBook } = await import("../helpers/modules");
      await resetAddressBook();
      const res = await turn("me leva pra casa");
      const nav = resultOf(res, "waze");
      console.info("[live casa]", JSON.stringify({ speech: res.speech, status: nav.status }));

      expect(nav.status).toBe("input-required");
      expect(res.clientActions).toEqual([]);
      expect(nav.speech).toMatch(/endereço/i);
      expect(nav.speech).toMatch(/\?/);
      expectSpokenReply(nav.speech);
    },
    TIMEOUT,
  );
});

describe.runIf(!LIVE)("[live] agent prompts", () => {
  it.skip("skipped: run `npm run test:live` with NEURALAKE_API_KEY set", () => {});
});
