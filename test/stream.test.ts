import { describe, expect, it } from 'vitest';
import { medianPitch, timeStretch, wavBytes } from '../src/audio/pcm';
import { OUTPUT_RATE, SpeechProcessor, StreamResampler, StreamStretch, concat, parseWav } from '../src/audio/stream';
import { expiryNotice, expiryText } from '../src/engines/expiry';

const RATE = 24000;

function voice(seconds: number, f0 = 150, rate = RATE): Float32Array {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    x[i] = 0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.15 * Math.sin(4 * Math.PI * f0 * t) + 0.08 * Math.sin(6 * Math.PI * f0 * t);
  }
  return x;
}

/** Feeds `x` in uneven pieces. */
function pieces(x: Float32Array, sizes = [1, 777, 3000, 50, 12345, 4096]): Float32Array[] {
  const out: Float32Array[] = [];
  for (let o = 0, k = 0; o < x.length; k++) {
    const n = sizes[k % sizes.length];
    out.push(x.subarray(o, o + n));
    o += n;
  }
  return out;
}

function toPcm(x: Float32Array): Buffer {
  const b = Buffer.alloc(x.length * 2);
  x.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), i * 2));
  return b;
}

describe('StreamStretch', () => {
  it('gives exactly what timeStretch gives on the whole input, however it is fed', () => {
    const x = voice(1.5);
    for (const speed of [1.25, 1.5, 0.8]) {
      const s = new StreamStretch(RATE, speed);
      const streamed = concat([...pieces(x).map((p) => s.push(p)), s.end()]);
      const whole = timeStretch(x, RATE, speed);
      expect(streamed.length).toBe(whole.length);
      let maxDiff = 0;
      for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(streamed[i] - whole[i]));
      expect(maxDiff).toBeLessThan(1e-5);
    }
  });

  it('passes audio through untouched at 1x', () => {
    const x = voice(0.2);
    const s = new StreamStretch(RATE, 1);
    expect(concat([s.push(x), s.end()])).toEqual(x);
  });
});

describe('StreamResampler', () => {
  it('changes the rate without changing the pitch, however it is fed', () => {
    const x = voice(1, 150, 24000);
    const r = new StreamResampler(24000, 44100);
    const y = concat(pieces(x).map((p) => r.push(p)));
    expect(Math.abs(y.length - x.length * (44100 / 24000))).toBeLessThan(3);
    expect(Math.abs(medianPitch(y, 44100) - 150)).toBeLessThan(3);
  });
});

describe('SpeechProcessor', () => {
  it('trims the silence around speech, keeps the speech, adds the pause', () => {
    const quiet = new Float32Array(Math.round(RATE * 0.25));
    const speech = voice(1);
    const pcm = toPcm(concat([quiet, speech, quiet]));
    const p = new SpeechProcessor(RATE, 1, 1);
    const parts: Float32Array[] = [];
    for (let o = 0; o < pcm.length; o += 1001) parts.push(p.push(pcm.subarray(o, o + 1001))); // odd sizes split samples
    parts.push(p.end(250));
    const out = concat(parts);
    const seconds = out.length / OUTPUT_RATE;
    // 1 s of speech + 2 x 20 ms kept + 0.25 s of pause
    expect(seconds).toBeGreaterThan(1.27);
    expect(seconds).toBeLessThan(1.33);
    // nothing comes out until the speech starts, and the first output already has sound in it
    expect(Math.max(...out.subarray(0, Math.round(OUTPUT_RATE * 0.03)).map(Math.abs))).toBeGreaterThan(0.05);
  });

  it('starts handing audio out before the end of the piece', () => {
    const pcm = toPcm(voice(2));
    const p = new SpeechProcessor(RATE, 1, 1.25);
    const first = p.push(pcm.subarray(0, RATE * 2)); // the first second
    expect(first.length / OUTPUT_RATE).toBeGreaterThan(0.4);
    const rest = concat([p.push(pcm.subarray(RATE * 2)), p.end(0)]);
    expect(Math.abs((first.length + rest.length) / OUTPUT_RATE - 2 / 1.25)).toBeLessThan(0.05);
  });

  it('gives nothing for a piece that is only silence', () => {
    const p = new SpeechProcessor(RATE, 1, 1);
    expect(p.push(toPcm(new Float32Array(RATE))).length).toBe(0);
    expect(p.end(250).length).toBe(0);
  });

  it('reads WAV files', () => {
    const wav = wavBytes(voice(0.1, 150, 22050), 22050);
    const audio = parseWav(wav);
    expect(audio).toMatchObject({ rate: 22050, channels: 1 });
    expect(audio.pcm.length).toBe(Math.round(22050 * 0.1) * 2);
  });
});

describe('free model expiry', () => {
  const day = (iso: string) => new Date(`${iso}T10:00:00`);
  it('warns from three days before the end date', () => {
    expect(expiryNotice('2026-11-30', day('2026-11-26'))).toBeUndefined();
    expect(expiryNotice('2026-11-30', day('2026-11-27'))).toEqual({ daysLeft: 3 });
    expect(expiryNotice('2026-11-30', day('2026-11-30'))).toEqual({ daysLeft: 0 });
    expect(expiryNotice('2026-11-30', day('2026-12-02'))).toEqual({ daysLeft: -2 });
    expect(expiryNotice(undefined, day('2026-11-30'))).toBeUndefined();
  });

  it('says it plainly', () => {
    expect(expiryText('HeyGen Voice Turbo', 'Nov 30', 3)).toBe('HeyGen Voice Turbo stops being free on Nov 30, in 3 days.');
    expect(expiryText('HeyGen Voice Turbo', 'Nov 30', 0)).toBe('HeyGen Voice Turbo stops being free today, Nov 30.');
    expect(expiryText('HeyGen Voice Turbo', 'Nov 30', -1)).toBe('HeyGen Voice Turbo stopped being free on Nov 30.');
  });
});
