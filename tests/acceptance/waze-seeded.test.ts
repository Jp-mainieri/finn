/**
 * Saved addresses seeded via WAZE_SAVED_ADDRESSES. The env is set in
 * vi.hoisted (before any module loads) and again before each test, so this
 * works whether the address book reads the env at import time or lazily.
 * No reset here on purpose: these tests only read the book.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { openUrls, resultOf, wazeUrl } from "../helpers/assertions";
import { useHarness } from "../helpers/harness";
import { say as turn } from "../helpers/http";
import { call, llm, say } from "../helpers/llm";
import { playlistNamed } from "../helpers/spotify-fake";

const SEED = vi.hoisted(() => {
  const seed = {
    casa: "Rua dos Pinheiros, 870 - Pinheiros, São Paulo",
    trabalho: "Av. Brigadeiro Faria Lima, 3477 - Itaim Bibi, São Paulo",
  };
  process.env.WAZE_SAVED_ADDRESSES = JSON.stringify(seed);
  return seed;
});

vi.mock("@/lib/neuralake/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/neuralake/client")>()),
  getNeuralakeClient: (await import("../helpers/llm")).getScriptedClient,
}));

describe("[waze] saved addresses seeded from WAZE_SAVED_ADDRESSES", () => {
  const h = useHarness({ env: { WAZE_SAVED_ADDRESSES: JSON.stringify(SEED) } });
  afterAll(() => {
    delete process.env.WAZE_SAVED_ADDRESSES; // don't leak into other files if the worker is reused
  });

  it.each(["trabalho", "meu trabalho", "escritório", "serviço"])(
    "destination %j uses the seeded 'trabalho' address without asking",
    async (destination) => {
      llm.scripts.waze = { turns: [call("navigate_to", { destination }), say("Indo pro trabalho.")] };
      const res = await turn("me leva pro trabalho");

      expect(resultOf(res, "waze").status).toBe("completed");
      expect(res.continuation).toBeUndefined();
      expect(openUrls(res)).toEqual([wazeUrl(SEED.trabalho)]);
      expect(res.clientActions[0].label).toMatch(/trabalho/i); // confirmed: "Navegar para o trabalho"
    },
  );

  it("[spotify] UC7 as in the spec — 'toca minha playlist e me leva pra casa' with casa seeded", async () => {
    const { resetSpotifyTokenCache } = await import("../helpers/modules");
    await resetSpotifyTokenCache();

    llm.scripts.spotify = {
      turns: [call("play_playlist", { playlist_name: "Rock Nacional" }), say("Tocando Rock Nacional.")],
    };
    llm.scripts.waze = { turns: [call("navigate_to", { destination: "casa" }), say("Indo pra casa.")] };
    const res = await turn("toca minha playlist Rock Nacional e me leva pra casa");

    expect(res.results.map((r) => r.agent)).toEqual(["spotify", "waze"]);
    expect(openUrls(res)).toEqual([wazeUrl(SEED.casa)]);
    expect(h.spotify.callsTo("play")[0]?.json).toMatchObject({
      context_uri: `spotify:playlist:${playlistNamed("Rock Nacional").id}`,
    });
    expect(res.speech).toContain("Rock Nacional");
    expect(res.speech).toContain("casa");
  });
});
