import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger, errorText } from '../util/log';
import { Audio } from './pcm';

/**
 * Keeps the speech rawi fetched, so replaying a reply or a voice sample costs no new request.
 * Raw PCM is stored (speed and volume are applied when playing), oldest files go first past the
 * size limit.
 */
export class AudioCache {
  private puts = 0;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    private readonly maxBytes = 100 * 1024 * 1024,
  ) {}

  static key(...parts: string[]): string {
    return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
  }

  async get(key: string): Promise<Audio | undefined> {
    try {
      const meta = JSON.parse(await fs.promises.readFile(this.file(key, 'json'), 'utf8')) as { rate: number; channels: number };
      const pcm = await fs.promises.readFile(this.file(key, 'pcm'));
      const now = new Date();
      void fs.promises.utimes(this.file(key, 'pcm'), now, now).catch(() => undefined);
      return { pcm, rate: meta.rate, channels: meta.channels };
    } catch {
      return undefined;
    }
  }

  async put(key: string, audio: Audio): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(this.file(key, 'pcm'), audio.pcm);
      await fs.promises.writeFile(this.file(key, 'json'), JSON.stringify({ rate: audio.rate, channels: audio.channels }));
      if (++this.puts % 20 === 1) await this.prune();
    } catch (err) {
      this.log.warn(`Couldn't cache audio: ${errorText(err)}`);
    }
  }

  async prune(): Promise<void> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(this.dir)).filter((n) => n.endsWith('.pcm'));
    } catch {
      return;
    }
    const files = await Promise.all(names.map(async (n) => {
      const st = await fs.promises.stat(path.join(this.dir, n)).catch(() => undefined);
      return { n, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
    }));
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.maxBytes) break;
      const key = f.n.slice(0, -4);
      await fs.promises.rm(this.file(key, 'pcm'), { force: true });
      await fs.promises.rm(this.file(key, 'json'), { force: true });
      total -= f.size;
    }
  }

  private file(key: string, ext: string): string {
    return path.join(this.dir, `${key}.${ext}`);
  }
}
