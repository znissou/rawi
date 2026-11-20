import { fork } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KokoroEngine } from '../src/engines/kokoro';
import { normalizeText, phonemize } from '../src/kokoro/phonemize';
import { VoicePack, describeVoice, englishVoice } from '../src/kokoro/voices';

const KOKORO = path.join(os.homedir(), '.claude', 'kokoro');
const hasKokoro = fs.existsSync(path.join(KOKORO, 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(KOKORO, 'voices-v1.0.bin'));
const WORKER = path.join(__dirname, '..', 'dist', 'kokoro-worker.js');

describe('Kokoro text', () => {
  it('says numbers, money, years and times the way Kokoro expects', () => {
    expect(normalizeText('It costs $4.50 today.')).toBe('It costs 4 dollars and 50 cents today.');
    expect(normalizeText('Back in 2026, at 10:30.')).toBe('Back in 20 26, at 10 30.');
    expect(normalizeText('Pi is 3.14 and 1,000 is a lot.')).toBe('Pi is 3 point 1 4 and 1000 is a lot.');
    expect(normalizeText('Ask Dr. Smith about pages 3-5.')).toBe('Ask Doctor Smith about pages 3 to 5.');
  });

  it('gives the same phonemes as kokoro-onnx (the Python Kokoro Read Aloud uses)', async () => {
    // From kokoro-onnx 0.6.1's Tokenizer.phonemize on this sentence (2026-11-09).
    expect(await phonemize('Done. I fixed the transcript watcher, and all the tests pass.'))
      .toBe('dˈʌn. aɪ fˈɪkst ðə tɹˈænskɹɪpt wˈɑːtʃɚ, ænd ˈɔːl ðə tˈɛsts pˈæs.');
    expect(await phonemize('Want me to package it and install it in your VS Code?'))
      .toBe('wˈɔnt mˌiː tə pˈækɪdʒ ɪt ænd ɪnstˈɔːl ɪɾ ɪn jʊɹ vˌiːˈɛs kˈoʊd?');
  });

  it('labels the English voices', () => {
    expect(englishVoice('af_heart') && englishVoice('bm_george')).toBe(true);
    expect(englishVoice('jf_alpha')).toBe(false);
    expect(describeVoice('bm_george')).toBe('British English, male');
  });
});

/**
 * Stands in for dist/kokoro-worker.js, without a model: one sentence at a time, in order, 100 ms each.
 * It fails to load once when "<model>.fail" exists.
 */
const FAKE_WORKER = `
const fs = require('fs');
const queue = [];
let busy = false;
process.on('message', (m) => {
  if (m.type === 'init' && fs.existsSync(m.model + '.fail')) {
    fs.rmSync(m.model + '.fail');
    process.send({ type: 'error', message: "Kokoro couldn't load: a test failure." });
  } else if (m.type === 'init') process.send({ type: 'ready', ms: 0, voices: ['af_heart'] });
  else if (m.type === 'speak') { queue.push(m); next(); }
  else if (m.type === 'quit') process.exit(0);
});
process.on('disconnect', () => process.exit(0));
function next() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  setTimeout(() => {
    process.send({ type: 'audio', id: job.id, pcm: new Uint8Array(4800), ms: 100 });
    busy = false;
    next();
  }, 100);
}
`;

describe('Kokoro engine (stand-in worker)', () => {
  let dir: string;
  const engines: KokoroEngine[] = [];
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawi-kokoro-test-'));
    fs.writeFileSync(path.join(dir, 'worker.js'), FAKE_WORKER);
  });
  afterEach(() => {
    while (engines.length) engines.pop()!.dispose();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function engine(log: string[] = [], idleMs?: number, model = 'model.onnx'): KokoroEngine {
    const e = new KokoroEngine({
      workerPath: path.join(dir, 'worker.js'),
      files: () => ({ folder: dir, model: path.join(dir, model), voices: path.join(dir, 'voices.bin'), source: 'setting' }),
      threads: () => 1,
      voice: () => 'af_heart',
      speed: () => 1,
      log: { info: (m) => log.push(m), warn: (m) => log.push(m), error: (m) => log.push(m) },
      idleMs,
    });
    engines.push(e);
    return e;
  }
  const item = { id: 'r', title: 'r', markdown: '' };
  const SIX = 'One. Two. Three. Four. Five. Six.';
  /** Milliseconds until a one-sentence reading started now is heard. */
  const firstAudio = (e: KokoroEngine) => new Promise<number>((resolve, reject) => {
    const t0 = Date.now();
    e.stream('Hello.', item, new AbortController().signal, () => resolve(Date.now() - t0)).catch(reject);
  });

  it('drops a stopped reading at once: the worker only finishes the sentence it was making', async () => {
    const log: string[] = [];
    const e = engine(log, 300);
    const stop = new AbortController();
    const reading = e.stream(SIX, item, stop.signal, () => stop.abort()); // stopped once "One." is heard
    await expect(reading).rejects.toThrow('Stopped.');
    // "Two." is being made (100 ms), then this. When the worker held the whole reading, "Two." to "Six." came first.
    expect(await firstAudio(e)).toBeLessThan(350);
    // Nothing is left waiting, so the worker is still unloaded once unused.
    await vi.waitFor(() => expect(log).toContain('Kokoro stopped: unused for a while.'), { timeout: 3000 });
  });

  it('asks for nothing when the reading is stopped while Kokoro is starting', async () => {
    const e = engine();
    const stop = new AbortController();
    const reading = e.stream(SIX, item, stop.signal, () => undefined);
    stop.abort(); // the worker hasn't said it's ready yet
    await expect(reading).rejects.toThrow('Stopped.');
    expect(await firstAudio(e)).toBeLessThan(250);
  });

  it('tries again after Kokoro failed to load', async () => {
    fs.writeFileSync(path.join(dir, 'fails-once.onnx.fail'), '');
    const e = engine([], undefined, 'fails-once.onnx');
    await expect(e.stream('Hello.', item, new AbortController().signal, () => undefined)).rejects.toThrow("couldn't load");
    expect(await firstAudio(e)).toBeLessThan(2000); // a new worker loads it this time
  });
});

describe.skipIf(!hasKokoro)('Kokoro voices file', () => {
  it('reads the style vectors NumPy reads', () => {
    const pack = new VoicePack(fs.readFileSync(path.join(KOKORO, 'voices-v1.0.bin')));
    expect(pack.names()).toHaveLength(54);
    const near = (a: Float32Array, b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 5));
    near(pack.style('af_heart', 1), [-0.25429, 0.261491, 0.015798]); // row 0
    near(pack.style('af_heart', 100), [-0.217341, 0.14422, -0.019564]); // row 99
    near(pack.style('bm_george', 9999), [-0.249525, 0.068027, -0.357096]); // capped at row 509
    expect(pack.style('af_heart', 5)).toHaveLength(256);
  });
});

describe.skipIf(!hasKokoro || !fs.existsSync(WORKER))('Kokoro worker (built)', () => {
  it('loads the model and speaks a sentence', async () => {
    const proc = fork(WORKER, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const reply = (type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
        proc.on('message', (m: Record<string, unknown>) => (m.type === type ? resolve(m) : m.type === 'error' && reject(new Error(String(m.message)))));
      });
      const ready = reply('ready');
      proc.send({ type: 'init', model: path.join(KOKORO, 'kokoro-v1.0.onnx'), voices: path.join(KOKORO, 'voices-v1.0.bin'), threads: 4 });
      const r = await ready;
      expect(r.voices).toContain('af_heart');
      const audio = reply('audio');
      proc.send({ type: 'speak', id: 1, text: 'Hello there.', voice: 'af_heart', speed: 1 });
      const pcm = Buffer.from((await audio).pcm as Uint8Array);
      const seconds = pcm.length / 2 / 24000;
      expect(seconds).toBeGreaterThan(0.6);
      expect(seconds).toBeLessThan(2.5);
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      expect(peak).toBeGreaterThan(3000); // real speech, not silence
    } finally {
      proc.kill();
    }
  }, 120_000);
});
