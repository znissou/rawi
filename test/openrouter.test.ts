import { describe, expect, it, vi } from 'vitest';
import { OpenRouter, OpenRouterError } from '../src/engines/openrouter';

type Body = ConstructorParameters<typeof Response>[0];

function response(status: number, body: Body | object, headers: Record<string, string> = {}): Response {
  const isJson = typeof body === 'object' && !(body instanceof Uint8Array);
  return new Response(isJson ? JSON.stringify(body) : (body as Body), {
    status,
    headers: isJson ? { 'content-type': 'application/json', ...headers } : headers,
  });
}

describe('OpenRouter', () => {
  it('asks for PCM and reads the rate from the content type', async () => {
    const fetch = vi.fn(async () => response(200, new Uint8Array([1, 0, 2, 0]), { 'content-type': 'audio/pcm;rate=44100;channels=1' }));
    const or = new OpenRouter(async () => 'sk-or-test', fetch);
    const audio = await or.speak('Hello.', 'heygen/heygen-voice-1-turbo:free', 'nadine');
    expect(audio).toMatchObject({ rate: 44100, channels: 1 });
    expect(audio.pcm.length).toBe(4);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'heygen/heygen-voice-1-turbo:free', voice: 'nadine', input: 'Hello.', response_format: 'pcm' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
  });

  it('asks for the model\'s own voice when no voice is set', async () => {
    const fetch = vi.fn(async () => response(200, new Uint8Array([1, 0]), { 'content-type': 'audio/pcm;rate=44100;channels=1' }));
    await new OpenRouter(async () => 'k', fetch).speak('Hello.', 'fish-audio/s2.1-pro-free:free', '');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ model: 'fish-audio/s2.1-pro-free:free', input: 'Hello.', response_format: 'pcm' });
  });

  it('keeps the last model list when OpenRouter is out of reach, unless asked to refresh it', async () => {
    const data = [{ id: 'b/paid', name: 'B: Paid', pricing: { prompt: '0.000004', completion: '0' }, supported_voices: ['x'], architecture: { output_modalities: ['speech'] } }];
    const fetch = vi.fn().mockResolvedValueOnce(response(200, { data })).mockRejectedValue(new Error('offline'));
    const or = new OpenRouter(async () => 'k', fetch);
    expect(await or.model('b/paid')).toMatchObject({ free: false });
    const later = Date.now() + 7 * 60 * 60_000; // the six-hour cache is over
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(later);
    try {
      expect(await or.model('b/paid')).toMatchObject({ free: false }); // the refresh failed: the old list says it's paid
      await expect(or.speechModels(true)).rejects.toMatchObject({ kind: 'network' });
    } finally {
      vi.useRealTimers();
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    // Never fetched: there's no list, so the price can't be known.
    const never = new OpenRouter(async () => 'k', async () => { throw new Error('offline'); });
    await expect(never.model('b/paid')).rejects.toMatchObject({ kind: 'network' });
  });

  it('says what went wrong', async () => {
    const cases: [number, string][] = [[401, 'auth'], [402, 'credits'], [404, 'notFound'], [400, 'badRequest'], [500, 'server']];
    for (const [status, kind] of cases) {
      const or = new OpenRouter(async () => 'k', async () => response(status, { error: { message: 'details' } }));
      await expect(or.speak('x', 'm', 'v')).rejects.toMatchObject({ kind });
    }
    await expect(new OpenRouter(async () => undefined).speak('x', 'm', 'v')).rejects.toMatchObject({ kind: 'noKey' });
  });

  it('retries once when the voice is busy', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(429, { error: { message: 'busy' } }))
      .mockResolvedValueOnce(response(200, new Uint8Array([0, 0]), { 'content-type': 'audio/pcm;rate=24000' }));
    const audio = await new OpenRouter(async () => 'k', fetch).speak('x', 'm', 'v');
    expect(audio.rate).toBe(24000);
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it('refuses MP3 it cannot play', async () => {
    const or = new OpenRouter(async () => 'k', async () => response(200, new Uint8Array([1, 2]), { 'content-type': 'audio/mpeg' }));
    await expect(or.speak('x', 'm', 'v')).rejects.toBeInstanceOf(OpenRouterError);
  });

  it('lists speech models free first, with voices and expiry', async () => {
    const data: object[] = [
      { id: 'b/paid', name: 'B: Paid', pricing: { prompt: '0.000004', completion: '0' }, supported_voices: ['x'], architecture: { output_modalities: ['speech'] } },
      { id: 'a/free:free', name: 'A: Free (free)', pricing: { prompt: '0', completion: '0' }, supported_voices: ['nadine', 'bram'], expiration_date: '2026-11-30', architecture: { output_modalities: ['speech'] } },
    ];
    data.push({ id: 'c/by-audio', name: 'C: By Audio', pricing: { prompt: '0', completion: '0.0025' }, supported_voices: [], architecture: { output_modalities: ['speech'] } });
    const models = await new OpenRouter(async () => 'k', async () => response(200, { data })).speechModels();
    expect(models.map((m) => m.id)).toEqual(['a/free:free', 'c/by-audio', 'b/paid']);
    expect(models[1]).toMatchObject({ free: false, billsOutput: true, pricePerChar: 0 });
    models.splice(1, 1);
    expect(models[0]).toMatchObject({ name: 'Free', free: true, billsOutput: false, voices: ['nadine', 'bram'], expires: '2026-11-30' });
    expect(models[1]).toMatchObject({ free: false, pricePerChar: 0.000004 });
  });
});
