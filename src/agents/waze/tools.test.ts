import { LEGACY_OWNER_DRIVER_ID } from "@/lib/auth";
import { describe, expect, it } from "vitest";
import { InProcessAddressBook } from "@/lib/waze/address-book";
import { createNavigateTo, parseContinuation } from "./tools";

const input = { transcript: "", contextId: "ctx", driverId: LEGACY_OWNER_DRIVER_ID };

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
    const navigate = createNavigateTo(new InProcessAddressBook());
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
    const navigate = createNavigateTo(new InProcessAddressBook({ trabalho: "Av. Paulista, 1000" }));
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
    const navigate = createNavigateTo(new InProcessAddressBook());
    expect(await navigate({ destination: "minha casa" }, input)).toEqual({
      result: { needs_address: "casa" },
      continuation: { pendingLabel: "casa" },
    });
  });

  it("saves the answer under the pending label and navigates to it", async () => {
    const book = new InProcessAddressBook();
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
    const book = new InProcessAddressBook();
    const navigate = createNavigateTo(book, { pendingLabel: "casa" });
    await navigate({ destination: "Rua Augusta, 123" }, input);
    const second = await navigate({ destination: "Shopping Iguatemi" }, input);
    expect(await book.get("casa")).toBe("Rua Augusta, 123");
    expect(second.result).toEqual({ navigating_to: "Shopping Iguatemi" });
  });

  it("does not save a repeated label as the address", async () => {
    const book = new InProcessAddressBook();
    const navigate = createNavigateTo(book, { pendingLabel: "casa" });
    const out = await navigate({ destination: "casa" }, input);
    expect(await book.get("casa")).toBeUndefined();
    expect(out.continuation).toEqual({ pendingLabel: "casa" });
  });

  it.each([{ destination: "" }, { destination: "   " }, {}, { destination: 42 }])(
    "asks where to go for %j",
    async (args) => {
      const navigate = createNavigateTo(new InProcessAddressBook());
      expect(await navigate(args, input)).toEqual({
        result: { needs_destination: true },
        continuation: { awaitingDestination: true },
      });
    },
  );
});
