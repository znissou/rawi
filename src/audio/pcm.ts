// Audio as plain numbers: 16-bit PCM in, trimmed and time-stretched floats, WAV out.
// WSOLA and the silence trimming were measured in M0 (spikes/m0/README.md).

/** Raw speech from an engine. */
export interface Audio {
  /** 16-bit little-endian PCM, interleaved when there are several channels. */
  pcm: Buffer;
  rate: number;
  channels: number;
  /** How long the request took, when it came from the network (for the log). */
  timing?: { firstByteMs: number; totalMs: number };
}

export function pcm16ToFloat(buf: Buffer, channels = 1): Float32Array {
  const frames = Math.floor(buf.length / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE((i * channels + c) * 2);
    out[i] = sum / channels / 32768; // mixed down to mono
  }
  return out;
}

export function wavBytes(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** First and last sample louder than `db` dBFS, measured on 5 ms windows. */
export function soundBounds(x: Float32Array, rate: number, db = -45): [number, number] {
  const win = Math.max(1, Math.round(rate * 0.005));
  const limit = Math.pow(10, db / 20);
  let first = -1;
  let last = -1;
  for (let s = 0; s + win <= x.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += x[i] * x[i];
    if (Math.sqrt(e / win) > limit) {
      if (first < 0) first = s;
      last = s + win;
    }
  }
  return first < 0 ? [0, 0] : [first, last];
}

/** Cuts leading and trailing silence down to `keepMs` (voices add 0.2 to 0.3 s of it). */
export function trimSilence(x: Float32Array, rate: number, keepMs = 20): Float32Array {
  const [a, b] = soundBounds(x, rate);
  if (b <= a) return x.slice(0, 0);
  const keep = Math.round((rate * keepMs) / 1000);
  return x.slice(Math.max(0, a - keep), Math.min(x.length, b + keep));
}

/** Short fade in and out, so cuts never click. Changes `x` in place. */
export function fade(x: Float32Array, rate: number, ms = 5): Float32Array {
  const n = Math.min(x.length >> 1, Math.round((rate * ms) / 1000));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

export function withSilence(x: Float32Array, rate: number, ms: number): Float32Array {
  const out = new Float32Array(x.length + Math.round((rate * ms) / 1000));
  out.set(x);
  return out;
}

/**
 * WSOLA time-stretch: plays `x` `speed` times faster (or slower) without changing the pitch.
 * 25 ms Hann frames at 50% overlap; each frame is taken within ±10 ms of its nominal place, where
 * it best continues the previous one (a coarse search, then a fine one).
 */
export function timeStretch(x: Float32Array, rate: number, speed: number): Float32Array {
  if (Math.abs(speed - 1) < 1e-3 || x.length === 0) return x;
  const N = 2 * Math.round(rate * 0.0125);
  const Hs = N / 2;
  const Ha = Hs * speed;
  const tol = Math.round(rate * 0.01);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outLen = Math.ceil(x.length / speed);
  const y = new Float32Array(outLen + N);
  const at = (i: number) => (i >= 0 && i < x.length ? x[i] : 0);
  let prev = 0;
  for (let k = 0; ; k++) {
    const nominal = Math.round(k * Ha);
    if (nominal >= x.length) break;
    let pos = nominal;
    if (k > 0) {
      const ref = prev + Hs; // where the previous frame would naturally continue
      let best = -Infinity;
      const scan = (from: number, to: number, step: number, stride: number) => {
        for (let c = from; c <= to; c += step) {
          let dot = 0;
          let e = 1e-9;
          for (let i = 0; i < Hs; i += stride) {
            const a = at(c + i);
            dot += a * at(ref + i);
            e += a * a;
          }
          const score = dot / Math.sqrt(e);
          if (score > best) {
            best = score;
            pos = c;
          }
        }
      };
      scan(nominal - tol, nominal + tol, 4, 4);
      best = -Infinity;
      scan(pos - 4, pos + 4, 1, 1);
    }
    const o = k * Hs;
    for (let i = 0; i < N; i++) y[o + i] += w[i] * at(pos + i);
    prev = pos;
  }
  return y.subarray(0, outLen);
}

/** Everything rawi does to a piece of speech before playing it. */
export function prepareSpeech(audio: Audio, speed: number, pauseAfterMs: number): { wav: Buffer; durationMs: number } {
  let x = pcm16ToFloat(audio.pcm, audio.channels);
  x = fade(trimSilence(x, audio.rate), audio.rate);
  x = timeStretch(x, audio.rate, speed);
  x = withSilence(x, audio.rate, pauseAfterMs);
  return { wav: wavBytes(x, audio.rate), durationMs: Math.round((x.length / audio.rate) * 1000) };
}

/** Median pitch (Hz) of the voiced parts, by autocorrelation over 40 ms frames. Used in tests. */
export function medianPitch(x: Float32Array, rate: number): number {
  const frame = Math.round(rate * 0.04);
  const hop = Math.round(rate * 0.02);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.ceil(rate / 70);
  const found: number[] = [];
  for (let s = 0; s + frame + maxLag < x.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + frame; i++) e += x[i] * x[i];
    if (Math.sqrt(e / frame) < 0.02) continue;
    const scores = new Float32Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let dot = 0;
      let e2 = 1e-9;
      for (let i = s; i < s + frame; i += 2) {
        dot += x[i] * x[i + lag];
        e2 += x[i + lag] * x[i + lag];
      }
      scores[lag] = dot / Math.sqrt((e / 2) * e2);
      best = Math.max(best, scores[lag]);
    }
    if (best <= 0.6) continue;
    // The shortest period that fits almost as well as the best, so a double period isn't taken.
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (scores[lag] >= 0.9 * best && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
        found.push(rate / lag);
        break;
      }
    }
  }
  found.sort((a, b) => a - b);
  return found.length ? found[found.length >> 1] : 0;
}
