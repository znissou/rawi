import { ChildProcess, fork } from 'child_process';
import { AudioFormat, ReadItem, SpeechSource } from '../audio/narrator';
import { KokoroFiles } from '../kokoro/files';
import { splitSentences } from '../text/sentences';
import { Logger, errorText } from '../util/log';

/**
 * The local Kokoro voice. The model runs in a separate process (dist/kokoro-worker.js) started with
 * VS Code's own runtime: about 0.6 GB of memory once the model is loaded, up to about 1 GB after long
 * sentences (measured). So it's loaded when needed (or when the user sends Claude a prompt, so it's
 * ready for the reply) and stopped after a while unused.
 *
 * Kokoro can't stream, so a part is spoken sentence by sentence, each handed on as soon as it's ready:
 * playback starts after the first sentence. The sentences wait here and go to the worker one at a time,
 * each once the last is answered. Running the model blocks the worker, so it can't drop sentences it
 * already holds when a reading stops: when it held them all, the next reading waited up to 16.7 s
 * (measured 2026-11-16). Now a stop costs at most the sentence being made. Kokoro changes speed itself,
 * which sounds better than stretching afterwards.
 */

export const KOKORO = 'local:kokoro';

export interface KokoroOptions {
  workerPath: string;
  files(): KokoroFiles | undefined;
  threads(): number;
  voice(): string;
  speed(): number;
  log: Logger;
  idleMs?: number;
  /** Called with the worker's process id when it starts (on Windows, to keep it at full speed). */
  onStart?(pid: number): void;
}

interface Waiting {
  resolve(pcm: Buffer): void;
  reject(err: Error): void;
}

interface Request {
  id: number;
  text: string;
  voice: string;
  speed: number;
}

export class KokoroEngine implements SpeechSource {
  private proc?: ChildProcess;
  private ready?: Promise<void>;
  private nextId = 1;
  /** Requests not answered yet, sent to the worker or not. */
  private readonly waiting = new Map<number, Waiting>();
  /** Requests not sent to the worker yet, in order. */
  private readonly queue: Request[] = [];
  /** The request the worker is making; it gets the next one once it answers. */
  private making?: number;
  private idle?: NodeJS.Timeout;
  private loadedFrom?: string;
  voices: string[] = [];

  constructor(private readonly o: KokoroOptions) {}

  get available(): boolean {
    return this.o.files() !== undefined;
  }

  /** Starts the worker and loads the model, without speaking: the next reply starts sooner. */
  warmUp(): void {
    if (this.available) void this.ensure().catch(() => undefined);
  }

  async stream(text: string, item: ReadItem, signal: AbortSignal, onAudio: (pcm: Buffer, format: AudioFormat) => void): Promise<{ cached: boolean }> {
    await this.ensure();
    if (signal.aborted) throw new Error('Stopped.'); // stopped while Kokoro was loading: ask for nothing
    const voice = item.model === KOKORO && item.voice ? item.voice : this.o.voice();
    const speed = this.o.speed();
    const sentences = splitSentences(text).flatMap((s) => (s.length > 300 ? s.split(/(?<=[,;:])\s+/) : [s]));
    const ids = sentences.map((s) => this.request(s, voice, speed));
    // Stopped: the sentences not heard yet are dropped at once, so this ends now and the next reading
    // only waits for the sentence the worker is making.
    const cancel = () => {
      for (const { id } of ids) this.forget(id);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (const { done } of ids) {
        const pcm = await done;
        if (signal.aborted) throw new Error('Stopped.');
        onAudio(pcm, { rate: 24000, channels: 1, speedApplied: true });
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      this.touch();
    }
    return { cached: false };
  }

  /** Loads the model if needed and makes one short sentence; returns how long that took (ms). */
  async test(): Promise<number> {
    await this.ensure();
    const t0 = Date.now();
    await this.request('Ready.', this.o.voice(), 1).done;
    this.touch();
    return Date.now() - t0;
  }

  dispose(): void {
    this.stop('rawi stopped');
  }

  private request(text: string, voice: string, speed: number): { id: number; done: Promise<Buffer> } {
    const id = this.nextId++;
    const done = new Promise<Buffer>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    done.catch(() => undefined); // awaited in order; a later one may fail first
    this.queue.push({ id, text, voice, speed });
    this.sendNext();
    return { id, done };
  }

  /** Gives the worker the next sentence, unless it's making one. */
  private sendNext(): void {
    if (this.making !== undefined) return;
    const next = this.queue.shift();
    if (!next) return;
    if (!this.proc) {
      this.dropAll(new Error('Kokoro is not running.'));
      return;
    }
    this.making = next.id;
    this.proc.send({ type: 'speak', ...next });
  }

  /** The worker answered request `id`: settle it if it's still wanted, and send the next one. */
  private answered(id: number, settle: (w: Waiting) => void): void {
    const w = this.waiting.get(id);
    this.waiting.delete(id);
    if (w) settle(w);
    if (this.making === id) {
      this.making = undefined;
      this.sendNext();
    }
  }

  /** Drops a request not answered yet: it fails as stopped. If the worker is making it, its audio is ignored. */
  private forget(id: number): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    const i = this.queue.findIndex((r) => r.id === id);
    if (i >= 0) this.queue.splice(i, 1);
    w.reject(new Error('Stopped.'));
  }

  /** Fails every request not answered yet. */
  private dropAll(err: Error): void {
    const all = [...this.waiting.values()];
    this.waiting.clear();
    this.queue.length = 0;
    this.making = undefined;
    for (const w of all) w.reject(err);
  }

  private ensure(): Promise<void> {
    const files = this.o.files();
    if (!files) return Promise.reject(new Error('Kokoro is not set up. Run "Rawi: Set Up Local Voice (Kokoro)".'));
    if (this.ready && this.loadedFrom === files.model) {
      this.touch();
      return this.ready;
    }
    this.stop('model changed');
    const started = Date.now();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const proc = fork(this.o.workerPath, [], { env, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.proc = proc;
    this.loadedFrom = files.model;
    if (proc.pid) this.o.onStart?.(proc.pid);
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line && !/W:onnxruntime/.test(line)) this.o.log.warn(`Kokoro: ${line.slice(0, 300)}`);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      proc.on('message', (m: { type: string; id?: number; pcm?: Uint8Array; message?: string; ms?: number; voices?: string[] }) => {
        if (m.type === 'ready') {
          this.voices = m.voices ?? [];
          this.o.log.info(`Kokoro ready in ${Date.now() - started} ms (model loaded in ${m.ms} ms, from ${files.folder}).`);
          resolve();
        } else if (m.type === 'audio' && m.id !== undefined) {
          const pcm = Buffer.from(m.pcm!.buffer, m.pcm!.byteOffset, m.pcm!.byteLength);
          this.answered(m.id, (w) => w.resolve(pcm));
        } else if (m.type === 'error') {
          const err = new Error(m.message ?? 'Kokoro failed.');
          if (m.id === undefined) reject(err);
          else this.answered(m.id, (w) => w.reject(err));
        }
      });
      proc.on('exit', (code) => {
        const err = new Error(`Kokoro stopped (code ${code}).`);
        reject(err);
        if (this.proc !== proc) return; // stopped by rawi, which dropped its requests then
        this.proc = undefined;
        this.ready = undefined;
        this.dropAll(err);
      });
      proc.on('error', (err) => {
        this.o.log.error('Kokoro could not start', err);
        reject(err);
      });
    });
    // A worker that couldn't load the model is stopped, so the next reading tries again. Kept, it answered
    // every reading with the same failure until it went unused for 10 minutes.
    this.ready.catch(() => {
      if (this.proc === proc) this.stop("it couldn't start");
    });
    proc.send({ type: 'init', model: files.model, voices: files.voices, threads: this.o.threads() });
    this.touch();
    return this.ready;
  }

  /** Stops the worker after a while unused, to give its memory back. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.waiting.size) return this.touch();
      this.stop('unused for a while');
    }, this.o.idleMs ?? 10 * 60_000);
    this.idle.unref?.();
  }

  private stop(why: string): void {
    if (this.idle) clearTimeout(this.idle);
    const p = this.proc;
    this.proc = undefined;
    this.ready = undefined;
    if (!p) return;
    this.o.log.info(`Kokoro stopped: ${why}.`);
    this.dropAll(new Error(`Kokoro stopped: ${why}.`));
    try {
      if (p.connected) p.send({ type: 'quit' });
    } catch (err) {
      this.o.log.warn(`Kokoro: ${errorText(err)}`);
    }
    setTimeout(() => p.kill(), 1000).unref?.();
  }
}
