/** Builds RIFF/WAVE bytes for tests. Defaults mirror what the PWA sends: PCM, mono, 16 kHz, 16-bit, 44-byte header. */
export interface WavOpts {
  rate?: number;
  channels?: number;
  bits?: number;
  format?: number;
  /** Bytes of audio data actually present. */
  dataBytes?: number;
  /** Value written in the `data` size field (default: dataBytes). */
  declared?: number;
}

export function makeWav(o: WavOpts = {}): Uint8Array {
  const { rate = 16000, channels = 1, bits = 16, format = 1 } = o;
  const dataBytes = o.dataBytes ?? 3200;
  const buf = new Uint8Array(44 + dataBytes);
  const v = new DataView(buf.buffer);
  const w = (at: number, s: string) => [...s].forEach((c, i) => (buf[at + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * (bits / 8), true);
  v.setUint16(32, channels * (bits / 8), true);
  v.setUint16(34, bits, true);
  w(36, "data");
  v.setUint32(40, o.declared ?? dataBytes, true);
  buf.fill(1, 44);
  return buf;
}

/** Seconds of PWA-format audio (16 kHz mono 16-bit) in data bytes. */
export const pwaBytes = (seconds: number) => Math.round(seconds * 32000);
export const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
