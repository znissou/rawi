/**
 * The local Kokoro voice, in its own process, so its memory (about 1.1 GB with the model loaded) and
 * CPU work stay out of VS Code. rawi starts it with VS Code's own runtime (ELECTRON_RUN_AS_NODE) and
 * talks to it over IPC. One request at a time, in the order received. rawi sends the next one only once
 * the last is answered: running the model blocks this process, so a message sent meanwhile is read late,
 * and cancels for sentences queued here came too late to save any time (measured on Windows, 2026-11-16).
 *   in:  { type: 'init', model, voices, threads } | { type: 'speak', id, text, voice, speed } | { type: 'quit' }
 *   out: { type: 'ready', ms, voices } | { type: 'audio', id, pcm (16-bit, 24 kHz mono), ms }
 *        | { type: 'error', id?, message }
 */
import * as fs from 'fs';
import * as ort from 'onnxruntime-node';
import { phonemize } from './phonemize';
import { VOCAB } from './vocab';
import { VoicePack, englishVoice } from './voices';

type Message =
  | { type: 'init'; model: string; voices: string; threads: number }
  | { type: 'speak'; id: number; text: string; voice: string; speed: number }
  | { type: 'quit' };

const RATE = 24000;
const MAX_TOKENS = 510;

let session: ort.InferenceSession | undefined;
let pack: VoicePack | undefined;
let tokensInput = 'tokens';
let loading: Promise<void> | undefined;
const queue: Extract<Message, { type: 'speak' }>[] = [];
let busy = false;

const send = (m: object) => process.send?.(m);

process.on('message', (m: Message) => {
  switch (m.type) {
    case 'init':
      loading ??= load(m).catch((err) => {
        loading = undefined;
        send({ type: 'error', message: `Kokoro couldn't load: ${(err as Error).message}` });
      });
      break;
    case 'speak':
      queue.push(m);
      void next();
      break;
    case 'quit':
      process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0)); // rawi went away

async function load(m: Extract<Message, { type: 'init' }>): Promise<void> {
  const t0 = Date.now();
  pack = new VoicePack(fs.readFileSync(m.voices));
  session = await ort.InferenceSession.create(m.model, {
    executionProviders: ['cpu'],
    intraOpNumThreads: m.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  tokensInput = session.inputNames.includes('input_ids') ? 'input_ids' : 'tokens';
  send({ type: 'ready', ms: Date.now() - t0, voices: pack.names().filter(englishVoice) });
}

async function next(): Promise<void> {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    await loading;
    if (!session || !pack) throw new Error('Kokoro is not loaded.');
    const t0 = Date.now();
    const pcm = await speak(job.text, job.voice, job.speed);
    send({ type: 'audio', id: job.id, pcm, ms: Date.now() - t0 });
  } catch (err) {
    send({ type: 'error', id: job.id, message: (err as Error).message });
  } finally {
    busy = false;
    void next();
  }
}

async function speak(text: string, voice: string, speed: number): Promise<Buffer> {
  if (!pack!.has(voice)) throw new Error(`Kokoro has no voice named ${voice}.`);
  const phonemes = await phonemize(text, voice.startsWith('b'));
  const parts: Float32Array[] = [];
  for (const chunk of splitPhonemes(phonemes)) {
    const tokens = [...chunk].map((c) => VOCAB[c]).filter((t): t is number => t !== undefined);
    if (!tokens.length) continue;
    const ids = new BigInt64Array(tokens.length + 2); // 0 ... 0 around the text
    tokens.forEach((t, i) => (ids[i + 1] = BigInt(t)));
    const out = await session!.run({
      [tokensInput]: new ort.Tensor('int64', ids, [1, ids.length]),
      style: new ort.Tensor('float32', pack!.style(voice, tokens.length), [1, 256]),
      speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
    });
    parts.push(out.audio.data as Float32Array);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = Buffer.alloc(total * 2);
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++, o += 2) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, p[i])) * 32767), o);
  }
  return pcm;
}

/** Kokoro takes at most 510 phonemes per run: longer text is cut at punctuation, else at a space. */
function splitPhonemes(ps: string): string[] {
  const out: string[] = [];
  let rest = ps;
  while (rest.length > MAX_TOKENS) {
    let cut = Math.max(...['.', '!', '?', ';', ':', ','].map((p) => rest.lastIndexOf(p, MAX_TOKENS - 1)));
    if (cut < MAX_TOKENS / 3) cut = rest.lastIndexOf(' ', MAX_TOKENS - 1);
    if (cut <= 0) cut = MAX_TOKENS - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export { RATE };
