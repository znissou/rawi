'use strict';
// M0 spike: audio helpers rawi will need in M1 — 16-bit PCM to float, silence trimming, fades,
// pauses, WAV files, WSOLA time-stretch (speed change that keeps the pitch) and a pitch estimate.

function pcm16ToFloat(buf) {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function wavBytes(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** First and last sample louder than `db` dBFS, measured on 5 ms windows. */
function soundBounds(x, rate, db = -45) {
  const win = Math.max(1, Math.round(rate * 0.005));
  const limit = Math.pow(10, db / 20);
  let first = -1, last = -1;
  for (let s = 0; s + win <= x.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += x[i] * x[i];
    if (Math.sqrt(e / win) > limit) { if (first < 0) first = s; last = s + win; }
  }
  return first < 0 ? [0, 0] : [first, last];
}

/** Cut leading and trailing silence down to `keepMs`. */
function trim(x, rate, keepMs = 20) {
  const [a, b] = soundBounds(x, rate);
  const keep = Math.round(rate * keepMs / 1000);
  return x.slice(Math.max(0, a - keep), Math.min(x.length, b + keep));
}

function fade(x, rate, ms = 5) {
  const n = Math.min(x.length >> 1, Math.round(rate * ms / 1000));
  for (let i = 0; i < n; i++) { const g = i / n; x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const silence = (rate, ms) => new Float32Array(Math.round(rate * ms / 1000));

/**
 * WSOLA time-stretch: plays `x` `speed` times faster without changing its pitch.
 * 25 ms Hann frames at 50% overlap; each frame is taken within ±10 ms of its nominal place,
 * where it best continues the previous one (coarse search, then a fine one).
 */
function wsola(x, rate, speed) {
  if (Math.abs(speed - 1) < 1e-6) return Float32Array.from(x);
  const N = 2 * Math.round(rate * 0.0125);
  const Hs = N / 2;
  const Ha = Hs * speed;
  const tol = Math.round(rate * 0.010);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outLen = Math.ceil(x.length / speed);
  const y = new Float32Array(outLen + N);
  const at = (i) => (i >= 0 && i < x.length ? x[i] : 0);
  let prev = 0;
  for (let k = 0; ; k++) {
    const nominal = Math.round(k * Ha);
    if (nominal >= x.length) break;
    let pos = nominal;
    if (k > 0) {
      const ref = prev + Hs; // where the previous frame would naturally continue
      let best = -Infinity;
      const scan = (from, to, step, stride) => {
        for (let c = from; c <= to; c += step) {
          let dot = 0, e = 1e-9;
          for (let i = 0; i < Hs; i += stride) { const a = at(c + i); dot += a * at(ref + i); e += a * a; }
          const score = dot / Math.sqrt(e);
          if (score > best) { best = score; pos = c; }
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

/** Median pitch (Hz) of the voiced parts, by autocorrelation over 40 ms frames. */
function medianPitch(x, rate) {
  const frame = Math.round(rate * 0.04), hop = Math.round(rate * 0.02);
  const minLag = Math.floor(rate / 400), maxLag = Math.ceil(rate / 70);
  const found = [];
  for (let s = 0; s + frame + maxLag < x.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + frame; i++) e += x[i] * x[i];
    if (Math.sqrt(e / frame) < 0.02) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let dot = 0, e2 = 1e-9;
      for (let i = s; i < s + frame; i += 2) { dot += x[i] * x[i + lag]; e2 += x[i + lag] * x[i + lag]; }
      const score = dot / Math.sqrt((e / 2) * e2);
      if (score > best) { best = score; bestLag = lag; }
    }
    if (best > 0.6) found.push(rate / bestLag);
  }
  found.sort((a, b) => a - b);
  return found.length ? found[found.length >> 1] : 0;
}

module.exports = { pcm16ToFloat, wavBytes, soundBounds, trim, fade, concat, silence, wsola, medianPitch };
