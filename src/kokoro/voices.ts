/**
 * Kokoro's voices file (`voices-v1.0.bin`): a NumPy .npz, i.e. an uncompressed zip of one .npy
 * array per voice, each 510 x 1 x 256 float32. Row n - 1 is the style for a text of n phonemes.
 */

const STYLE = 256;

export class VoicePack {
  private readonly entries = new Map<string, { offset: number; size: number }>();
  private readonly cache = new Map<string, Float32Array>();

  constructor(private readonly buf: Buffer) {
    // End of central directory: the last 22+ bytes, found by its signature.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('The voices file is not a zip archive.');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged voices file.');
      const method = buf.readUInt16LE(p + 10);
      const size = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (method !== 0) throw new Error(`Compressed voices aren't supported (${name}).`);
      const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      this.entries.set(name.replace(/\.npy$/, ''), { offset: dataAt, size });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The 256-value style vector for a text of `phonemes` tokens. */
  style(name: string, phonemes: number): Float32Array {
    const all = this.voice(name);
    const rows = all.length / STYLE;
    const row = Math.min(Math.max(phonemes, 1), rows) - 1;
    return all.slice(row * STYLE, (row + 1) * STYLE);
  }

  private voice(name: string): Float32Array {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const e = this.entries.get(name);
    if (!e) throw new Error(`Kokoro has no voice named ${name}.`);
    const npy = this.buf.subarray(e.offset, e.offset + e.size);
    if (npy.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`Voice ${name} isn't a NumPy array.`);
    const major = npy[6];
    const headerLen = major === 1 ? npy.readUInt16LE(8) : npy.readUInt32LE(8);
    const start = (major === 1 ? 10 : 12) + headerLen;
    const header = npy.toString('latin1', major === 1 ? 10 : 12, start);
    if (!header.includes("'<f4'")) throw new Error(`Voice ${name} isn't float32.`);
    const data = npy.subarray(start);
    const out = new Float32Array(data.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = data.readFloatLE(i * 4); // copies to aligned memory
    this.cache.set(name, out);
    return out;
  }
}

/** The English voices rawi offers (Kokoro also has other languages). */
export function englishVoice(name: string): boolean {
  return /^[ab][fm]_/.test(name);
}

export function describeVoice(name: string): string {
  const accent = name[0] === 'b' ? 'British' : 'American';
  const who = name[1] === 'f' ? 'female' : 'male';
  return `${accent} English, ${who}`;
}
