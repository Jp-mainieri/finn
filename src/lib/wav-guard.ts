/**
 * WAV PCM guard for /api/realtime/transcribe. The client chooses the codec, and a byte cap does not bound the
 * duration of compressed audio, so only RIFF/WAVE PCM is accepted and its duration is computed here.
 * The PWA sends mono 16 kHz 16-bit PCM (44-byte header); anything else this accepts is just as bounded.
 *
 * - 415: not a RIFF/WAVE file, or a WAVE that is not integer PCM (opus, webm, mp3, float, ADPCM...).
 * - 400: a WAV that is truncated, malformed, has absurd parameters, a `data` chunk larger than the file, or is too long.
 */
export const MAX_WAV_SECONDS = 20;

export type WavCheck = { ok: true; seconds: number } | { ok: false; status: 400 | 415; reason: string };

const bad = (status: 400 | 415, reason: string): WavCheck => ({ ok: false, status, reason });
const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

export function checkWavPcm(bytes: Uint8Array, maxSeconds: number = MAX_WAV_SECONDS): WavCheck {
  if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return bad(415, "Only WAV PCM audio is supported");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let rate = 0;
  let channels = 0;
  let bits = 0;
  let haveFmt = false;
  let pos = 12;
  for (let i = 0; i < 16 && pos + 8 <= bytes.length; i++) {
    const id = tag(bytes, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return bad(400, "Invalid WAV header");
      if (view.getUint16(body, true) !== 1) return bad(415, "Only WAV PCM audio is supported");
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (channels < 1 || channels > 2 || rate < 8000 || rate > 48000 || ![8, 16, 24, 32].includes(bits)) {
        return bad(400, "Invalid WAV header");
      }
      haveFmt = true;
    } else if (id === "data") {
      if (!haveFmt) return bad(400, "Invalid WAV header");
      const real = bytes.length - body;
      if (size > real) return bad(400, "Invalid WAV header"); // `data` larger than the file
      // The real byte count after the header is what a decoder may read, so it is what is measured
      // (never less than the declared size, which was just checked to fit).
      const bytesPerSecond = rate * channels * (bits / 8);
      if (real <= 0 || real > maxSeconds * bytesPerSecond) return bad(400, `Audio is longer than ${maxSeconds} s`);
      return { ok: true, seconds: real / bytesPerSecond };
    }
    pos = body + size + (size % 2); // chunks are word aligned
  }
  return bad(400, "Invalid WAV header");
}
