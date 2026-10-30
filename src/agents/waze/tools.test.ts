import { TEST_OWNER_ID } from "../../../tests/helpers/owner";
import { describe, expect, it } from "vitest";
import { MemoryAddressBook } from "@/lib/waze/address-book";
import { DriverStoreUnavailableError } from "@/lib/driver/store";
import type { AddressBook } from "@/lib/waze/address-book";
import { ADDRESS_STORE_UNAVAILABLE_SPEECH, createNavigateTo, parseContinuation } from "./tools";

const newBook = () => new MemoryAddressBook(TEST_OWNER_ID);
const input = { transcript: "", contextId: "ctx", driverId: TEST_OWNER_ID };

describe("parseContinuation", () => {
  it("accepts only known shapes", () => {
    expect(parseContinuation({ pendingLabel: "casa" })).toEqual({ pendingLabel: "casa" });
    expect(parseContinuation({ awaitingDestination: true })).toEqual({ awaitingDestination: true });
    expect(parseContinuation({ pendingLabel: "academia" })).toBeUndefined();
    expect(parseContinuation("casa")).toBeUndefined();
    expect(parseContinuation(null)).toBeUndefined();
    expect(parseContinuation(undefined)).toBeUndefined();
  });
});

describe("navigate_to executor", () => {
  it("navigates straight to a free-form destination", async () => {
    const navigate = createNavigateTo(newBook());
    expect(await navigate({ destination: "  Shopping   Iguatemi " }, input)).toEqual({
      result: { navigating_to: "Shopping Iguatemi" },
      clientActions: [
        {
          type: "open_url",
          url: "https://waze.com/ul?q=Shopping%20Iguatemi&navigate=yes",
          label: "Navegar para Shopping Iguatemi",
        },
      ],
    });
  });

  it("uses the saved address for a label", async () => {
    const seeded = newBook();
    await seeded.set("trabalho", "Av. Paulista, 1000");
    const navigate = createNavigateTo(seeded);
    const out = await navigate({ destination: "meu escritório" }, input);
    expect(out.result).toEqual({ navigating_to: "trabalho", saved_place: true });
    expect(out.clientActions).toEqual([
      {
        type: "open_url",
        url: "https://waze.com/ul?q=Av.%20Paulista%2C%201000&navigate=yes",
        label: "Navegar para o trabalho",
      },
    ]);
    expect(out.continuation).toBeUndefined();
  });

  it("asks for the address of an unsaved label", async () => {
    const navigate = createNavigateTo(newBook());
    expect(await navigate({ destination: "minha casa" }, input)).toEqual({
      result: { needs_address: "casa" },
      continuation: { pendingLabel: "casa" },
    });
  });

  it("saves the answer under the pending label and navigates to it", async () => {
    const book = newBook();
    const navigate = createNavigateTo(book, { pendingLabel: "casa" });
    const out = await navigate({ destination: "Rua Augusta, 123" }, input);
    expect(await book.get("casa")).toBe("Rua Augusta, 123");
    expect(out.result).toEqual({ navigating_to: "casa", saved_place: true, address_saved_now: true });
    expect(out.clientActions).toEqual([
      {
        type: "open_url",
        url: "https://waze.com/ul?q=Rua%20Augusta%2C%20123&navigate=yes",
        label: "Navegar para casa",
      },
    ]);
    expect(out.continuation).toBeUndefined();
  });

  it("saves the pending answer only once per turn", async () => {
    const book = newBook();
    const navigate = createNavigateTo(book, { pendingLabel: "casa" });
    await navigate({ destination: "Rua Augusta, 123" }, input);
    const second = await navigate({ destination: "Shopping Iguatemi" }, input);
    expect(await book.get("casa")).toBe("Rua Augusta, 123");
    expect(second.result).toEqual({ navigating_to: "Shopping Iguatemi" });
  });

  it("does not save a repeated label as the address", async () => {
    const book = newBook();
    const navigate = createNavigateTo(book, { pendingLabel: "casa" });
    const out = await navigate({ destination: "casa" }, input);
    expect(await book.get("casa")).toBeUndefined();
    expect(out.continuation).toEqual({ pendingLabel: "casa" });
  });

  it.each([{ destination: "" }, { destination: "   " }, {}, { destination: 42 }])(
    "asks where to go for %j",
    async (args) => {
      const navigate = createNavigateTo(newBook());
      expect(await navigate(args, input)).toEqual({
        result: { needs_destination: true },
        continuation: { awaitingDestination: true },
      });
    },
  );

  it("rejects an unstorable answer (too long, control chars), keeps asking and saves nothing", async () => {
    const book = newBook();
    const navigate = createNavigateTo(book, { pendingLabel: "casa" });
    for (const bad of ["x".repeat(201), "Rua\u0000Augusta", "Rua\u001b[31mX"]) {
      const out = await navigate({ destination: bad }, input);
      expect(out).toEqual({
        result: { needs_address: "casa", invalid_address: true },
        continuation: { pendingLabel: "casa" },
      });
      expect(await book.get("casa")).toBeUndefined();
    }
    // exactly 200 is fine
    const ok = await navigate({ destination: "y".repeat(200) }, input);
    expect(ok.result).toMatchObject({ saved_place: true });
  });

  it("a store failure becomes a short spoken failure without the SDK error", async () => {
    const down: AddressBook = {
      get: async () => {
        throw new DriverStoreUnavailableError();
      },
      set: async () => {
        throw new DriverStoreUnavailableError();
      },
    };
    await expect(createNavigateTo(down)({ destination: "casa" }, input)).rejects.toMatchObject({
      name: "UserFacingError",
      speech: ADDRESS_STORE_UNAVAILABLE_SPEECH,
    });
    await expect(
      createNavigateTo(down, { pendingLabel: "casa" })({ destination: "Rua A, 1" }, input),
    ).rejects.toMatchObject({ speech: ADDRESS_STORE_UNAVAILABLE_SPEECH });
  });
});
