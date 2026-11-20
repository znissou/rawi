import { Audio } from '../audio/pcm';

/**
 * OpenRouter's speech API: the live list of speech models (with their voices, prices and expiry
 * dates) and text to speech as raw PCM. Docs: https://openrouter.ai/docs/guides/overview/multimodal/tts
 */

const BASE = 'https://openrouter.ai/api/v1';
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

export interface SpeechModel {
  id: string;
  name: string;
  /** USD per input character (0 for free models). */
  pricePerChar: number;
  /** Also billed by the audio it outputs (Gemini TTS, Seed Audio): a per-reply cost can't be told ahead. */
  billsOutput: boolean;
  free: boolean;
  voices: string[];
  /** YYYY-MM-DD, for models that are only offered for a while. */
  expires?: string;
  description: string;
}

export type OpenRouterErrorKind = 'noKey' | 'auth' | 'credits' | 'notFound' | 'rateLimit' | 'badRequest' | 'format' | 'server' | 'network';

export class OpenRouterError extends Error {
  constructor(readonly kind: OpenRouterErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface RawModel {
  id: string;
  name?: string;
  description?: string;
  pricing?: Record<string, string | undefined>;
  supported_voices?: string[] | null;
  expiration_date?: string | null;
  architecture?: { output_modalities?: string[] };
}

export class OpenRouter {
  private models?: { at: number; list: SpeechModel[] };

  constructor(
    private readonly getKey: () => Promise<string | undefined>,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  /**
   * Speech models, free ones first, then by price. Cached for six hours. When OpenRouter is out of reach,
   * the last list fetched is used, however old (prices and voices rarely change); `force` says it failed.
   */
  async speechModels(force = false): Promise<SpeechModel[]> {
    if (!force && this.models && Date.now() - this.models.at < MODELS_TTL_MS) return this.models.list;
    try {
      const list = await this.fetchModels();
      this.models = { at: Date.now(), list };
      return list;
    } catch (err) {
      if (!force && this.models) return this.models.list;
      throw err;
    }
  }

  private async fetchModels(): Promise<SpeechModel[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}/models?output_modalities=speech`);
    } catch (err) {
      throw new OpenRouterError('network', `Can't reach OpenRouter (${(err as Error).message}).`);
    }
    if (!res.ok) throw await toError(res);
    const body = (await res.json()) as { data?: RawModel[] };
    return (body.data ?? [])
      .filter((m) => m.architecture?.output_modalities?.includes('speech') ?? true)
      .map(toModel)
      .sort((a, b) => Number(b.free) - Number(a.free) || a.pricePerChar - b.pricePerChar || a.name.localeCompare(b.name));
  }

  async model(id: string): Promise<SpeechModel | undefined> {
    return (await this.speechModels()).find((m) => m.id === id);
  }

  /** Speech for `text` as raw PCM, all at once. */
  async speak(text: string, model: string, voice: string, signal?: AbortSignal): Promise<Audio> {
    const parts: Buffer[] = [];
    let format = { rate: 24000, channels: 1 };
    const timing = await this.speakStream(text, model, voice, signal, (pcm, f) => {
      parts.push(pcm);
      format = f;
    });
    return { pcm: Buffer.concat(parts), ...format, timing };
  }

  /**
   * Speech for `text` as raw 16-bit PCM, handed to `onAudio` as it arrives, so playback can start
   * before the voice has finished. Retries once when the (often shared, free) capacity is busy.
   * An empty `voice` asks for the model's own voice: some models, like Fish Audio's free one, list no
   * voices and refuse any.
   */
  async speakStream(
    text: string,
    model: string,
    voice: string,
    signal: AbortSignal | undefined,
    onAudio: (pcm: Buffer, format: { rate: number; channels: number }) => void,
  ): Promise<{ firstByteMs: number; totalMs: number }> {
    const key = await this.getKey();
    if (!key) throw new OpenRouterError('noKey', 'No OpenRouter API key is set.');
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${BASE}/audio/speech`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Rawi' },
          body: JSON.stringify({ model, ...(voice ? { voice } : {}), input: text, response_format: 'pcm' }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new OpenRouterError('network', `Can't reach OpenRouter (${(err as Error).message}).`);
      }
      if (!res.ok) {
        const error = await toError(res);
        if (error.kind === 'rateLimit' && attempt === 0 && !signal?.aborted) {
          await sleep(1500, signal);
          continue;
        }
        throw error;
      }
      const format = audioFormat(res);
      if (!res.body) throw new OpenRouterError('server', 'OpenRouter returned no audio.');
      let firstByteMs = -1;
      let bytes = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!chunk.length) continue;
        if (firstByteMs < 0) firstByteMs = Date.now() - t0;
        bytes += chunk.length;
        onAudio(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), format);
      }
      if (bytes < 2) throw new OpenRouterError('server', 'OpenRouter returned no audio.');
      return { firstByteMs, totalMs: Date.now() - t0 };
    }
  }

  /** What OpenRouter says about the key: free requests left today, credit limit left. */
  async keyInfo(key?: string): Promise<{ freeRequestsLeft?: number; limitRemaining?: number | null; freeTier?: boolean }> {
    const k = key ?? (await this.getKey());
    if (!k) throw new OpenRouterError('noKey', 'No OpenRouter API key is set.');
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}/key`, { headers: { Authorization: `Bearer ${k}` } });
    } catch (err) {
      throw new OpenRouterError('network', `Can't reach OpenRouter (${(err as Error).message}).`);
    }
    if (!res.ok) throw await toError(res);
    const d = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
    const free = d.free_model_daily_requests as { remaining?: number } | undefined;
    return {
      freeRequestsLeft: free?.remaining,
      limitRemaining: (d.limit_remaining as number | null | undefined) ?? null,
      freeTier: d.is_free_tier as boolean | undefined,
    };
  }
}

function toModel(m: RawModel): SpeechModel {
  const prompt = Number(m.pricing?.prompt ?? 0) || 0;
  const completion = Number(m.pricing?.completion ?? 0) || 0;
  return {
    id: m.id,
    // "HeyGen: HeyGen Voice Turbo (free)" -> "HeyGen Voice Turbo": rawi says "free" itself
    name: (m.name ?? m.id).replace(/^[^:]+:\s*/, '').replace(/\s*\(free\)\s*$/i, ''),
    pricePerChar: prompt,
    billsOutput: completion > 0,
    free: m.id.endsWith(':free') || (prompt === 0 && completion === 0),
    voices: m.supported_voices ?? [],
    expires: m.expiration_date ?? undefined,
    description: m.description ?? '',
  };
}

/** The PCM format, from `audio/pcm;rate=44100;channels=1` (OpenAI's 24 kHz mono when unsaid). */
function audioFormat(res: Response): { rate: number; channels: number } {
  const type = res.headers.get('content-type') ?? '';
  if (/mpeg|mp3/i.test(type)) {
    throw new OpenRouterError('format', 'This model only returns MP3, which rawi can\'t play yet. Choose another model.');
  }
  return {
    rate: Number(/rate=(\d+)/i.exec(type)?.[1] ?? 24000),
    channels: Number(/channels=(\d+)/i.exec(type)?.[1] ?? 1),
  };
}

async function toError(res: Response): Promise<OpenRouterError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    // not JSON
  }
  const s = res.status;
  if (s === 401 || s === 403) return new OpenRouterError('auth', 'OpenRouter rejected the API key.', s);
  if (s === 402) return new OpenRouterError('credits', 'Your OpenRouter credits are used up for this model.', s);
  if (s === 404) return new OpenRouterError('notFound', `OpenRouter doesn't offer this model any more${detail ? ` (${detail})` : ''}.`, s);
  if (s === 429) return new OpenRouterError('rateLimit', 'The voice is busy or the request limit was reached. Try again in a moment.', s);
  if (s === 400) return new OpenRouterError('badRequest', `OpenRouter refused the request${detail ? `: ${detail}` : ''}.`, s);
  return new OpenRouterError('server', `OpenRouter error ${s}${detail ? `: ${detail}` : ''}.`, s);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
