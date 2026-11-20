import * as fs from 'fs';
import * as path from 'path';
import { Logger, errorText } from '../util/log';
import { ParseEvent, ReadWhich, SessionParser } from './parser';

/**
 * Follows Claude Code's session files (`<projects>/<folder>/<session>.jsonl`) and reports finished
 * replies, new prompts and session titles. Works for Claude Code in the VS Code panel and in a
 * terminal alike, with no hook to install.
 *
 * - Change notifications come from `fs.watch`, with a poll as a safety net.
 * - At start-up, the most recent sessions' tails are read so earlier replies can be replayed.
 *   They're marked `history` and are never read aloud automatically.
 * - Only replies written in the last two minutes count as live, so a resumed or rewritten session
 *   never has its old replies read out.
 */

export interface WatchedReply {
  /** `<session>:<message id>` */
  id: string;
  sessionId: string;
  cwd: string;
  title: string;
  text: string;
  /** When Claude wrote it (epoch ms). */
  at: number;
  /** Found at start-up or too old to be live: list it, never read it automatically. */
  history: boolean;
  /** The user sent a new prompt before rawi had a chance to read it. */
  interrupted: boolean;
}

export interface WatcherOptions {
  projectsDir: string;
  /** Cheap filter on a project folder's name, which encodes the session's working folder. */
  wantDir(dirName: string): boolean;
  /** The real check, once the session's working folder is known. */
  wantCwd(cwd: string): boolean;
  which: () => ReadWhich;
  log: Logger;
  onReply(reply: WatchedReply): void;
  /**
   * Claude starts a new turn. `at`: the prompt's time stamp, when the session file has one. `byUser`: false
   * when Claude Code sent the prompt itself (a background task finished, or the conversation was compacted).
   */
  onPrompt(sessionId: string, cwd: string, at: string | undefined, byUser: boolean): void;
  onTitle(sessionId: string, title: string): void;
  settleMs?: number;
  historyFiles?: number;
  historyBytes?: number;
  pollMs?: number;
  liveWindowMs?: number;
}

interface Followed {
  file: string;
  sessionId: string;
  offset: number;
  partial: Buffer;
  parser: SessionParser;
  wanted?: boolean;
  timer?: NodeJS.Timeout;
  reading: boolean;
  again: boolean;
}

const NEWLINE = 0x0a;

export class TranscriptWatcher {
  private readonly files = new Map<string, Followed>();
  private fsWatcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private stopped = false;
  private readonly settleMs: number;
  private readonly liveWindowMs: number;

  constructor(private readonly o: WatcherOptions) {
    // The final message's text is its last line in 985 of 991 real turns, so a short wait is enough.
    this.settleMs = o.settleMs ?? 150;
    this.liveWindowMs = o.liveWindowMs ?? 2 * 60_000;
  }

  async start(): Promise<void> {
    try {
      await this.loadHistory();
    } catch (err) {
      this.o.log.warn(`Couldn't read earlier replies: ${errorText(err)}`);
    }
    // Stopped while it was starting (the folders or rawi.scope changed): its replacement does the work.
    if (this.stopped) return;
    this.watch();
    this.poll = setInterval(() => void this.scan(), this.o.pollMs ?? 2000);
  }

  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    if (this.poll) clearInterval(this.poll);
    for (const f of this.files.values()) if (f.timer) clearTimeout(f.timer);
  }

  private watch(): void {
    if (this.fsWatcher || !fs.existsSync(this.o.projectsDir)) return;
    try {
      this.fsWatcher = fs.watch(this.o.projectsDir, { recursive: true }, (_event, name) => {
        if (name) this.changed(String(name));
      });
      this.fsWatcher.on('error', (err) => {
        this.o.log.warn(`File watching stopped (${errorText(err)}); polling only.`);
        this.fsWatcher?.close();
        this.fsWatcher = undefined;
      });
    } catch (err) {
      this.o.log.warn(`Can't watch ${this.o.projectsDir} (${errorText(err)}); polling only.`);
    }
  }

  /** A path relative to the projects folder changed. Only `<folder>/<session>.jsonl` counts. */
  private changed(rel: string): void {
    const parts = rel.split(/[\\/]/);
    if (parts.length !== 2 || !parts[1].endsWith('.jsonl') || !this.o.wantDir(parts[0])) return;
    const file = path.join(this.o.projectsDir, rel);
    const f = this.files.get(file) ?? this.follow(file, 0);
    void this.read(f);
  }

  private follow(file: string, offset: number, parser?: SessionParser): Followed {
    const f: Followed = {
      file,
      sessionId: path.basename(file, '.jsonl'),
      offset,
      partial: Buffer.alloc(0),
      parser: parser ?? new SessionParser(this.o.which),
      reading: false,
      again: false,
    };
    this.files.set(file, f);
    return f;
  }

  private async listSessions(): Promise<{ file: string; size: number; mtime: number }[]> {
    let dirs: fs.Dirent[];
    try {
      dirs = await fs.promises.readdir(this.o.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: { file: string; size: number; mtime: number }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory() || !this.o.wantDir(d.name)) continue;
      const dir = path.join(this.o.projectsDir, d.name);
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          const st = await fs.promises.stat(path.join(dir, name));
          out.push({ file: path.join(dir, name), size: st.size, mtime: st.mtimeMs });
        } catch {
          // deleted meanwhile
        }
      }
    }
    return out;
  }

  /** Start-up: follow every session from its end, after reading the tails of the latest ones. */
  private async loadHistory(): Promise<void> {
    const sessions = (await this.listSessions()).sort((a, b) => b.mtime - a.mtime);
    const recent = new Set(sessions.slice(0, this.o.historyFiles ?? 8).map((s) => s.file));
    for (const s of sessions) {
      const f = this.follow(s.file, s.size);
      if (!recent.has(s.file)) continue;
      const tail = this.o.historyBytes ?? 2 * 1024 * 1024;
      const start = Math.max(0, s.size - tail);
      const buf = Buffer.alloc(s.size - start);
      const fh = await fs.promises.open(s.file, 'r');
      try {
        await fh.read(buf, 0, buf.length, start);
      } finally {
        await fh.close();
      }
      let from = 0;
      if (start > 0) from = buf.indexOf(NEWLINE) + 1; // skip the cut first line
      const end = buf.lastIndexOf(NEWLINE) + 1;
      for (const line of buf.subarray(from, end).toString('utf8').split('\n')) {
        this.handleLine(f, line, true);
      }
      const last = f.parser.flush();
      if (last && f.wanted !== false) this.emit(f, last, true, false);
    }
    this.o.log.info(`Following ${this.files.size} session file(s); earlier replies read from ${recent.size}.`);
  }

  /** Safety net for missed notifications, new folders and the projects folder appearing later. */
  private async scan(): Promise<void> {
    if (this.stopped) return;
    this.watch();
    for (const s of await this.listSessions()) {
      const f = this.files.get(s.file) ?? this.follow(s.file, 0);
      if (s.size > f.offset) void this.read(f);
      else if (s.size < f.offset) {
        f.offset = s.size; // rewritten: don't read it again from the start
        f.partial = Buffer.alloc(0);
      }
    }
  }

  private async read(f: Followed): Promise<void> {
    if (f.reading) {
      f.again = true;
      return;
    }
    f.reading = true;
    try {
      do {
        f.again = false;
        const fh = await fs.promises.open(f.file, 'r');
        let chunk: Buffer;
        try {
          const { size } = await fh.stat();
          if (size < f.offset) {
            f.offset = size;
            f.partial = Buffer.alloc(0);
            continue;
          }
          chunk = Buffer.alloc(size - f.offset);
          const { bytesRead } = await fh.read(chunk, 0, chunk.length, f.offset);
          chunk = chunk.subarray(0, bytesRead);
          f.offset += bytesRead;
        } finally {
          await fh.close();
        }
        const data = f.partial.length ? Buffer.concat([f.partial, chunk]) : chunk;
        const end = data.lastIndexOf(NEWLINE) + 1; // a line still being written waits for the next read
        f.partial = Buffer.from(data.subarray(end));
        if (end > 0) {
          for (const line of data.subarray(0, end).toString('utf8').split('\n')) this.handleLine(f, line, false);
        }
        if (f.parser.waiting) this.settle(f);
      } while (f.again && !this.stopped);
    } catch (err) {
      this.o.log.warn(`Couldn't read ${path.basename(f.file)}: ${errorText(err)}`);
    } finally {
      f.reading = false;
    }
  }

  private handleLine(f: Followed, line: string, history: boolean): void {
    if (this.stopped || !line.trim()) return; // a stopped watcher reports nothing, not even what it was reading
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const events: ParseEvent[] = f.parser.feed(entry);
    if (f.wanted === undefined && f.parser.cwd) f.wanted = this.o.wantCwd(f.parser.cwd);
    if (f.wanted === false) return;
    for (const ev of events) {
      if (ev.kind === 'title') this.o.onTitle(f.sessionId, ev.title);
      else if (ev.kind === 'reply') this.emit(f, ev.reply, history, ev.interrupted);
      else if (!history && this.isLive(ev.at)) this.o.onPrompt(f.sessionId, f.parser.cwd, ev.at, ev.byUser);
    }
  }

  private settle(f: Followed): void {
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      f.timer = undefined;
      const reply = f.parser.flush();
      if (reply && f.wanted !== false) this.emit(f, reply, false, false);
    }, this.settleMs);
  }

  private isLive(at: string | undefined): boolean {
    if (!at) return true;
    const t = Date.parse(at);
    return Number.isNaN(t) || Date.now() - t <= this.liveWindowMs;
  }

  private emit(f: Followed, r: { messageId: string; text: string; at?: string }, history: boolean, interrupted: boolean): void {
    if (this.stopped) return;
    const at = r.at ? Date.parse(r.at) : NaN;
    this.o.onReply({
      id: `${f.sessionId}:${r.messageId}`,
      sessionId: f.sessionId,
      cwd: f.parser.cwd,
      title: f.parser.title,
      text: r.text,
      at: Number.isNaN(at) ? Date.now() : at,
      history: history || !this.isLive(r.at),
      interrupted,
    });
  }
}

/** Claude Code names a session's project folder after its working folder, every other character as `-`. */
export function projectDirName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Filters for sessions working in (or under) one of these folders. */
export function folderFilters(folders: string[]): { wantDir(dir: string): boolean; wantCwd(cwd: string): boolean } {
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const norm = (p: string) => {
    const r = path.resolve(p);
    return caseless ? r.toLowerCase() : r;
  };
  const roots = folders.map(norm);
  const prefixes = folders.map((f) => projectDirName(f).toLowerCase());
  return {
    wantDir: (dir) => {
      const d = dir.toLowerCase();
      return prefixes.some((p) => d === p || d.startsWith(p + '-'));
    },
    wantCwd: (cwd) => {
      const c = norm(cwd);
      return roots.some((r) => c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
    },
  };
}
