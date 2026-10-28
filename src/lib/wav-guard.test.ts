import { describe, expect, it } from "vitest";
import { checkWavPcm } from "@/lib/wav-guard";
import { makeWav } from "../../tests/helpers/wav";

describe("checkWavPcm", () => {
  it("reports the duration of the real data", () => {
    expect(checkWavPcm(makeWav({ dataBytes: 32000 }))).toEqual({ ok: true, seconds: 1 });
  });

  it("skips other chunks before data, including an odd-sized one with its pad byte", () => {
    const base = makeWav({ dataBytes: 3200 });
    const list = new Uint8Array(8 + 5 + 1); // "LIST", size 5, 5 bytes, 1 pad
    list.set(Buffer.from("LIST"), 0);
    new DataView(list.buffer).setUint32(4, 5, true);
    const out = new Uint8Array(base.length + list.length);
    out.set(base.slice(0, 36), 0);
    out.set(list, 36);
    out.set(base.slice(36), 36 + list.length);
    expect(checkWavPcm(out)).toMatchObject({ ok: true });
  });

  it("never throws on junk", () => {
    for (let n = 0; n < 60; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(() => checkWavPcm(b)).not.toThrow();
    }
    const truncated = makeWav().slice(0, 30);
    for (let n = 0; n <= 44; n++) expect(() => checkWavPcm(truncated.slice(0, Math.min(n, 30)))).not.toThrow();
  });

  it("a chunk whose size runs past the end does not loop or pass", () => {
    const w = makeWav();
    new DataView(w.buffer).setUint32(16, 0xffffffff, true); // fmt size
    expect(checkWavPcm(w)).toMatchObject({ ok: false });
  });
});
