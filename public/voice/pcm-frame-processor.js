/**
 * AudioWorklet: mic audio (context rate, usually 48 kHz) → 16 kHz mono Int16
 * frames of `frameLength` samples, posted to the main thread for Porcupine.
 * Lets the wake-word engine share the single trip-wide MediaStream instead of
 * opening a second mic capture (WebVoiceProcessor always calls getUserMedia).
 *
 * Resampling: windowed-sinc low-pass (anti-aliasing) at the input rate, then
 * linear interpolation at the 16 kHz output positions.
 */

const OUTPUT_RATE = 16000;
const TAPS = 31;

function designLowPass(inputRate) {
  const cutoff = Math.min(7200, OUTPUT_RATE * 0.45) / inputRate;
  const h = new Float32Array(TAPS);
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * hamming;
    sum += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum;
  return h;
}

class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frameLength = opts.frameLength || 512;
    this.enabled = false;
    this.step = sampleRate / OUTPUT_RATE;
    this.filter = this.step > 1 ? designLowPass(sampleRate) : null;
    this.history = new Float32Array(TAPS);
    this.historyPos = 0;
    this.prev = 0; // last filtered input sample
    this.pos = 0; // next output position, in input samples relative to the current block
    this.frame = new Int16Array(this.frameLength);
    this.filled = 0;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.command === "enable") this.enabled = true;
      if (msg.command === "disable") {
        this.enabled = false;
        this.filled = 0;
      }
      if (msg.command === "configure" && msg.frameLength > 0) {
        this.frameLength = msg.frameLength;
        this.frame = new Int16Array(this.frameLength);
        this.filled = 0;
      }
    };
  }

  lowPass(x) {
    if (!this.filter) return x;
    this.history[this.historyPos] = x;
    let acc = 0;
    let idx = this.historyPos;
    for (let i = 0; i < TAPS; i++) {
      acc += this.filter[i] * this.history[idx];
      idx = idx === 0 ? TAPS - 1 : idx - 1;
    }
    this.historyPos = (this.historyPos + 1) % TAPS;
    return acc;
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.filled === this.frameLength) {
      const out = this.frame;
      this.port.postMessage(out, [out.buffer]);
      this.frame = new Int16Array(this.frameLength);
      this.filled = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !this.enabled) return true;

    // Output positions are fractional indices into [prev, channel...]: index 0 is `prev`.
    for (let i = 0; i < channel.length; i++) {
      const current = this.lowPass(channel[i]);
      // Emit every output sample that falls between prev (i) and current (i + 1).
      while (this.pos <= i + 1) {
        const frac = this.pos - i;
        this.push(this.prev + (current - this.prev) * frac);
        this.pos += this.step;
      }
      this.prev = current;
    }
    this.pos -= channel.length;
    return true;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
