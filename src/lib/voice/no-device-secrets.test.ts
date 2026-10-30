import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for the PWA invariants (contract pwa-convite-e-dono.md, invariant 4): the phone
 * keeps only the session token. The scanner is a pure function over {path, text}, so the tests
 * below prove it on the real sources (must be clean) and on mutated copies (must fail).
 */
interface Source {
  path: string;
  text: string;
}

const BANNED_NAMES =
  /spotifyRefreshToken|savedAddresses|driverContext|DriverContext|save_address|spotify_refresh_token|saveDictatedAddress/;
const SECRET_WORDS = /token|invite|\bcode\b|driverId|secret|Bearer|cookie|authorization/i;
const DOM_SINKS = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(/;
/** Files allowed to call `.setItem(`, and the only storage key each may write. */
const SETITEM_ALLOWED: Record<string, RegExp> = {
  "src/lib/voice/token-store.ts": /TOKEN_STORAGE_KEY/,
  "src/lib/voice/driver-settings.ts": /DRIVER_SETTINGS_STORAGE_KEY/,
  "src/lib/voice/legacy-cleanup.ts": /DRIVER_SETTINGS_STORAGE_KEY/,
};
const OTHER_STORAGE = /sessionStorage|indexedDB|document\.cookie|cookieStore|caches\.open/;

/** The text of a call starting at `start` (the "(" index), through its matching ")". Strings and comments are skipped. */
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < text.length && text[i] !== quote; i++) if (text[i] === "\\") i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

export function scan(sources: Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (!path.endsWith("legacy-cleanup.ts") && BANNED_NAMES.test(text)) out.push(`${path}: removed field name`);

    // console: only direct `console.<level>(...)` calls; an alias (`const log = console.warn`,
    // `const { warn } = console`, `console["warn"]`, `[console.warn]`) hides the arguments from this scan.
    for (const m of text.matchAll(/\bconsole\b(?!\s*\.\s*(?:log|info|warn|error|debug)\s*\()/g)) {
      out.push(`${path}: console used other than as a direct call (${text.slice(m.index, m.index + 24).replace(/\s+/g, " ")})`);
    }
    for (const m of text.matchAll(/\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(/g)) {
      const call = callText(text, m.index + m[0].length - 1);
      if (SECRET_WORDS.test(call)) out.push(`${path}: console call mentions a secret-bearing name: ${call.replace(/\s+/g, " ").slice(0, 80)}`);
    }

    if (OTHER_STORAGE.test(text)) out.push(`${path}: storage other than localStorage`);
    for (const m of text.matchAll(/\.setItem\s*\(/g)) {
      const key = SETITEM_ALLOWED[path];
      const args = callText(text, m.index + m[0].length - 1);
      if (!key) out.push(`${path}: setItem outside the allowed files`);
      else if (!key.test(args)) out.push(`${path}: setItem with an unexpected key`);
    }
    if (path.endsWith(".tsx") && DOM_SINKS.test(text)) out.push(`${path}: raw HTML sink`);
    if (path.endsWith(".tsx") && /localStorage/.test(text)) out.push(`${path}: components must not touch localStorage`);
  }
  return out;
}

const ROOT = process.cwd();
function list(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return list(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const real: Source[] = [join(ROOT, "src/lib/voice"), join(ROOT, "src/components")]
  .flatMap(list)
  .map((p) => ({ path: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

const base = (path: string): Source => real.find((s) => s.path === path)!;
const mutate = (path: string, from: string | RegExp, to: string): Source[] => {
  const src = base(path);
  const text = src.text.replace(from, to);
  expect(text).not.toBe(src.text); // the mutation must apply, or the proof proves nothing
  return [{ path, text }];
};

describe("PWA client source guard", () => {
  it("scans the real sources, and they are clean", () => {
    expect(real.length).toBeGreaterThan(15);
    expect(real.some((s) => s.path.endsWith(".tsx"))).toBe(true);
    expect(scan(real)).toEqual([]);
  });

  describe("fails on mutations", () => {
    const ctl = "src/lib/voice/voice-controller.ts";
    const cases: Array<[string, Source[]]> = [
      ["a removed field name returns", mutate(ctl, "const TICK_MS", "const spotifyRefreshToken = 1;\nconst TICK_MS")],
      ["console with a secret on the same line", mutate(ctl, 'console.info("[voice] session closed:", reason)', 'console.info("[voice] session closed:", this.tokens.get())')],
      [
        "console with a secret on the next line (multi-line call)",
        mutate(ctl, 'console.info("[voice] session closed:", reason)', 'console.info(\n          "[voice] session closed:",\n          this.tokens.get(),\n        )'),
      ],
      ["console aliased to a variable", mutate(ctl, 'console.info("[voice] session closed:", reason)', 'const log = console.warn;\n        log(this.tokens.get())')],
      ["console destructured", mutate(ctl, 'console.info("[voice] session closed:", reason)', "const { warn } = console;\n        warn(reason)")],
      ["console via bracket access", mutate(ctl, 'console.info("[voice] session closed:", reason)', 'console["warn"](reason)')],
      ["a driver id logged", mutate(ctl, 'console.info("[voice] session closed:", reason)', 'console.error("x", driverId)')],
      ["localStorage.setItem in the controller", mutate(ctl, "private settingsOpen = false;", 'private settingsOpen = (window.localStorage.setItem("x", "y"), false);')],
      [
        "setItem with the wrong key in token-store",
        mutate("src/lib/voice/token-store.ts", "setItem(TOKEN_STORAGE_KEY, value)", 'setItem("finn.other", value)'),
      ],
      ["sessionStorage used", mutate(ctl, "private settingsOpen = false;", 'private settingsOpen = (sessionStorage.getItem("a"), false);')],
      ["document.cookie used", mutate(ctl, "private settingsOpen = false;", "private settingsOpen = (document.cookie.length > 0, false);")],
      [
        "dangerouslySetInnerHTML in a component",
        mutate("src/components/InviteSetup.tsx", "<form", '<form dangerouslySetInnerHTML={{ __html: "x" }} data-x=""'),
      ],
      ["innerHTML in a component", mutate("src/components/InviteSetup.tsx", "const submit", "const bad = (el: HTMLElement) => (el.innerHTML = code);\n  const submit")],
      ["localStorage in a component", mutate("src/components/InviteSetup.tsx", "const submit", 'const bad = () => window.localStorage.getItem("x");\n  const submit')],
    ];
    it.each(cases)("%s", (_name, mutated) => {
      expect(scan(mutated).length).toBeGreaterThan(0);
    });
  });

  it("does not flag the allowed uses (setItem with the right key in token-store, driver-settings, legacy-cleanup)", () => {
    const allowed = real.filter((s) => s.path in SETITEM_ALLOWED);
    expect(allowed).toHaveLength(3);
    expect(allowed.every((s) => /\.setItem\s*\(/.test(s.text))).toBe(true);
    expect(scan(allowed)).toEqual([]);
  });
});
