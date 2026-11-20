import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reading, SharedVoice, SharedVoiceOptions, VoiceCommand } from '../src/audio/sharedVoice';

const reading = (index = 0, kind: Reading['kind'] = 'playing'): Reading => ({ title: 'Login fix', kind, index, count: 4 });
const made: SharedVoice[] = [];

/** One VS Code window's rawi, as far as the shared voice goes. */
function window(dir: string, extra: Partial<SharedVoiceOptions> = {}) {
  const commands: VoiceCommand[] = [];
  const changes = { count: 0 };
  const voice = new SharedVoice({
    dir,
    onCommand: (c) => commands.push(c),
    onRemoteChange: () => changes.count++,
    pollMs: 20,
    ...extra,
  });
  made.push(voice);
  return { voice, commands, changes };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rawi-voice-test-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  while (made.length) made.pop()!.dispose();
});

describe('SharedVoice', () => {
  it('lets one window read at a time, and shows its reading to the others', () => {
    const dir = tempDir();
    const a = window(dir);
    const b = window(dir);
    expect(a.voice.tryClaim(reading())).toBe(true);
    expect(b.voice.tryClaim(reading())).toBe(false);
    expect(b.voice.remote()).toEqual(reading());
    expect(a.voice.remote()).toBeUndefined(); // its own reading isn't "another window"
    a.voice.update(reading(2, 'paused'));
    b.voice.check();
    expect(b.voice.remote()).toEqual(reading(2, 'paused'));
    expect(b.changes.count).toBe(1);
    a.voice.release();
    b.voice.check();
    expect(b.voice.remote()).toBeUndefined();
    expect(b.changes.count).toBe(2);
    expect(b.voice.tryClaim(reading())).toBe(true);
  });

  it('passes stop, pause and skip to the window that reads, once each', () => {
    const dir = tempDir();
    const a = window(dir);
    const b = window(dir);
    expect(b.voice.send('pauseResume')).toBe(false); // nobody reads
    a.voice.tryClaim(reading());
    expect(b.voice.send('pauseResume')).toBe(true);
    b.voice.check();
    expect(b.commands).toEqual([]);
    a.voice.check();
    a.voice.check();
    expect(a.commands).toEqual(['pauseResume']);
    expect(a.voice.send('stop')).toBe(false); // not to itself
  });

  it('takes the voice over when the user asks: the other window is told to stop', async () => {
    const dir = tempDir();
    const a = window(dir, { onCommand: (c) => c === 'stop' && a.voice.release() });
    const b = window(dir);
    a.voice.tryClaim(reading());
    a.voice.start(); // follows the folder, as a window does
    expect(await b.voice.acquire(reading(), true, () => false)).toBe(true);
    expect(b.voice.mine).toBe(true);
    expect(a.voice.mine).toBe(false);
  });

  it('takes the voice after 2 s from a window that doesn\'t let go, which then stops', async () => {
    const dir = tempDir();
    const a = window(dir); // ignores the request to stop
    const b = window(dir);
    a.voice.tryClaim(reading());
    const started = Date.now();
    expect(await b.voice.acquire(reading(), true, () => false)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    a.voice.update(reading(1)); // its next update finds the voice taken
    expect(a.voice.mine).toBe(false);
    expect(a.commands).toEqual(['stop']);
    expect(b.voice.mine).toBe(true);
  }, 10_000);

  it('queues behind another window\'s reading, and can be called off', async () => {
    const dir = tempDir();
    const a = window(dir);
    const b = window(dir);
    const c = window(dir);
    a.voice.tryClaim(reading());
    let calledOff = false;
    const bGot = b.voice.acquire(reading(), false, () => calledOff);
    const cGot = c.voice.acquire(reading(), false, () => calledOff);
    await sleep(300);
    expect(b.voice.mine || c.voice.mine).toBe(false); // both wait
    a.voice.release();
    await sleep(600);
    expect(Number(b.voice.mine) + Number(c.voice.mine)).toBe(1); // one of them, never both
    calledOff = true; // the other one gives up
    expect((await Promise.all([bGot, cGot])).filter(Boolean)).toHaveLength(1);
  });

  it('ignores a window that is gone: its process ended, or it stopped refreshing', () => {
    const dir = tempDir();
    const a = window(dir);
    a.voice.tryClaim(reading());
    const dead = window(dir, { isAlive: () => false });
    expect(dead.voice.remote()).toBeUndefined();
    const later = window(dir, { now: () => Date.now() + 20_000 });
    expect(later.voice.remote()).toBeUndefined();
    expect(later.voice.tryClaim(reading())).toBe(true);
  });

  it('takes the place of an unreadable file once it is old, not while it may be being written', () => {
    const dir = tempDir();
    const file = path.join(dir, 'voice.json');
    fs.writeFileSync(file, '');
    const a = window(dir);
    expect(a.voice.tryClaim(reading())).toBe(false); // just created: another window may be writing it
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(file, old, old);
    expect(a.voice.tryClaim(reading())).toBe(true);
  });

  it('never blocks reading when the shared folder is unusable', () => {
    const dir = path.join(tempDir(), 'file-not-folder');
    fs.writeFileSync(dir, 'x');
    const a = window(dir);
    expect(a.voice.tryClaim(reading())).toBe(true);
  });

  it('keeps its file fresh while it reads', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const dir = tempDir();
      let now = Date.now();
      const a = window(dir, { now: () => now });
      a.voice.tryClaim(reading());
      now += 12_000;
      vi.advanceTimersByTime(10_000); // two heartbeats
      const b = window(dir, { now: () => now + 5_000 });
      expect(b.voice.remote()).toEqual(reading()); // 17 s after it started, still fresh
    } finally {
      vi.useRealTimers();
    }
  });
});
