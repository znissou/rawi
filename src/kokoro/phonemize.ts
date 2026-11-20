import { phonemize as espeak } from 'phonemizer';

/**
 * English text to Kokoro phonemes, the way kokoro-js does it (kokoro-js by hexgrad and Xenova,
 * Apache-2.0, https://github.com/hexgrad/kokoro/tree/main/kokoro.js): normalize numbers, money,
 * years, times and titles; phonemize the text between punctuation with espeak-ng (the `phonemizer`
 * package, espeak-ng compiled to WebAssembly); keep the punctuation, which Kokoro uses for pauses;
 * then fix a few sounds. Checked against kokoro-onnx: same phonemes for the same sentence.
 */

function splitNum(m: string): string {
  if (m.includes('.')) return m;
  if (m.includes(':')) {
    const [h, min] = m.split(':').map(Number);
    if (min === 0) return `${h} o'clock`;
    return min < 10 ? `${h} oh ${min}` : `${h} ${min}`;
  }
  const year = parseInt(m.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return m;
  const left = m.slice(0, 2);
  const right = parseInt(m.slice(2, 4), 10);
  const s = m.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`;
    if (right < 10) return `${left} oh ${right}${s}`;
  }
  return `${left} ${right}${s}`;
}

function flipMoney(m: string): string {
  const unit = m[0] === '$' ? 'dollar' : 'pound';
  if (Number.isNaN(Number(m.slice(1)))) return `${m.slice(1)} ${unit}s`;
  if (!m.includes('.')) return `${m.slice(1)} ${unit}${m.slice(1) === '1' ? '' : 's'}`;
  const [whole, frac] = m.slice(1).split('.');
  const cents = parseInt(frac.padEnd(2, '0'), 10);
  const coins = m[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${whole} ${unit}${whole === '1' ? '' : 's'} and ${cents} ${coins}`;
}

function pointNum(m: string): string {
  const [a, b] = m.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_RUNS = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

/** Text and punctuation runs, in order. */
function sections(text: string): { punctuation: boolean; text: string }[] {
  const out: { punctuation: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(PUNCTUATION_RUNS)) {
    if (last < m.index!) out.push({ punctuation: false, text: text.slice(last, m.index) });
    if (m[0].length) out.push({ punctuation: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ punctuation: false, text: text.slice(last) });
  return out;
}

/** Phonemes for `text`; British English for Kokoro's b* voices, American otherwise. */
export async function phonemize(text: string, british = false): Promise<string> {
  const lang = british ? 'en' : 'en-us';
  const parts = await Promise.all(sections(normalizeText(text)).map(async (s) =>
    s.punctuation ? s.text : (await espeak(s.text, lang)).join(' ')));
  let ps = parts.join('')
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (!british) ps = ps.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return ps.trim();
}
