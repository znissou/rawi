import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where Kokoro's model files are. In order: the folder set in `rawi.kokoro.folder`; Read Aloud's
 * copy (`~/.claude/kokoro`), so nothing is downloaded twice; rawi's own download.
 * The files are the kokoro-onnx v1.0 release: the model (325.5 MB) and the voices (28.2 MB).
 */

export const MODEL_FILE = 'kokoro-v1.0.onnx';
export const VOICES_FILE = 'voices-v1.0.bin';
const RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
export const FILES = [
  { name: MODEL_FILE, size: 325_532_387, sha256: '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5' },
  { name: VOICES_FILE, size: 28_214_398, sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' },
];
export const DOWNLOAD_MB = Math.round(FILES.reduce((n, f) => n + f.size, 0) / 1e6);

export interface KokoroFiles {
  folder: string;
  model: string;
  voices: string;
  /** Where they were found. */
  source: 'setting' | 'readAloud' | 'rawi';
}

function complete(folder: string, strict: boolean): boolean {
  return FILES.every((f) => {
    try {
      const st = fs.statSync(path.join(folder, f.name));
      return st.isFile() && (!strict || st.size === f.size);
    } catch {
      return false;
    }
  });
}

export function findKokoro(folderSetting: string, storageDir: string): KokoroFiles | undefined {
  const candidates: [string, KokoroFiles['source'], boolean][] = [
    [folderSetting.trim(), 'setting', false],
    [path.join(os.homedir(), '.claude', 'kokoro'), 'readAloud', true],
    [path.join(storageDir, 'kokoro'), 'rawi', true],
  ];
  for (const [folder, source, strict] of candidates) {
    if (folder && complete(folder, strict)) {
      return { folder, model: path.join(folder, MODEL_FILE), voices: path.join(folder, VOICES_FILE), source };
    }
  }
  return undefined;
}

/** Downloads the model and voices into `<storageDir>/kokoro`, checking each file's SHA-256. */
export async function downloadKokoro(
  storageDir: string,
  progress: (doneBytes: number, totalBytes: number) => void,
  signal: AbortSignal,
): Promise<KokoroFiles> {
  const folder = path.join(storageDir, 'kokoro');
  await fs.promises.mkdir(folder, { recursive: true });
  const total = FILES.reduce((n, f) => n + f.size, 0);
  let before = 0;
  for (const f of FILES) {
    const target = path.join(folder, f.name);
    const exists = await fs.promises.stat(target).then((s) => s.size === f.size, () => false);
    if (!exists) {
      const part = `${target}.part`;
      const res = await fetch(`${RELEASE}/${f.name}`, { signal });
      if (!res.ok || !res.body) throw new Error(`Download of ${f.name} failed: HTTP ${res.status}.`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let got = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          got += chunk.length;
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          progress(before + got, total);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (hash.digest('hex') !== f.sha256) {
        await fs.promises.rm(part, { force: true });
        throw new Error(`${f.name} arrived damaged (checksum mismatch). Try again.`);
      }
      await fs.promises.rename(part, target);
    }
    before += f.size;
    progress(before, total);
  }
  return { folder, model: path.join(folder, MODEL_FILE), voices: path.join(folder, VOICES_FILE), source: 'rawi' };
}
