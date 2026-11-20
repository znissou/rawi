import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptWatcher, WatchedReply, folderFilters, projectDirName } from '../src/claude/watcher';
import { silentLogger } from '../src/util/log';
import { assistant, jsonl, notification, prompt, text, think, title } from './fixtures';

const CWD = 'C:\\work\\demo';
let tmp: string;
let watcher: TranscriptWatcher | undefined;

function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rawi-watch-'));
  const dir = path.join(tmp, projectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const replies: WatchedReply[] = [];
  const prompts: string[] = [];
  watcher = new TranscriptWatcher({
    projectsDir: tmp,
    wantDir: (d) => d === projectDirName(CWD),
    wantCwd: (c) => c === CWD,
    which: () => 'final',
    log: silentLogger,
    onReply: (r) => replies.push(r),
    onPrompt: (s, _cwd, _at, byUser) => prompts.push(byUser ? s : `${s}, sent by Claude Code`),
    onTitle: () => undefined,
    settleMs: 50,
    pollMs: 100,
  });
  return { dir, replies, prompts };
}

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('TranscriptWatcher', () => {
  it('lists earlier replies as history and reads new ones live', async () => {
    const { dir, replies, prompts } = setup();
    const file = path.join(dir, 'sess-1.jsonl');
    const old = '2026-01-01T10:00:00.000Z';
    fs.writeFileSync(file, jsonl([title('Old work'), prompt('q', CWD, old), assistant('m1', [text('Earlier answer.')], 'end_turn', { at: old })]));
    await watcher!.start();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: 'Earlier answer.', history: true, title: 'Old work', sessionId: 'sess-1' });

    fs.appendFileSync(file, jsonl([prompt('next'), assistant('m2', [think(), text('New answer.')], 'end_turn')]));
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });
    expect(replies[1]).toMatchObject({ text: 'New answer.', history: false, interrupted: false, id: 'sess-1:m2' });
    expect(prompts).toEqual(['sess-1']);
  });

  it('follows a session created after start-up, but never reads old replies aloud', async () => {
    const { dir, replies } = setup();
    await watcher!.start();
    const old = '2026-01-01T10:00:00.000Z';
    fs.writeFileSync(path.join(dir, 'resumed.jsonl'), jsonl([prompt('q', CWD, old), assistant('m1', [text('Copied old answer.')], 'end_turn', { at: old })]));
    fs.writeFileSync(path.join(dir, 'fresh.jsonl'), jsonl([prompt('q'), assistant('m9', [text('Fresh answer.')], 'end_turn')]));
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 3000 });
    const byText = Object.fromEntries(replies.map((r) => [r.text, r.history]));
    expect(byText).toEqual({ 'Copied old answer.': true, 'Fresh answer.': false });
  });

  it('waits for a line that is still being written', async () => {
    const { dir, replies } = setup();
    const file = path.join(dir, 'sess-2.jsonl');
    fs.writeFileSync(file, '');
    await watcher!.start();
    const line = JSON.stringify(assistant('m1', [text('Split across writes.')], 'end_turn'));
    fs.appendFileSync(file, jsonl([prompt('q')]) + line.slice(0, 40));
    await new Promise((r) => setTimeout(r, 300));
    expect(replies).toHaveLength(0);
    fs.appendFileSync(file, line.slice(40) + '\n');
    await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(['Split across writes.']), { timeout: 3000 });
  });

  it('reads a reply that Claude Code\'s own prompt follows at once, and says who sent each prompt', async () => {
    const { dir, replies, prompts } = setup();
    const file = path.join(dir, 'sess-3.jsonl');
    fs.writeFileSync(file, '');
    await watcher!.start();
    // Written together: a background task finished just as Claude ended its turn.
    fs.appendFileSync(file, jsonl([
      prompt('run the tests'), assistant('m1', [text('The tests are running.')], 'end_turn'),
      notification(), assistant('m2', [text('All the tests pass.')], 'end_turn'),
    ]));
    await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(['The tests are running.', 'All the tests pass.']), { timeout: 3000 });
    expect(replies.map((r) => r.interrupted)).toEqual([false, false]);
    expect(prompts).toEqual(['sess-3', 'sess-3, sent by Claude Code']);
  });

  it('stays stopped when stopped while it was starting', async () => {
    const { dir, replies, prompts } = setup();
    const file = path.join(dir, 'sess-4.jsonl');
    const old = '2026-01-01T10:00:00.000Z';
    fs.writeFileSync(file, jsonl([prompt('q', CWD, old), assistant('m1', [text('Earlier answer.')], 'end_turn', { at: old })]));
    const starting = watcher!.start();
    watcher!.stop(); // rawi.scope or the folders changed right away: a new watcher takes over
    await starting;
    fs.appendFileSync(file, jsonl([prompt('next'), assistant('m2', [text('New answer.')], 'end_turn')]));
    await new Promise((r) => setTimeout(r, 500));
    expect(replies).toEqual([]); // not even the earlier reply, in a list cleared for the new watcher
    expect(prompts).toEqual([]);
  });

  it('ignores sessions working in another folder', async () => {
    const { dir, replies } = setup();
    await watcher!.start();
    fs.writeFileSync(path.join(dir, 'other.jsonl'), jsonl([prompt('q', 'C:\\work\\demo-old'), assistant('m1', [text('Not ours.')], 'end_turn', { cwd: 'C:\\work\\demo-old' })]));
    await new Promise((r) => setTimeout(r, 500));
    expect(replies).toHaveLength(0);
  });
});

describe('folder filters', () => {
  it('matches Claude Code project folder names and working folders', () => {
    expect(projectDirName('c:\\Users\\sam\\Documents\\Projects\\rawi')).toBe('c--Users-sam-Documents-Projects-rawi');
    const f = folderFilters(['C:\\Users\\sam\\Documents\\Projects\\rawi']);
    expect(f.wantDir('c--Users-sam-Documents-Projects-rawi')).toBe(true);
    expect(f.wantDir('c--Users-sam-Documents-Projects-rawi-spikes')).toBe(true); // a subfolder, maybe
    expect(f.wantDir('c--Users-sam-Documents-Projects-other')).toBe(false);
    if (process.platform === 'win32') {
      expect(f.wantCwd('c:\\Users\\sam\\Documents\\Projects\\rawi')).toBe(true);
      expect(f.wantCwd('C:\\Users\\sam\\Documents\\Projects\\rawi\\spikes')).toBe(true);
      expect(f.wantCwd('C:\\Users\\sam\\Documents\\Projects\\rawi-old')).toBe(false);
    }
  });
});
