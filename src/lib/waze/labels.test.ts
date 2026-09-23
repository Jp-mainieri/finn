import { describe, expect, it } from "vitest";
import { isSavedLabel, toSavedLabel } from "./labels";

describe("toSavedLabel", () => {
  it.each([
    "casa",
    "Casa",
    "minha casa",
    "pra casa",
    "para casa",
    "lá em casa",
    "LÁ EM CASA",
    "de volta pra minha casa",
    "casa, por favor",
    "Minha casa.",
    "meu lar",
    "me leva pra casa",
    "vamos voltar pra casa",
  ])("%j → casa", (spoken) => {
    expect(toSavedLabel(spoken)).toBe("casa");
  });

  it.each([
    "trabalho",
    "meu trabalho",
    "pro trabalho",
    "no trabalho",
    "serviço",
    "pro serviço",
    "meu servico",
    "escritório",
    "o escritorio",
    "Escritório",
    "firma",
    "quero ir pro trabalho",
  ])("%j → trabalho", (spoken) => {
    expect(toSavedLabel(spoken)).toBe("trabalho");
  });

  it.each([
    "Shopping Iguatemi",
    "Casa do Pão de Queijo",
    "casa da minha mãe",
    "Escritório da Google",
    "Rua Augusta, 123",
    "Avenida Paulista, 1000",
    "minha",
    "me leva pro Shopping Iguatemi",
    "",
  ])("%j is a free-form destination", (spoken) => {
    expect(toSavedLabel(spoken)).toBeUndefined();
  });
});

describe("isSavedLabel", () => {
  it("accepts only canonical labels", () => {
    expect(isSavedLabel("casa")).toBe(true);
    expect(isSavedLabel("trabalho")).toBe(true);
    expect(isSavedLabel("minha casa")).toBe(false);
    expect(isSavedLabel(undefined)).toBe(false);
  });
});
