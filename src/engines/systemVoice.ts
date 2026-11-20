import * as fs from 'fs';
import * as path from 'path';
import { AudioFormat, ReadItem, SpeechSource } from '../audio/narrator';
import { parseWav } from '../audio/stream';

/**
 * The backup voice: the operating system's own speech (Windows' System.Speech, through the audio
 * helper). Robotic next to OpenRouter's voices, but instant, free and always there.
 */
export class SystemVoice implements SpeechSource {
  /** Name of the voice used, once known (for the log and the tooltip). */
  voiceName?: string;

  constructor(
    private readonly synthesize: (text: string, file: string) => Promise<{ voice: string }>,
    private readonly tempDir: string,
  ) {}

  async stream(text: string, _item: ReadItem, signal: AbortSignal, onAudio: (pcm: Buffer, format: AudioFormat) => void): Promise<{ cached: boolean }> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const file = path.join(this.tempDir, `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.wav`);
    try {
      const { voice } = await this.synthesize(text, file);
      this.voiceName = voice;
      if (signal.aborted) throw new Error('Stopped.');
      const audio = parseWav(await fs.promises.readFile(file));
      onAudio(audio.pcm, { rate: audio.rate, channels: audio.channels });
      return { cached: false };
    } finally {
      void fs.promises.rm(file, { force: true }).catch(() => undefined);
    }
  }
}
