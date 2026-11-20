import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One voice for all VS Code windows. Each window runs its own rawi, with its own player and status
 * bar: without this, two windows could read at once, and one window's button and Stop key knew
 * nothing of another window's reading.
 *
 * The window that reads owns `voice.json`, in a folder all windows share. It is created
 * exclusively, so only one window can own it; the owner keeps it up to date, so the others can show
 * what it reads; and it is deleted when the owner is done. Another window asks the owner to stop,
 * pause or skip by writing `command.json`. An owner whose process is gone, or which stopped
 * refreshing the file, no longer counts.
 */

/** What a window is reading, as the other windows see it. */
export interface Reading {
  title: string;
  kind: 'loading' | 'playing' | 'paused';
  index: number;
  count: number;
}

export type VoiceCommand = 'stop' | 'pauseResume' | 'skipForward' | 'skipBack';

interface VoiceFile extends Reading {
  owner: string;
  pid: number;
  /** When the owner last wrote the file (ms since epoch). */
  t: number;
}

interface CommandFile {
  to: string;
  id: string;
  command: VoiceCommand;
}

export interface SharedVoiceOptions {
  dir: string;
  /** Another window asks this one to stop, pause or resume, or skip. */
  onCommand(command: VoiceCommand): void;
  /** Another window started reading, moved on, paused, or stopped. */
  onRemoteChange(): void;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  pollMs?: number;
}

/** An owner that hasn't refreshed the file for this long is gone (it refreshes every 5 s). */
export const STALE_MS = 15_000;
const HEARTBEAT_MS = 5_000;
/** How long another window gets to stop before this one takes the voice anyway. */
const TAKEOVER_MS = 2_000;

export class SharedVoice {
  readonly id = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  private readonly voiceFile: string;
  private readonly commandFile: string;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private owned = false;
  private reading?: Reading;
  private lastRemote = '';
  private lastCommand = '';
  private poll?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;

  constructor(private readonly o: SharedVoiceOptions) {
    this.voiceFile = path.join(o.dir, 'voice.json');
    this.commandFile = path.join(o.dir, 'command.json');
    this.now = o.now ?? Date.now;
    this.isAlive = o.isAlive ?? processAlive;
  }

  /** Follows the shared folder: commands for this window, and other windows' reading. */
  start(): void {
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
      this.watcher = fs.watch(this.o.dir, () => this.check());
      this.watcher.on('error', () => undefined); // the poll below still runs
    } catch {
      // no watching: polling alone
    }
    this.poll = setInterval(() => this.check(), this.o.pollMs ?? 500);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    this.release();
  }

  /** Whether this window holds the voice. */
  get mine(): boolean {
    return this.owned;
  }

  /** What another window is reading, if one is. */
  remote(): Reading | undefined {
    const v = this.readVoice();
    if (!v || v.owner === this.id || !this.live(v)) return undefined;
    return { title: v.title, kind: v.kind, index: v.index, count: v.count };
  }

  /** Takes the voice if no other window holds it; false while one reads. */
  tryClaim(reading: Reading): boolean {
    if (this.owned) return this.update(reading);
    try {
      fs.mkdirSync(this.o.dir, { recursive: true });
    } catch {
      return true; // the folder is unusable: never block reading
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.voiceFile, this.serialize(reading), { flag: 'wx' });
        this.own(reading);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true; // can't write there: never block reading
        const v = this.readVoice();
        if (v && v.owner !== this.id && this.live(v)) return false;
        this.removeIfStill(v); // left by a window that's gone, or unreadable: take its place
      }
    }
    return false;
  }

  /**
   * Makes this window the one that speaks. `takeOver` stops another window's reading (something the
   * user just asked for, or rawi.whenBusy "interrupt"); otherwise this waits for it to end. Resolves
   * false when `cancelled()` becomes true while waiting.
   */
  async acquire(reading: Reading, takeOver: boolean, cancelled: () => boolean): Promise<boolean> {
    let askedAt = 0;
    for (;;) {
      if (cancelled()) return false;
      if (this.tryClaim(reading)) return true;
      if (takeOver) {
        if (!askedAt) {
          this.send('stop');
          askedAt = this.now();
        } else if (this.now() - askedAt > TAKEOVER_MS) {
          this.removeIfStill(this.readVoice()); // it didn't let go in time: take the voice anyway
          continue;
        }
      }
      await delay(takeOver ? 100 : 250);
    }
  }

  /** Shows the other windows what this one reads now. False when this window doesn't hold the voice. */
  update(reading: Reading): boolean {
    if (!this.owned) return false;
    this.reading = reading;
    this.write();
    return this.owned;
  }

  /** This window has stopped reading: the voice is free. */
  release(): void {
    if (!this.owned) return;
    this.owned = false;
    this.reading = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const v = this.readVoice();
    if (v?.owner === this.id) this.removeIfStill(v);
  }

  /** Asks the window that reads to stop, pause or skip. False when no other window reads. */
  send(command: VoiceCommand): boolean {
    const v = this.readVoice();
    if (!v || v.owner === this.id || !this.live(v)) return false;
    const message: CommandFile = { to: v.owner, id: crypto.randomBytes(6).toString('hex'), command };
    try {
      fs.writeFileSync(this.commandFile, JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Runs a command sent to this window, and tells when another window's reading changed. */
  check(): void {
    const cmd = readJson<CommandFile>(this.commandFile);
    if (cmd && cmd.to === this.id && cmd.id !== this.lastCommand) {
      this.lastCommand = cmd.id;
      try {
        fs.unlinkSync(this.commandFile);
      } catch {
        // already gone
      }
      this.o.onCommand(cmd.command);
    }
    const r = this.remote();
    const key = r ? JSON.stringify(r) : '';
    if (key !== this.lastRemote) {
      this.lastRemote = key;
      this.o.onRemoteChange();
    }
  }

  // ---- internals ----

  private own(reading: Reading): void {
    this.owned = true;
    this.reading = reading;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
  }

  /** Rewrites the file, unless another window has taken the voice: then this one stops. */
  private write(): void {
    if (!this.owned || !this.reading) return;
    const v = this.readVoice();
    if (v && v.owner !== this.id) {
      this.lostVoice();
      return;
    }
    try {
      fs.writeFileSync(this.voiceFile, this.serialize(this.reading), v ? undefined : { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') this.lostVoice(); // taken while it was missing
    }
  }

  private lostVoice(): void {
    this.owned = false;
    this.reading = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.o.onCommand('stop');
  }

  private live(v: VoiceFile): boolean {
    return this.now() - v.t < STALE_MS && this.isAlive(v.pid);
  }

  private serialize(reading: Reading): string {
    const v: VoiceFile = { ...reading, owner: this.id, pid: process.pid, t: this.now() };
    return JSON.stringify(v);
  }

  private readVoice(): VoiceFile | undefined {
    const v = readJson<VoiceFile>(this.voiceFile);
    return v && typeof v.owner === 'string' && typeof v.pid === 'number' && typeof v.t === 'number' ? v : undefined;
  }

  /**
   * Deletes the file if it still holds what was read: never a newer owner's, nor one another window
   * is writing this moment (unreadable but new). An unreadable file older than 2 s is a leftover.
   */
  private removeIfStill(seen: VoiceFile | undefined): void {
    const now = this.readVoice();
    if (now) {
      if (!seen || now.owner !== seen.owner || now.t !== seen.t) return;
    } else {
      try {
        if (Date.now() - fs.statSync(this.voiceFile).mtimeMs < 2000) return;
      } catch {
        return; // already gone
      }
    }
    try {
      fs.unlinkSync(this.voiceFile);
    } catch {
      // already gone
    }
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined; // missing, or half written: the next look reads it
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
