import { describe, expect, it } from "vitest";
import { findBestMatch, levenshtein, MATCH_THRESHOLD, normalizeName, scoreName } from "./fuzzy";

const names = [
  "Rock Nacional",
  "Rock Clássico",
  "Músicas para Viajar",
  "Lo-Fi Beats",
  "Treinos Pesados",
  "Sertanejo Universitário",
  "Brockhampton Mix",
  "Jazz",
];
const match = (query: string, list = names) => findBestMatch(query, list, (n) => n);
const matched = (query: string, list = names) => {
  const res = match(query, list);
  return res.kind === "match" ? res.item : null;
};

describe("normalizeName", () => {
  it("strips case, accents and punctuation", () => {
    expect(normalizeName("  Músicas-para  VIAJAR! ")).toBe("musicas para viajar");
  });
});

describe("levenshtein", () => {
  it("counts edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("rock", "rock")).toBe(0);
  });
});

describe("findBestMatch", () => {
  it("matches exactly regardless of case and accents", () => {
    expect(matched("rock classico")).toBe("Rock Clássico");
    expect(matched("JAZZ")).toBe("Jazz");
  });

  it("prefers the exact name over containing ones", () => {
    expect(matched("rock", ["Rock", "Rock Nacional", "Rock Clássico"])).toBe("Rock");
  });

  it("ignores filler words the driver wraps around the name", () => {
    expect(matched("minha playlist de sertanejo")).toBe("Sertanejo Universitário");
    expect(matched("playlist do jazz")).toBe("Jazz");
  });

  it("matches a contained name or spacing variants", () => {
    expect(matched("sertanejo")).toBe("Sertanejo Universitário");
    expect(matched("lofi")).toBe("Lo-Fi Beats");
    expect(matched("treino")).toBe("Treinos Pesados");
  });

  it("tolerates transcription typos and colloquial words", () => {
    expect(matched("musicas pra viajar")).toBe("Músicas para Viajar");
    expect(matched("rok nacional")).toBe("Rock Nacional");
    expect(matched("sertaneijo universitario")).toBe("Sertanejo Universitário");
  });

  it("does not match a word hidden inside another word", () => {
    expect(scoreName("rock", "Brockhampton Mix")).toBeLessThan(MATCH_THRESHOLD);
  });

  it("does not auto-play a different short word one letter away", () => {
    const res = match("funk", ["Punk", "Jazz"]);
    expect(res).toEqual({ kind: "none", suggestions: ["Punk", "Jazz"] });
  });

  it("reports ambiguity when two names fit equally well", () => {
    const res = match("rock");
    expect(res.kind).toBe("none");
    if (res.kind === "none") {
      expect(res.suggestions.slice(0, 2).sort()).toEqual(["Rock Clássico", "Rock Nacional"]);
    }
  });

  it("returns ranked suggestions when nothing is close enough", () => {
    const res = match("pagode dos anos noventa");
    expect(res.kind).toBe("none");
    if (res.kind === "none") expect(res.suggestions).toHaveLength(5);
  });

  it("handles empty input and empty libraries", () => {
    expect(match("").kind).toBe("none");
    expect(match("rock", [])).toEqual({ kind: "none", suggestions: [] });
  });
});
