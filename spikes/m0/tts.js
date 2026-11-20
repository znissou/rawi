'use strict';
// M0 spike: fetch speech for the test sentences from OpenRouter, one request per sentence, as rawi
// will. Needs OPENROUTER_API_KEY. Usage: node tts.js <outDir>
const fs = require('fs');
const path = require('path');

const MODEL = 'heygen/heygen-voice-1-turbo:free';
const VOICE = 'nadine';
const SENTENCES = [
  'Done. I added the transcript watcher and the OpenRouter engine.',
  'Replies now play as soon as Claude finishes a turn, with no panel to open.',
  'You can stop them at any time with Control Alt Period, and change the speed in the settings.',
];

(async () => {
  const out = process.argv[2];
  fs.mkdirSync(out, { recursive: true });
  const meta = [];
  for (const [i, text] of SENTENCES.entries()) {
    const t0 = performance.now();
    const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'rawi (M0 spike)',
      },
      body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, response_format: 'pcm' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const chunks = [];
    let firstByte = null;
    for await (const chunk of res.body) {
      if (firstByte === null) firstByte = performance.now() - t0;
      chunks.push(Buffer.from(chunk));
    }
    const pcm = Buffer.concat(chunks);
    const rate = Number((/rate=(\d+)/.exec(res.headers.get('content-type') || '') || [])[1] || 24000);
    const file = `s${i + 1}.pcm`;
    fs.writeFileSync(path.join(out, file), pcm);
    meta.push({ file, text, rate, bytes: pcm.length, firstByteMs: Math.round(firstByte), totalMs: Math.round(performance.now() - t0) });
  }
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  for (const m of meta) {
    console.log(`${m.file}: ${m.text.length} chars -> ${(m.bytes / 2 / m.rate).toFixed(2)} s of audio at ${m.rate} Hz; first byte ${m.firstByteMs} ms, done ${m.totalMs} ms`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
