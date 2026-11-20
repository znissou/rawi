import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { Logger, errorText } from '../util/log';

/**
 * Plays rawi's WAV files with what the operating system already has.
 * - Windows: one hidden, long-running PowerShell process (media/win-player.ps1) that keeps a single
 *   waveOut stream: seamless, exact position, instant pause and stop (measured in M0).
 * - macOS: afplay. Linux: pw-play, paplay or aplay. One process per file, paused with SIGSTOP.
 */

export interface PlayerListener {
  started(id: string): void;
  ended(id: string): void;
  error(message: string): void;
}

export interface Player {
  /** Plays files queued back to back without a gap, so audio can be handed over in short chunks. */
  readonly streaming: boolean;
  /** Writes `text` spoken by the operating system's own voice to a WAV file, where there is one. */
  synthesize?(text: string, file: string): Promise<{ voice: string }>;
  /** Windows: asks the system not to slow process `pid` down (power throttling halves Kokoro's speed). */
  fullSpeed?(pid: number): void;
  /** Starts the player process ahead of time (Windows: it takes about half a second). */
  warmUp(): void;
  /** Opens the audio device ahead of time (Windows), so the first sound isn't delayed. */
  prepare(rate: number, channels: number): void;
  queue(id: string, file: string, durationMs: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** 0 to 1 */
  setVolume(volume: number): void;
  dispose(): void;
}

export function createPlayer(extensionPath: string, listener: PlayerListener, log: Logger): Player {
  if (process.platform === 'win32') {
    return new WindowsPlayer(path.join(extensionPath, 'media', 'win-player.ps1'), listener, log);
  }
  return new ProcessPlayer(processCommand(), listener, log);
}

class WindowsPlayer implements Player {
  readonly streaming = true;
  private proc?: ChildProcess;
  private volume = 1;
  private spawnedAt = 0;
  private sayCount = 0;
  private readonly says = new Map<string, { resolve(v: { voice: string }): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  constructor(private readonly script: string, private readonly listener: PlayerListener, private readonly log: Logger) {}

  synthesize(text: string, file: string): Promise<{ voice: string }> {
    const id = `v${++this.sayCount}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.says.delete(id);
        reject(new Error('The Windows voice took too long.'));
      }, 20_000);
      this.says.set(id, { resolve, reject, timer });
      this.send(`say ${id} ${Buffer.from(text, 'utf8').toString('base64')} ${file}`);
    });
  }

  fullSpeed(pid: number): void {
    this.send(`fullspeed ${pid}`);
  }

  /** Starts the helper early: it takes about half a second to be ready. */
  warmUp(): void {
    this.ensure();
  }

  prepare(rate: number, channels: number): void {
    this.send(`prepare ${rate} ${channels}`);
  }

  queue(id: string, file: string): void {
    this.send(`queue ${id} ${file}`);
  }

  pause(): void {
    this.send('pause');
  }

  resume(): void {
    this.send('resume');
  }

  stop(): void {
    if (this.proc) this.send('stop');
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.proc) this.send(`volume ${volume.toFixed(3)}`);
  }

  dispose(): void {
    const p = this.proc;
    this.proc = undefined;
    if (!p) return;
    try {
      p.stdin?.write('quit\n');
      p.stdin?.end();
    } catch {
      // already gone
    }
    setTimeout(() => p.kill(), 1000).unref();
  }

  private send(line: string): void {
    const p = this.ensure();
    p.stdin?.write(line + '\n');
  }

  private ensure(): ChildProcess {
    if (this.proc) return this.proc;
    this.spawnedAt = Date.now();
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = p;
    readline.createInterface({ input: p.stdout! }).on('line', (line) => this.onLine(line));
    p.stderr?.on('data', (d: Buffer) => this.log.warn(`player: ${d.toString().trim()}`));
    p.on('error', (err) => {
      this.log.error('The audio player could not start', err);
      this.listener.error(`The audio player could not start: ${errorText(err)}`);
      if (this.proc === p) this.proc = undefined;
    });
    p.on('exit', (code) => {
      if (this.proc !== p) return; // stopped by rawi
      this.proc = undefined;
      this.log.warn(`The audio player exited (code ${code}); it restarts when needed.`);
      // What it was playing or making is lost: say so, or the reading waits for ever for it to end.
      const err = new Error('The audio player stopped.');
      for (const s of this.says.values()) {
        clearTimeout(s.timer);
        s.reject(err);
      }
      this.says.clear();
      this.listener.error(`The audio player stopped (code ${code}).`);
    });
    if (this.volume !== 1) p.stdin?.write(`volume ${this.volume.toFixed(3)}\n`);
    return p;
  }

  private onLine(line: string): void {
    const [kind, id] = line.split(' ');
    if (kind === 'said' || kind === 'sayerror') {
      const waiting = this.says.get(id);
      if (!waiting) return;
      this.says.delete(id);
      clearTimeout(waiting.timer);
      const rest = line.split(' ').slice(2).join(' ');
      if (kind === 'said') waiting.resolve({ voice: rest.replace(/_/g, ' ') });
      else waiting.reject(new Error(`The Windows voice failed: ${rest}`));
      return;
    }
    switch (kind) {
      case 'ready':
        this.log.info(`Audio player ready in ${Date.now() - this.spawnedAt} ms.`);
        break;
      case 'fullspeed': {
        const result = line.split(' ').slice(2).join(' ');
        if (result === 'ok') this.log.info(`Process ${id} opted out of Windows power throttling.`);
        else this.log.warn(`Process ${id} may run slower: ${result}`);
        break;
      }
      case 'started':
        this.listener.started(id);
        break;
      case 'ended':
        this.listener.ended(id);
        break;
      case 'error':
        this.log.warn(`player: ${line.slice(6)}`);
        this.listener.error(line.slice(6));
        break;
      default:
        break; // paused, resumed, stopped: rawi already knows
    }
  }
}

type Command = (file: string, volume: number) => [string, string[]];

function processCommand(): Command {
  if (process.platform === 'darwin') return (file, volume) => ['afplay', ['-v', volume.toFixed(2), file]];
  const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
  if (has('pw-play')) return (file, volume) => ['pw-play', [`--volume=${volume.toFixed(2)}`, file]];
  if (has('paplay')) return (file, volume) => ['paplay', [`--volume=${Math.round(volume * 65536)}`, file]];
  return (file) => ['aplay', ['-q', file]];
}

/** One player process per file, played in order. Not yet tested on macOS and Linux. */
class ProcessPlayer implements Player {
  readonly streaming = false; // a new process per chunk would leave gaps: whole parts only
  private items: { id: string; file: string }[] = [];
  private current?: { id: string; proc: ChildProcess; stopped: boolean };
  private paused = false;
  private volume = 1;

  constructor(private readonly command: Command, private readonly listener: PlayerListener, private readonly log: Logger) {}

  warmUp(): void {}

  prepare(): void {}

  queue(id: string, file: string): void {
    this.items.push({ id, file });
    if (!this.current) this.next();
  }

  pause(): void {
    this.paused = true;
    this.current?.proc.kill('SIGSTOP');
  }

  resume(): void {
    this.paused = false;
    this.current?.proc.kill('SIGCONT');
  }

  stop(): void {
    this.items = [];
    const c = this.current;
    this.current = undefined;
    if (c) {
      c.stopped = true;
      if (this.paused) c.proc.kill('SIGCONT');
      c.proc.kill('SIGTERM');
    }
    this.paused = false;
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }

  dispose(): void {
    this.stop();
  }

  private next(): void {
    const item = this.items.shift();
    if (!item) return;
    const [cmd, args] = this.command(item.file, this.volume);
    const proc = spawn(cmd, args, { stdio: 'ignore' });
    const entry = { id: item.id, proc, stopped: false };
    this.current = entry;
    proc.on('error', (err) => {
      this.log.error(`Can't play audio with ${cmd}`, err);
      this.listener.error(`Can't play audio with ${cmd}: ${errorText(err)}`);
    });
    proc.on('exit', () => {
      if (entry.stopped || this.current !== entry) return;
      this.current = undefined;
      this.listener.ended(item.id);
      this.next();
    });
    if (this.paused) proc.kill('SIGSTOP');
    this.listener.started(item.id);
  }
}
