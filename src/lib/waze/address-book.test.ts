import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAddressBook,
  InProcessAddressBook,
  parseSavedAddresses,
  resetAddressBook,
} from "./address-book";

describe("parseSavedAddresses", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads casa and trabalho", () => {
    expect(parseSavedAddresses('{"casa":" Rua Augusta, 123 ","trabalho":"Av. Paulista, 1000"}')).toEqual({
      casa: "Rua Augusta, 123",
      trabalho: "Av. Paulista, 1000",
    });
  });

  it("returns nothing for an empty value", () => {
    expect(parseSavedAddresses("")).toEqual({});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("logs and ignores invalid JSON", () => {
    expect(parseSavedAddresses("{casa: Rua Augusta")).toEqual({});
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("logs and ignores non-object JSON", () => {
    expect(parseSavedAddresses('["Rua Augusta"]')).toEqual({});
    expect(parseSavedAddresses('"Rua Augusta"')).toEqual({});
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("drops unknown labels and empty or non-string addresses", () => {
    expect(parseSavedAddresses('{"casa":"Rua A, 1","academia":"Rua B","trabalho":""}')).toEqual({
      casa: "Rua A, 1",
    });
    expect(parseSavedAddresses('{"casa":42}')).toEqual({});
  });
});

describe("InProcessAddressBook", () => {
  it("serves the seed and lets writes override it", async () => {
    const book = new InProcessAddressBook({ casa: "Rua A, 1" });
    expect(await book.get("casa")).toBe("Rua A, 1");
    expect(await book.get("trabalho")).toBeUndefined();

    await book.set("trabalho", "Rua B, 2");
    await book.set("casa", "Rua C, 3");
    expect(await book.get("trabalho")).toBe("Rua B, 2");
    expect(await book.get("casa")).toBe("Rua C, 3");
  });
});

describe("getAddressBook", () => {
  beforeEach(() => {
    resetAddressBook();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetAddressBook();
  });

  it("is seeded from WAZE_SAVED_ADDRESSES", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", '{"trabalho":"Av. Paulista, 1000"}');
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("trabalho")).toBe("Av. Paulista, 1000");
  });

  it("works without the env", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", "");
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBeUndefined();
  });

  it("ignores an invalid seed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("WAZE_SAVED_ADDRESSES", "not json");
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("keeps writes across calls until reset", async () => {
    vi.stubEnv("WAZE_SAVED_ADDRESSES", "");
    await getAddressBook(LEGACY_OWNER_DRIVER_ID).set("casa", "Rua Augusta, 123");
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBe("Rua Augusta, 123");

    resetAddressBook();
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBeUndefined();
  });

  it("gives a non-owner an empty book, never the owner's seed or writes", async () => {
    const OTHER = "drv_" + "B".repeat(22);
    vi.stubEnv("WAZE_SAVED_ADDRESSES", '{"casa":"Rua do Dono, 1"}');
    await getAddressBook(LEGACY_OWNER_DRIVER_ID).set("trabalho", "Escritorio do Dono");
    const other = getAddressBook(OTHER);
    expect(await other.get("casa")).toBeUndefined();
    expect(await other.get("trabalho")).toBeUndefined();
    await other.set("casa", "Rua do Outro, 2");
    expect(await getAddressBook(LEGACY_OWNER_DRIVER_ID).get("casa")).toBe("Rua do Dono, 1");
  });
});
