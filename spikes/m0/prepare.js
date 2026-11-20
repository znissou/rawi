'use strict';
// M0 spike: turn the fetched PCM into what the player gets — trimmed, faded sentences with a
// 250 ms pause after each — plus the whole paragraph sped up to 1.25x and 1.5x with WSOLA.
// Usage: node prepare.js <dir with s1..s3.pcm and meta.json>
const fs = require('fs');
const path = require('path');
const A = require('./audio');

const dir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const rate = meta[0].rate;
const PAUSE_MS = 250;

const durations = {};
const save = (name, x) => {
  fs.writeFileSync(path.join(dir, `${name}.wav`), A.wavBytes(x, rate));
  durations[name] = Math.round((x.length / rate) * 1000 * 10) / 10;
};

const sentences = meta.map((m) => {
  const raw = A.pcm16ToFloat(fs.readFileSync(path.join(dir, m.file)));
  const [a, b] = A.soundBounds(raw, rate);
  console.log(`${m.file}: ${(raw.length / rate).toFixed(2)} s, silence before ${Math.round((a / rate) * 1000)} ms, after ${Math.round(((raw.length - b) / rate) * 1000)} ms`);
  return A.concat([A.fade(A.trim(raw, rate), rate), A.silence(rate, PAUSE_MS)]);
});
sentences.forEach((x, i) => save(`s${i + 1}`, x));

const paragraph = A.concat(sentences);
for (const speed of [1.25, 1.5]) {
  const t0 = performance.now();
  const fast = A.wsola(paragraph, rate, speed);
  const ms = performance.now() - t0;
  save(`p${Math.round(speed * 100)}`, fast);
  console.log(`${speed}x: ${(paragraph.length / rate).toFixed(2)} s -> ${(fast.length / rate).toFixed(2)} s (expected ${(paragraph.length / rate / speed).toFixed(2)} s), stretched in ${Math.round(ms)} ms`);
}

const pitch = (x) => Math.round(A.medianPitch(x, rate));
const p125 = A.wsola(paragraph, rate, 1.25), p150 = A.wsola(paragraph, rate, 1.5);
console.log(`median pitch: 1x ${pitch(paragraph)} Hz, 1.25x ${pitch(p125)} Hz, 1.5x ${pitch(p150)} Hz`);
fs.writeFileSync(path.join(dir, 'durations.json'), JSON.stringify(durations, null, 2));
console.log('durations (ms):', JSON.stringify(durations));
