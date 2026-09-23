import { describe, expect, it } from "vitest";
import { wazeDeepLink } from "./deep-link";

describe("wazeDeepLink", () => {
  it("builds a navigate link with the encoded destination", () => {
    expect(wazeDeepLink("Shopping Iguatemi")).toBe(
      "https://waze.com/ul?q=Shopping%20Iguatemi&navigate=yes",
    );
  });

  it("encodes accents, commas and reserved characters", () => {
    const address = "Av. São João, 439 & Cia #2/3?";
    const url = wazeDeepLink(address);
    expect(url).toBe(`https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`);
    expect(new URL(url).searchParams.get("q")).toBe(address);
    expect(new URL(url).searchParams.get("navigate")).toBe("yes");
  });
});
