import { describe, expect, it } from "vitest";
import { classify } from "./classify";

describe("classify", () => {
  it.each([
    ["Toca a playlist Rock Nacional", ["spotify"]], // UC1
    ["pausa", ["spotify"]], // UC2
    ["pula essa música", ["spotify"]],
    ["vai pra próxima", ["spotify"]],
    ["para a música", ["spotify"]],
    ["quais playlists eu tenho?", ["spotify"]], // UC4
    ["me leva pro aeroporto de Congonhas", ["waze"]], // UC3
    ["navega até a Avenida Paulista, 1000", ["waze"]],
    ["quero chegar no shopping", ["waze"]],
    ["vamos para o trabalho", ["waze"]],
    ["toca minha playlist e me leva pra casa", ["spotify", "waze"]], // UC7
    ["Coloca a música do dia e traça a rota pro trabalho", ["spotify", "waze"]],
    ["que horas são?", []],
  ])("%s → %j", (transcript, expected) => {
    expect(classify(transcript)).toEqual(expected);
  });

  it("supports custom agents with keywords", () => {
    const custom = {
      spotify: { keywords: [/tocame/] },
    };
    expect(classify("tocame essa cancao", custom)).toEqual(["spotify"]);
    expect(classify("pausa", custom)).toEqual([]);
  });

  it("falls back to DEFAULT_PATTERNS if custom agent lacks keywords", () => {
    const custom = {
      spotify: {},
    };
    expect(classify("pausa", custom)).toEqual(["spotify"]);
  });
});
