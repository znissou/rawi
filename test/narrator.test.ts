import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { AudioFormat, Narrator, NarratorState, ReadItem, SpeechSource } from '../src/audio/narrator';
import { Player } from '../src/audio/player';
import { defaultSpeakOptions } from '../src/text/speakable';
import { silentLogger } from '../src/util/log';

class FakePlayer implements Player {
  streaming = true;
  log: string[] = [];
  warmUp() {}
  prepare(rate: number) { this.log.push(`prepare ${rate}`); }
  queue(id: string) { this.log.push(`queue ${id}`); }
  pause() { this.log.push('pause'); }
  resume() { this.log.push('resume'); }
  stop() { this.log.push('stop'); }
  setVolume() {}
  dispose() {}
  queued() { return this.log.filter((l) => l.startsWith('queue ')).map((l) => l.slice(6)); }
}

const RATE = 24000;
/** 0.5 s of a voiced-like tone (loud enough to count as speech), as 16-bit PCM. */
function tonePcm(seconds = 0.5): Buffer {
  const n = Math.round(RATE * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 180 * i) / RATE)), i * 2);
  return b;
}
const FORMAT: AudioFormat = { rate: RATE, channels: 1 };

/** A voice that sends its audio in a few network-sized pieces (odd sizes included). */
function streamingSource(log: string[] = []): SpeechSource {
  return {
    async stream(text, _item, signal, onAudio) {
      log.push(text);
      const pcm = tonePcm(1);
      for (let o = 0; o < pcm.length && !signal.aborted; o += 4001) {
        onAudio(pcm.subarray(o, o + 4001), FORMAT);
        await new Promise((r) => setTimeout(r, 1));
      }
      return {};
    },
  };
}

const failing = (message = 'no voice'): SpeechSource => ({
  async stream() {
    throw new Error(message);
  },
});

/** A voice that never answers until it is cancelled. */
const silent: SpeechSource = {
  stream: (_t, _i, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
};

function setup(o: { primary?: SpeechSource; backup?: SpeechSource; fallbackAfterMs?: number; streaming?: boolean; onState?: (s: NarratorState) => void } = {}) {
  const player = new FakePlayer();
  player.streaming = o.streaming ?? true;
  const states: NarratorState[] = [];
  const errors: { err: unknown; fellBack: boolean }[] = [];
  const slow: number[] = [];
  const narrator = new Narrator({
    player,
    primary: o.primary ?? streamingSource(),
    backup: () => o.backup,
    fallbackAfterMs: () => o.fallbackAfterMs ?? 0,
    speakOptions: () => defaultSpeakOptions,
    speed: () => 1,
    tempDir: path.join(os.tmpdir(), `rawi-narrator-test-${process.pid}`),
    log: silentLogger,
    onState: (s) => {
      states.push(s);
      o.onState?.(s);
    },
    onError: (err, _item, fellBack) => errors.push({ err, fellBack }),
    onSlowFallback: (_item, ms) => slow.push(ms),
  });
  return { narrator, player, states, errors, slow };
}

const item = (id: string, markdown: string): ReadItem => ({ id, title: id, markdown });
const LONG = 'Done. I added the watcher and the engine to the extension today. ' + 'Here is one more sentence that adds some length to it. '.repeat(10);

/** Plays everything queued so far, and whatever gets queued meanwhile, until the narrator is idle. */
async function playAll(narrator: Narrator, player: FakePlayer) {
  let i = 0;
  for (let guard = 0; guard < 500 && narrator.state.kind !== 'idle'; guard++) {
    const q = player.queued();
    if (i < q.length) {
      narrator.onStarted(q[i]);
      narrator.onEnded(q[i]);
      i++;
    } else {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

describe('Narrator', () => {
  it('plays a part while it is still arriving, in chunks, then goes idle', async () => {
    const { narrator, player } = setup();
    narrator.read(item('r1', LONG), 'queue');
    expect(player.log[0]).toBe('prepare 44100');
    await vi.waitFor(() => expect(player.queued().length).toBeGreaterThanOrEqual(3));
    // the first part arrives as several chunks: :0.0, :0.1, ...
    expect(player.queued().filter((k) => k.includes(':0.')).length).toBeGreaterThan(1);
    narrator.onStarted(player.queued()[0]);
    expect(narrator.state).toMatchObject({ kind: 'playing', index: 0, backup: false });
    await playAll(narrator, player);
    expect(narrator.state.kind).toBe('idle');
  });

  it('fetches each part once', async () => {
    const texts: string[] = [];
    const { narrator, player } = setup({ primary: streamingSource(texts) });
    narrator.read(item('r1', LONG), 'queue');
    await playAll(narrator, player);
    expect(texts.length).toBeGreaterThan(1);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('hands a whole part at once to players that cannot stream', async () => {
    const { narrator, player } = setup({ streaming: false });
    narrator.read(item('r1', 'Hello there. This is a short reply.'), 'queue');
    await vi.waitFor(() => expect(player.queued().length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(player.queued().every((k) => k.endsWith('.0'))).toBe(true);
  });

  it('waits its turn when another reply is being read, unless told to interrupt', async () => {
    const { narrator, player } = setup();
    narrator.read(item('r1', 'First reply.'), 'queue');
    narrator.read(item('r2', 'Second reply.'), 'queue');
    expect(narrator.currentId).toBe('r1');
    await playAll(narrator, player);
    expect(player.queued().some((k) => k.includes(':0.'))).toBe(true);
    narrator.read(item('r3', 'Third reply.'), 'queue');
    narrator.read(item('r4', 'Fourth reply.'), 'interrupt');
    expect(narrator.currentId).toBe('r4');
    expect(player.log).toContain('stop');
  });

  it('stops, pauses and skips', async () => {
    const { narrator, player } = setup();
    narrator.read(item('r1', LONG), 'queue');
    await vi.waitFor(() => expect(player.queued().length).toBeGreaterThanOrEqual(2));
    narrator.onStarted(player.queued()[0]);
    expect(narrator.pauseResume()).toBe(true);
    expect(narrator.state.kind).toBe('paused');
    narrator.pauseResume();
    narrator.skipForward();
    // after a skip, chunks are queued again from the next part, under a new generation
    await vi.waitFor(() => expect(player.queued().some((k) => k.includes('.1:1.0'))).toBe(true));
    narrator.onEnded(player.queued()[0]); // a stale event from before the skip is ignored
    expect(narrator.state.kind).not.toBe('idle');
    narrator.stop();
    expect(narrator.state.kind).toBe('idle');
    expect(narrator.pauseResume()).toBe(false);
  });

  it('lets the backup voice read the reply when the main voice fails', async () => {
    const backupTexts: string[] = [];
    const { narrator, player, errors } = setup({ primary: failing('OpenRouter is down'), backup: streamingSource(backupTexts) });
    narrator.read(item('r1', 'Hello there. This is a short reply.'), 'queue');
    await vi.waitFor(() => expect(player.queued().length).toBeGreaterThanOrEqual(1));
    expect(errors).toHaveLength(1);
    expect(errors[0].fellBack).toBe(true);
    expect(backupTexts[0]).toBe('Hello there. This is a short reply.'); // "Hello there." alone is too short a first part
    expect(narrator.state).toMatchObject({ backup: true });
    await playAll(narrator, player);
    expect(backupTexts).toEqual(['Hello there. This is a short reply.']);
  });

  it('lets the backup voice take over when the main voice is too slow', async () => {
    const backupTexts: string[] = [];
    const { narrator, player, slow, errors } = setup({ primary: silent, backup: streamingSource(backupTexts), fallbackAfterMs: 60 });
    narrator.read(item('r1', 'Hello there. This is a short reply.'), 'queue');
    await vi.waitFor(() => expect(player.queued().length).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    expect(slow).toHaveLength(1);
    expect(slow[0]).toBeGreaterThanOrEqual(55);
    expect(errors).toHaveLength(0);
    await playAll(narrator, player);
    expect(backupTexts).toEqual(['Hello there. This is a short reply.']);
  });

  it('reports a failure and moves on when there is no backup voice', async () => {
    const { narrator, errors } = setup({ primary: failing() });
    narrator.read(item('r1', 'Hello there.'), 'queue');
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].fellBack).toBe(false);
    expect(narrator.state.kind).toBe('idle');
  });

  it('asks the voice only for what is worth saying', () => {
    const texts: string[] = [];
    const { narrator } = setup({ primary: streamingSource(texts) });
    narrator.read(item('r1', '```ts\nconst a = 1;\n```'), 'queue');
    expect(texts).toEqual(['TypeScript code, one line.']);
  });

  it('reads a selection from a code file as written, not as Markdown', () => {
    const texts: string[] = [];
    const { narrator } = setup({ primary: streamingSource(texts) });
    narrator.read({ ...item('sel', '    const a = 1;\n    run(a);'), plain: 'code' }, 'queue');
    expect(texts).toEqual(['const a = 1;', 'run(a);']); // as Markdown: "A code block, 2 lines."
  });

  it('resumes without failing when that ends the reading (another window took the voice meanwhile)', async () => {
    let taken = false;
    // What SharedVoice does when it finds the voice taken: it stops this window's reading.
    const s = setup({ onState: (st) => taken && st.kind !== 'idle' && s.narrator.stop() });
    s.narrator.read(item('r1', LONG), 'queue');
    await vi.waitFor(() => expect(s.player.queued().length).toBeGreaterThanOrEqual(1));
    s.narrator.onStarted(s.player.queued()[0]);
    s.narrator.pauseResume();
    taken = true;
    expect(s.narrator.pauseResume()).toBe(true);
    expect(s.narrator.state.kind).toBe('idle');
  });
});
