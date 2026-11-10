import { describe, expect, it, vi } from "vitest";
import {
  attachDialogA11y,
  trapTarget,
  type DialogElementLike,
  type DialogSiblingLike,
  type DocumentLike,
  type KeyEventLike,
} from "./dialog-a11y";

function setup() {
  const doc = {
    activeElement: null as unknown,
    listener: null as ((e: KeyEventLike) => void) | null,
    addEventListener: vi.fn((_t: string, l: (e: KeyEventLike) => void) => void (doc.listener = l)),
    removeEventListener: vi.fn(() => void (doc.listener = null)),
  };
  const focusable = () => {
    const el = { focus: vi.fn(() => void (doc.activeElement = el)) };
    return el;
  };
  const f = { close: focusable(), mid: focusable(), last: focusable() };
  const title = focusable();
  const opener = focusable();
  const sibling = () => {
    const attrs = new Set<string>();
    return {
      attrs,
      setAttribute: (n: string) => void attrs.add(n),
      removeAttribute: (n: string) => void attrs.delete(n),
      hasAttribute: (n: string) => attrs.has(n),
    } satisfies DialogSiblingLike & { attrs: Set<string> };
  };
  const behind = [sibling(), sibling()];
  const root: DialogElementLike & DialogSiblingLike = {
    focus: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    hasAttribute: () => false,
    get parentElement(): DialogElementLike["parentElement"] {
      return { children: [behind[0], root, behind[1]] };
    },
    querySelectorAll: () => [f.close, f.mid, f.last],
  };
  doc.activeElement = opener;
  const onClose = vi.fn();
  const detach = attachDialogA11y({ root, initialFocus: title, onClose, doc: doc as unknown as DocumentLike });
  const key = (k: string, shiftKey = false) => {
    const e = { key: k, shiftKey, preventDefault: vi.fn() };
    doc.listener?.(e);
    return e;
  };
  return { doc, f, title, opener, behind, onClose, detach, key };
}

describe("trapTarget", () => {
  it("wraps at both ends and lets the browser move in the middle", () => {
    const items = ["a", "b", "c"];
    expect(trapTarget(items, "c", false)).toBe("a");
    expect(trapTarget(items, "a", true)).toBe("c");
    expect(trapTarget(items, "b", false)).toBeNull();
    expect(trapTarget(items, "title", false)).toBe("a");
    expect(trapTarget(items, "title", true)).toBe("c");
    expect(trapTarget([], "x", false)).toBeNull();
  });
});

describe("attachDialogA11y", () => {
  it("moves focus into the dialog on open and makes the content behind inert", () => {
    const { title, behind } = setup();
    expect(title.focus).toHaveBeenCalledTimes(1);
    for (const el of behind) expect(el.attrs.has("inert")).toBe(true);
  });

  it("Escape closes the dialog; other keys do not", () => {
    const { key, onClose } = setup();
    key("a");
    expect(onClose).not.toHaveBeenCalled();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside: last wraps to first, first with Shift wraps to last", () => {
    const { key, doc, f } = setup();
    doc.activeElement = f.last;
    const tab = key("Tab");
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(f.close.focus).toHaveBeenCalled();

    doc.activeElement = f.close;
    key("Tab", true);
    expect(f.last.focus).toHaveBeenCalled();

    doc.activeElement = f.mid;
    expect(key("Tab").preventDefault).not.toHaveBeenCalled();
  });

  it("on close, releases the page and gives focus back to what opened the dialog", () => {
    const { detach, behind, opener, doc } = setup();
    detach();
    for (const el of behind) expect(el.attrs.has("inert")).toBe(false);
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(doc.removeEventListener).toHaveBeenCalled();
    expect(doc.listener).toBeNull();
  });
});
