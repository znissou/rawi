import { describe, expect, it } from 'vitest';
import { medianPitch, pcm16ToFloat, prepareSpeech, timeStretch, trimSilence, wavBytes } from '../src/audio/pcm';

const RATE = 24000;

/** A voiced-like signal: 150 Hz with harmonics, 1 s, between two 0.3 s silences. */
function voice(seconds = 1, f0 = 150): Float32Array {
  const pad = Math.round(RATE * 0.3);
  const n = Math.round(RATE * seconds);
  const x = new Float32Array(pad + n + pad);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    x[pad + i] = 0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.15 * Math.sin(4 * Math.PI * f0 * t) + 0.08 * Math.sin(6 * Math.PI * f0 * t);
  }
  return x;
}

function toPcm(x: Float32Array): Buffer {
  const b = Buffer.alloc(x.length * 2);
  x.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), i * 2));
  return b;
}

describe('pcm', () => {
  it('writes a valid mono 16-bit WAV header', () => {
    const wav = wavBytes(new Float32Array(100), 44100);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(44100);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(200);
    expect(wav.length).toBe(244);
  });

  it('round-trips 16-bit PCM and mixes stereo down', () => {
    const b = Buffer.alloc(8);
    b.writeInt16LE(16384, 0); b.writeInt16LE(0, 2); b.writeInt16LE(-32768, 4); b.writeInt16LE(-32768, 6);
    expect(Array.from(pcm16ToFloat(b, 2))).toEqual([0.25, -1]);
  });

  it('trims the silence around speech to 20 ms', () => {
    const x = trimSilence(voice(1), RATE);
    expect(x.length / RATE).toBeGreaterThan(1.0);
    expect(x.length / RATE).toBeLessThan(1.06);
  });

  it('speeds speech up without changing its pitch', () => {
    const x = voice(2);
    expect(Math.abs(medianPitch(x, RATE) - 150)).toBeLessThan(3);
    for (const speed of [1.25, 1.5, 0.8]) {
      const y = timeStretch(x, RATE, speed);
      expect(Math.abs(y.length - x.length / speed)).toBeLessThanOrEqual(1);
      expect(Math.abs(medianPitch(y, RATE) - 150)).toBeLessThan(3);
    }
  });

  it('prepares a piece: trimmed, stretched, then the pause', () => {
    const { wav, durationMs } = prepareSpeech({ pcm: toPcm(voice(1)), rate: RATE, channels: 1 }, 2, 250);
    // about 1.04 s of sound at 2x = 0.52 s, plus 0.25 s of pause
    expect(durationMs).toBeGreaterThan(740);
    expect(durationMs).toBeLessThan(800);
    expect(wav.readUInt32LE(40)).toBe(Math.round((durationMs / 1000) * RATE) * 2);
  });
});
