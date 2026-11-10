/**
 * Modal dialog accessibility, written against a minimal DOM surface so it can be tested without a
 * browser: focus moves in on open, Tab stays inside, Esc closes, the content behind is inert, and
 * focus goes back to what opened the dialog.
 */

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusableLike {
  focus(): void;
}

export interface DialogElementLike extends FocusableLike {
  parentElement: {
    children: ArrayLike<DialogSiblingLike>;
  } | null;
  querySelectorAll(selector: string): ArrayLike<FocusableLike>;
}

export interface DialogSiblingLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
}

export interface DocumentLike {
  activeElement: unknown;
  addEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
  removeEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
  contains?(node: unknown): boolean;
}

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  preventDefault(): void;
}

/** Where Tab / Shift+Tab should go to stay inside the dialog, or null to let the browser move. */
export function trapTarget<T>(items: readonly T[], active: unknown, shift: boolean): T | null {
  if (items.length === 0) return null;
  const first = items[0];
  const last = items[items.length - 1];
  const at = items.indexOf(active as T);
  if (at === -1) return shift ? last : first; // focus is on the title or outside the list
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}

export interface AttachOptions {
  root: DialogElementLike;
  initialFocus: FocusableLike | null;
  onClose: () => void;
  doc: DocumentLike;
}

export function attachDialogA11y({ root, initialFocus, onClose, doc }: AttachOptions): () => void {
  const opener = doc.activeElement as FocusableLike | null;

  // Everything else next to the dialog becomes inert (unreachable by touch, keyboard and readers).
  const inerted: DialogSiblingLike[] = [];
  for (const el of Array.from(root.parentElement?.children ?? [])) {
    if ((el as unknown) === root || el.hasAttribute("inert")) continue;
    el.setAttribute("inert", "");
    inerted.push(el);
  }

  initialFocus?.focus();

  const onKeyDown = (e: KeyEventLike) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const target = trapTarget(Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)), doc.activeElement, !!e.shiftKey);
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };
  doc.addEventListener("keydown", onKeyDown);

  return () => {
    doc.removeEventListener("keydown", onKeyDown);
    for (const el of inerted) el.removeAttribute("inert");
    opener?.focus?.();
  };
}
