import { Audio, pcm16ToFloat } from './pcm';

/**
 * Speech processed as it arrives, so rawi can start playing before a voice has finished sending.
 * Same steps as prepareSpeech(): trim the silence around the speech, change the speed without
 * changing the pitch, then a short fade at each end. Everything leaves as mono at OUTPUT_RATE, so
 * voices with different sample rates can follow each other in one audio stream.
 */

export const OUTPUT_RATE = 44100;
const EMPTY: Float32Array = new Float32Array(0);
const SILENCE_DB = -45;

/** WSOLA time-stretch fed in pieces. Its output is the same as timeStretch() on the whole input. */
export class StreamStretch {
  private x: Float32Array = new Float32Array(1 << 16);
  private xLen = 0;
  private y: Float32Array = new Float32Array(1 << 16);
  private k = 0;
  private prev = 0;
  private emitted = 0;
  private readonly N: number;
  private readonly Hs: number;
  private readonly Ha: number;
  private readonly tol: number;
  private readonly w: Float32Array;
  private readonly passthrough: boolean;

  constructor(rate: number, private readonly speed: number) {
    this.passthrough = Math.abs(speed - 1) < 1e-3;
    this.N = 2 * Math.round(rate * 0.0125);
    this.Hs = this.N / 2;
    this.Ha = this.Hs * speed;
    this.tol = Math.round(rate * 0.01);
    this.w = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
  }

  push(chunk: Float32Array): Float32Array {
    if (this.passthrough) return chunk;
    if (this.xLen + chunk.length > this.x.length) this.x = grow(this.x, this.xLen + chunk.length);
    this.x.set(chunk, this.xLen);
    this.xLen += chunk.length;
    return this.run(false);
  }

  end(): Float32Array {
    return this.passthrough ? EMPTY : this.run(true);
  }

  private at(i: number): number {
    return i >= 0 && i < this.xLen ? this.x[i] : 0;
  }

  private run(final: boolean): Float32Array {
    const { N, Hs, Ha, tol, w } = this;
    for (;;) {
      const nominal = Math.round(this.k * Ha);
      if (nominal >= this.xLen) break;
      if (!final && nominal + tol + N > this.xLen) break; // needs more input
      let pos = nominal;
      if (this.k > 0) {
        const ref = this.prev + Hs;
        let best = -Infinity;
        const scan = (from: number, to: number, step: number, stride: number) => {
          for (let c = from; c <= to; c += step) {
            let dot = 0;
            let e = 1e-9;
            for (let i = 0; i < Hs; i += stride) {
              const a = this.at(c + i);
              dot += a * this.at(ref + i);
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
      const o = this.k * Hs;
      if (o + N > this.y.length) this.y = grow(this.y, o + N);
      for (let i = 0; i < N; i++) this.y[o + i] += w[i] * this.at(pos + i);
      this.prev = pos;
      this.k++;
    }
    // A stretch of output is final once both overlapping frames have been added.
    const ready = final ? Math.ceil(this.xLen / this.speed) : this.k * Hs;
    if (ready > this.y.length) this.y = grow(this.y, ready);
    const out = this.y.slice(this.emitted, Math.max(this.emitted, ready));
    this.emitted = Math.max(this.emitted, ready);
    return out;
  }
}

/** Linear-interpolation resampler fed in pieces (good enough for speech going up to 44.1 kHz). */
export class StreamResampler {
  private t = 0; // position of the next output sample, in input samples, from the carried sample
  private last: number | undefined;

  constructor(private readonly from: number, private readonly to: number) {}

  push(x: Float32Array): Float32Array {
    if (this.from === this.to || x.length === 0) return x;
    const input = this.last === undefined ? x : withFirst(this.last, x);
    const step = this.from / this.to;
    const n = Math.max(0, Math.ceil((input.length - 1 - this.t) / step));
    const out = new Float32Array(n);
    let t = this.t;
    for (let j = 0; j < n; j++, t += step) {
      const i = Math.floor(t);
      const f = t - i;
      out[j] = i + 1 < input.length ? input[i] * (1 - f) + input[i + 1] * f : input[i];
    }
    this.t = t - (input.length - 1);
    this.last = input[input.length - 1];
    return out;
  }
}

/** Raw 16-bit speech in, as it arrives; trimmed, stretched, resampled samples out. */
export class SpeechProcessor {
  private leftover = Buffer.alloc(0);
  private speaking = false;
  private lead: Float32Array = EMPTY;
  private hold: Float32Array = EMPTY;
  private faded = false;
  private readonly stretch: StreamStretch;
  private readonly resample: StreamResampler;
  private readonly keepIn: number;
  private readonly holdOut: number;

  constructor(private readonly rate: number, private readonly channels: number, speed: number, private readonly outRate = OUTPUT_RATE) {
    this.stretch = new StreamStretch(rate, speed);
    this.resample = new StreamResampler(rate, outRate);
    this.keepIn = Math.round(rate * 0.02); // 20 ms kept before the first sound
    this.holdOut = Math.round(outRate * 0.3); // held back to trim the trailing silence at the end
  }

  push(pcm: Buffer): Float32Array {
    const frame = 2 * this.channels;
    let data = this.leftover.length ? Buffer.concat([this.leftover, pcm]) : pcm;
    const usable = data.length - (data.length % frame);
    this.leftover = Buffer.from(data.subarray(usable)); // a sample split across network chunks
    data = data.subarray(0, usable);
    if (!data.length) return EMPTY;
    let x = pcm16ToFloat(data, this.channels);
    if (!this.speaking) {
      const all = this.lead.length ? concat([this.lead, x]) : x;
      const onset = firstSound(all, this.rate);
      if (onset < 0) {
        this.lead = all.slice(Math.max(0, all.length - this.keepIn));
        return EMPTY;
      }
      this.speaking = true;
      this.lead = EMPTY;
      x = all.slice(Math.max(0, onset - this.keepIn));
    }
    return this.out(this.resample.push(this.stretch.push(x)), false);
  }

  /** The piece is complete: the held-back end, trimmed, then `pauseMs` of silence. */
  end(pauseMs: number): Float32Array {
    if (!this.speaking) return EMPTY; // nothing but silence came
    const rest = this.out(this.resample.push(this.stretch.end()), true);
    return concat([rest, new Float32Array(Math.round((this.outRate * pauseMs) / 1000))]);
  }

  private out(y: Float32Array, final: boolean): Float32Array {
    let all = this.hold.length ? concat([this.hold, y]) : y;
    if (!this.faded && (final || all.length > this.holdOut)) {
      fadeEdge(all, this.outRate, 'in');
      this.faded = true;
    }
    if (final) {
      const lastSound = lastSoundEnd(all, this.outRate);
      all = all.slice(0, lastSound < 0 ? 0 : Math.min(all.length, lastSound + Math.round(this.outRate * 0.02)));
      fadeEdge(all, this.outRate, 'out');
      this.hold = EMPTY;
      return all;
    }
    if (all.length <= this.holdOut) {
      this.hold = all;
      return EMPTY;
    }
    this.hold = all.slice(all.length - this.holdOut);
    return all.slice(0, all.length - this.holdOut);
  }
}

/** Reads a PCM WAV file (16-bit). */
export function parseWav(buf: Buffer): Audio {
  let pos = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (tag === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      rate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (tag === 'data') {
      if (bits !== 16) throw new Error(`Unsupported WAV: ${bits}-bit`);
      return { pcm: buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size)), rate, channels };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('Not a WAV file');
}

export function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function grow(a: Float32Array, min: number): Float32Array {
  const b = new Float32Array(Math.max(min, a.length * 2));
  b.set(a);
  return b;
}

function withFirst(v: number, x: Float32Array): Float32Array {
  const out = new Float32Array(x.length + 1);
  out[0] = v;
  out.set(x, 1);
  return out;
}

function windowLoud(x: Float32Array, s: number, win: number, limit: number): boolean {
  let e = 0;
  for (let i = s; i < s + win; i++) e += x[i] * x[i];
  return Math.sqrt(e / win) > limit;
}

/** Index of the first 5 ms window louder than -45 dBFS, or -1. */
function firstSound(x: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round(rate * 0.005));
  const limit = Math.pow(10, SILENCE_DB / 20);
  for (let s = 0; s + win <= x.length; s += win) if (windowLoud(x, s, win, limit)) return s;
  return -1;
}

/** End of the last 5 ms window louder than -45 dBFS, or -1. */
function lastSoundEnd(x: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round(rate * 0.005));
  const limit = Math.pow(10, SILENCE_DB / 20);
  for (let s = x.length - win; s >= 0; s -= win) if (windowLoud(x, s, win, limit)) return s + win;
  return -1;
}

function fadeEdge(x: Float32Array, rate: number, edge: 'in' | 'out'): void {
  const n = Math.min(x.length, Math.round(rate * 0.005));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    if (edge === 'in') x[i] *= g;
    else x[x.length - 1 - i] *= g;
  }
}
