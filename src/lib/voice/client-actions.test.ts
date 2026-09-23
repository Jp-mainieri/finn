import { describe, expect, it, vi } from "vitest";
import type { ClientAction } from "@/lib/contracts/client-events";
import { openPendingAction, toPendingActions } from "./client-actions";

let n = 0;
const id = () => `a${++n}`;

describe("toPendingActions", () => {
  it("keeps open_url actions with their label", () => {
    const actions: ClientAction[] = [
      { type: "open_url", url: "https://waze.com/ul?q=Rua%20A%2C%20100&navigate=yes", label: "Ir para Rua A, 100" },
    ];
    expect(toPendingActions(actions, () => "x")).toEqual([
      {
        id: "x",
        type: "open_url",
        url: "https://waze.com/ul?q=Rua%20A%2C%20100&navigate=yes",
        label: "Ir para Rua A, 100",
      },
    ]);
  });

  it("falls back to a sensible label", () => {
    const [waze, other] = toPendingActions(
      [
        { type: "open_url", url: "https://waze.com/ul?q=x" },
        { type: "open_url", url: "https://example.com/x", label: "  " },
      ],
      id,
    );
    expect(waze.label).toBe("Abrir no Waze");
    expect(other.label).toBe("Abrir link");
  });

  it("drops invalid, non-http(s) and unknown actions", () => {
    const actions = [
      { type: "open_url", url: "javascript:alert(1)" },
      { type: "open_url", url: "not a url" },
      { type: "play_sound", url: "https://x.y" },
      null,
    ] as unknown as ClientAction[];
    expect(toPendingActions(actions, id)).toEqual([]);
  });
});

describe("openPendingAction", () => {
  const action = { id: "a", type: "open_url" as const, url: "https://waze.com/ul?q=x", label: "Abrir no Waze" };

  it("navigates top-level to the deep link (not a popup)", () => {
    const nav = { assign: vi.fn() };
    expect(openPendingAction(action, nav)).toBe(true);
    expect(nav.assign).toHaveBeenCalledWith("https://waze.com/ul?q=x");
  });

  it("reports failure so the on-screen button stays the fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nav = {
      assign: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    expect(openPendingAction(action, nav)).toBe(false);
    warn.mockRestore();
  });
});
