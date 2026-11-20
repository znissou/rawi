import * as fs from 'fs';
import * as path from 'path';
import { Segment, makeSegments } from '../text/segments';
import { SpeakOptions, plainBlocks, speakableBlocks } from '../text/speakable';
import { Logger, errorText } from '../util/log';
import { wavBytes } from './pcm';
import { Player } from './player';
import { OUTPUT_RATE, SpeechProcessor, concat } from './stream';

/**
 * Reads things aloud, one at a time.
 *
 * A reply is split into parts (segments.ts). The first part is fetched alone so speech starts
 * quickly; the next ones are fetched while earlier ones play. Audio is played as it arrives: each
 * part becomes a few short chunks handed to the player in order, and the player plays them back to
 * back. If the voice fails, or sends nothing for `fallbackAfterMs` while rawi waits for it, the
 * backup voice reads the rest of that reply. The next reply tries the main voice again.
 */

export interface ReadItem {
  id: string;
  title: string;
  markdown: string;
  /** Set when `markdown` isn't Markdown (a selection in a text or code file): it's read as written. */
  plain?: 'prose' | 'code';
  /** Voice samples use a voice other than the chosen one. */
  voice?: string;
  model?: string;
}

export interface AudioFormat {
  rate: number;
  channels: number;
  /** The voice already spoke at the chosen speed (Kokoro does), so rawi doesn't stretch it again. */
  speedApplied?: boolean;
}

export interface SpeechSource {
  /** Streams 16-bit PCM for `text` through `onAudio`; resolves once all of it has arrived. */
  stream(text: string, item: ReadItem, signal: AbortSignal, onAudio: (pcm: Buffer, format: AudioFormat) => void): Promise<{ cached?: boolean }>;
}

export type NarratorState =
  | { kind: 'idle' }
  | { kind: 'loading' | 'playing' | 'paused'; item: ReadItem; index: number; count: number; backup: boolean };

export interface NarratorDeps {
  player: Player;
  primary: SpeechSource;
  /** The backup voice, or undefined when it's turned off or not available here. */
  backup(): SpeechSource | undefined;
  /** How long to wait for the main voice before the backup reads `item` instead (0: only when it fails). */
  fallbackAfterMs(item: ReadItem): number;
  speakOptions(): SpeakOptions;
  speed(): number;
  tempDir: string;
  log: Logger;
  onState(state: NarratorState): void;
  /** `fellBack`: the backup voice took over, so the user still hears the reply. */
  onError(err: unknown, item: ReadItem, fellBack: boolean): void;
  /** The backup voice took over because the main one was too slow. */
  onSlowFallback?(item: ReadItem, waitedMs: number): void;
}

interface Chunk { file: string; durationMs: number }

interface Piece {
  segment: Segment;
  chunks: Chunk[];
  /** All its audio is in `chunks`. */
  done: boolean;
  failed: boolean;
  loading: boolean;
  /** Read by the backup voice. */
  backup: boolean;
  abort?: AbortController;
}

class Run {
  readonly id = Math.random().toString(36).slice(2, 8);
  readonly abort = new AbortController();
  readonly pieces: Piece[];
  /** Bumped on every skip, so events about chunks from before the skip are ignored. */
  gen = 0;
  /** Next chunk to hand to the player. */
  cursor = { piece: 0, chunk: 0 };
  /** Chunks handed to the player (this generation) that haven't ended yet. */
  queued = 0;
  /** Part being heard. */
  playing = -1;
  startedAt = 0;
  readonly createdAt = Date.now();
  heard = false;
  useBackup = false;
  waitTimer?: NodeJS.Timeout;

  constructor(readonly item: ReadItem, segments: Segment[]) {
    this.pieces = segments.map((segment) => ({ segment, chunks: [], done: false, failed: false, loading: false, backup: false }));
  }

  key(piece: number, chunk: number): string {
    return `${this.id}.${this.gen}:${piece}.${chunk}`;
  }
}

const AHEAD = 2;
const FIRST_CHUNK_S = 0.3;
const CHUNK_S = 0.6;

export class Narrator {
  private run?: Run;
  private waiting: ReadItem[] = [];
  private paused = false;

  constructor(private readonly d: NarratorDeps) {}

  get state(): NarratorState {
    const run = this.run;
    if (!run) return { kind: 'idle' };
    const kind = this.paused ? 'paused' : run.playing < 0 ? 'loading' : 'playing';
    return { kind, item: run.item, index: Math.max(run.playing, 0), count: run.pieces.length, backup: run.useBackup };
  }

  /** What's being read now, if anything. */
  get currentId(): string | undefined {
    return this.run?.item.id;
  }

  read(item: ReadItem, whenBusy: 'queue' | 'interrupt'): void {
    if (this.run && whenBusy === 'queue') {
      if (this.run.item.id !== item.id && !this.waiting.some((w) => w.id === item.id)) this.waiting.push(item);
      return;
    }
    this.halt();
    this.waiting = [];
    this.start(item);
  }

  /** Stops reading and forgets anything waiting. */
  stop(): void {
    this.waiting = [];
    this.halt();
    this.emit();
  }

  /** Returns false when there's nothing to pause. */
  pauseResume(): boolean {
    const run = this.run;
    if (!run) return false;
    this.paused = !this.paused;
    if (this.paused) this.d.player.pause();
    else this.d.player.resume();
    // Telling the others can stop this reading (another window took the voice meanwhile): `run` is then
    // over, and pump() leaves it alone.
    this.emit();
    if (!this.paused) this.pump(run); // restarts the wait for a slow voice, if any
    return true;
  }

  skipForward(): void {
    const run = this.run;
    if (!run) return;
    const next = this.at(run) + 1;
    if (next >= run.pieces.length) {
      this.d.player.stop();
      this.finish(run);
    } else {
      this.jump(run, next);
    }
  }

  /** Back to the start of the current part, or to the previous one when it just began. */
  skipBack(): void {
    const run = this.run;
    if (!run) return;
    const at = this.at(run);
    this.jump(run, Date.now() - run.startedAt < 2000 && at > 0 ? at - 1 : at);
  }

  // ---- player events ----

  onStarted(key: string): void {
    const m = this.match(key);
    if (!m) return;
    const { run, piece } = m;
    if (run.playing !== piece) {
      run.playing = piece;
      run.startedAt = Date.now();
      this.emit();
    }
    if (!run.heard) {
      run.heard = true;
      this.d.log.info(`First sound ${Date.now() - run.createdAt} ms after the request to read "${run.item.title}".`);
    }
  }

  onEnded(key: string): void {
    const m = this.match(key);
    if (!m) return;
    m.run.queued = Math.max(0, m.run.queued - 1);
    this.pump(m.run);
  }

  onPlayerError(): void {
    const run = this.run;
    if (run) this.finish(run);
  }

  dispose(): void {
    this.stop();
    void fs.promises.rm(this.d.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---- internals ----

  private start(item: ReadItem): void {
    const blocks = item.plain ? plainBlocks(item.markdown, item.plain) : speakableBlocks(item.markdown, this.d.speakOptions());
    const segments = makeSegments(blocks);
    if (!segments.length) {
      this.d.log.info(`Nothing to read in "${item.title}".`);
      this.startNext();
      return;
    }
    this.paused = false;
    const run = new Run(item, segments);
    this.run = run;
    this.d.player.prepare(OUTPUT_RATE, 1); // opening the audio device takes a moment: do it while the voice works
    fs.mkdirSync(this.d.tempDir, { recursive: true });
    this.d.log.info(`Reading "${item.title}": ${segments.length} part(s), ${segments.reduce((n, s) => n + s.text.length, 0)} characters.`);
    this.emit();
    this.pump(run);
  }

  private load(run: Run, i: number): void {
    const p = run.pieces[i];
    if (run !== this.run || !p || p.loading || p.done || p.failed) return;
    const backup = run.useBackup ? this.d.backup() : undefined;
    const source = backup ?? this.d.primary;
    const abort = new AbortController();
    const forward = () => abort.abort();
    run.abort.signal.addEventListener('abort', forward, { once: true });
    Object.assign(p, { loading: true, backup: Boolean(backup), chunks: [], abort });
    const speed = this.d.speed();
    const streaming = this.d.player.streaming;
    const t0 = Date.now();
    let firstAudio = -1;
    let proc: SpeechProcessor | undefined;
    let pending: Float32Array[] = [];
    let pendingLen = 0;
    const live = () => run === this.run && !abort.signal.aborted;

    const flush = (final: boolean) => {
      const min = OUTPUT_RATE * (p.chunks.length === 0 ? FIRST_CHUNK_S : CHUNK_S);
      if (!pendingLen || (!final && (!streaming || pendingLen < min))) return;
      const samples = concat(pending);
      pending = [];
      pendingLen = 0;
      const file = path.join(this.d.tempDir, `${run.id}-${i}-${p.chunks.length}${p.backup ? 'b' : ''}.wav`);
      fs.writeFileSync(file, wavBytes(samples, OUTPUT_RATE)); // in order, before the next chunk is made
      p.chunks.push({ file, durationMs: (samples.length / OUTPUT_RATE) * 1000 });
      this.pump(run);
    };
    const take = (out: Float32Array) => {
      if (!out.length) return;
      pending.push(out);
      pendingLen += out.length;
    };

    source.stream(p.segment.text, run.item, abort.signal, (pcm, format) => {
      if (!live()) return;
      if (firstAudio < 0) firstAudio = Date.now() - t0;
      proc ??= new SpeechProcessor(format.rate, format.channels, format.speedApplied ? 1 : speed);
      take(proc.push(pcm));
      flush(false);
    }).then((result) => {
      if (!live()) {
        if (p.abort === abort) p.loading = false; // a replaced request must not touch its successor's state
        return;
      }
      if (proc) take(proc.end(p.segment.pauseAfterMs));
      // Done before the last chunk goes out: handing it over runs the queue, which must not see a
      // part that is neither loading nor done (it would fetch it again).
      p.done = true;
      p.loading = false;
      flush(true);
      const how = result.cached ? 'from cache' : `first audio after ${firstAudio} ms, all after ${Date.now() - t0} ms`;
      this.d.log.info(`Part ${i + 1}/${run.pieces.length}: ${p.segment.text.length} chars${p.backup ? ', backup voice' : ''}, ${how}.`);
      this.pump(run);
    }).catch((err) => {
      if (p.abort === abort) p.loading = false;
      if (!live()) return; // stopped, or this part was handed to the backup voice
      this.failed(run, i, err);
    }).finally(() => run.abort.signal.removeEventListener('abort', forward));
  }

  private failed(run: Run, i: number, err: unknown): void {
    const p = run.pieces[i];
    const canFallBack = !p.backup && this.d.backup() !== undefined;
    if (canFallBack && p.chunks.length === 0) {
      this.d.log.warn(`Part ${i + 1} of "${run.item.title}" failed (${errorText(err)}); the backup voice reads the rest.`);
      this.d.onError(err, run.item, true);
      this.switchToBackup(run, i);
      return;
    }
    this.d.log.warn(`Part ${i + 1} of "${run.item.title}" failed: ${errorText(err)}`);
    this.d.onError(err, run.item, false);
    if (p.chunks.length) {
      p.done = true; // keep what arrived
      if (canFallBack) this.switchToBackup(run, i + 1);
    } else {
      p.failed = true;
    }
    this.pump(run);
  }

  /** The rest of this reply is read by the backup voice; parts already heard or arriving stay. */
  private switchToBackup(run: Run, from: number): void {
    if (!run.useBackup) {
      run.useBackup = true;
      for (let j = from; j < run.pieces.length; j++) {
        const q = run.pieces[j];
        if (q.done || q.chunks.length || q.backup) continue;
        q.abort?.abort();
        q.loading = false;
        q.failed = false;
      }
      this.emit();
    }
    this.pump(run);
  }

  /** Hands every ready chunk to the player, in order; fetches ahead; finishes when all was heard. */
  private pump(run: Run): void {
    if (run !== this.run) return;
    for (;;) {
      const p = run.pieces[run.cursor.piece];
      if (!p) break;
      if (run.cursor.chunk < p.chunks.length) {
        const c = p.chunks[run.cursor.chunk];
        this.d.player.queue(run.key(run.cursor.piece, run.cursor.chunk), c.file, c.durationMs);
        run.queued++;
        run.cursor.chunk++;
        this.clearWait(run);
        continue;
      }
      if (p.done && run.cursor.piece + 1 < run.pieces.length) {
        run.cursor = { piece: run.cursor.piece + 1, chunk: 0 };
        continue;
      }
      break;
    }
    for (let j = run.cursor.piece; j <= run.cursor.piece + AHEAD; j++) this.load(run, j);
    if (run !== this.run) return;
    const p = run.pieces[run.cursor.piece];
    const nothingLeft = p.failed || (p.done && run.cursor.chunk >= p.chunks.length);
    if (run.queued === 0 && nothingLeft) {
      this.finish(run);
      return;
    }
    if (run.queued === 0) this.waitFor(run);
  }

  /** The player has nothing left and the next part has no audio yet: fall back if it takes too long. */
  private waitFor(run: Run): void {
    const ms = this.d.fallbackAfterMs(run.item);
    const p = run.pieces[run.cursor.piece];
    if (run.waitTimer || ms <= 0 || p.backup || p.chunks.length || run.useBackup || !this.d.backup()) return;
    const since = Date.now();
    run.waitTimer = setTimeout(() => {
      run.waitTimer = undefined;
      const q = run.pieces[run.cursor.piece];
      if (run !== this.run || q.chunks.length || q.done || q.backup || this.paused) return;
      this.d.log.info(`The voice sent nothing for ${Date.now() - since} ms: the backup voice reads the rest of "${run.item.title}".`);
      this.d.onSlowFallback?.(run.item, Date.now() - since);
      this.switchToBackup(run, run.cursor.piece);
    }, ms);
  }

  private clearWait(run: Run): void {
    if (run.waitTimer) clearTimeout(run.waitTimer);
    run.waitTimer = undefined;
  }

  private at(run: Run): number {
    return run.playing >= 0 ? run.playing : run.cursor.piece;
  }

  private jump(run: Run, i: number): void {
    this.d.player.stop();
    run.gen++;
    run.queued = 0;
    run.cursor = { piece: i, chunk: 0 };
    run.playing = -1;
    run.startedAt = Date.now();
    this.paused = false;
    this.clearWait(run);
    this.emit();
    this.pump(run);
  }

  private match(key: string): { run: Run; piece: number; chunk: number } | undefined {
    const run = this.run;
    if (!run || !key.startsWith(`${run.id}.${run.gen}:`)) return undefined;
    const [piece, chunk] = key.slice(key.indexOf(':') + 1).split('.').map(Number);
    return { run, piece, chunk };
  }

  private finish(run: Run): void {
    if (run !== this.run) return;
    this.cleanup(run);
    this.run = undefined;
    this.paused = false;
    this.startNext();
  }

  private startNext(): void {
    const next = this.waiting.shift();
    if (next) this.start(next);
    else this.emit();
  }

  /** Stops the current item without starting the next. */
  private halt(): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    this.paused = false;
    this.d.player.stop();
    this.cleanup(run);
  }

  private cleanup(run: Run): void {
    this.clearWait(run);
    run.abort.abort();
    for (const p of run.pieces) {
      for (const c of p.chunks) void fs.promises.rm(c.file, { force: true }).catch(() => undefined);
    }
  }

  private emit(): void {
    this.d.onState(this.state);
  }
}
