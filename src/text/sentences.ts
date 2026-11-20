// Splits prose into sentences without breaking on abbreviations, initials or numbers.

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'approx', 'incl', 'excl', 'est', 'fig', 'no', 'nos',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'inc', 'ltd', 'co', 'corp', 'dept', 'min', 'max',
]);

// End of a sentence: . ! ? (or several), maybe a closing quote or bracket, then space.
const END = /([.!?]+)(["'”’)\]]*)\s+/g;

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(END)) {
    const stop = m.index! + m[1].length + m[2].length;
    const next = text[m.index! + m[0].length];
    if (next === undefined) break;
    // The next sentence must start like one: a capital, a digit, a quote or a bracket.
    if (!/[A-Z0-9"'“‘(\[]/.test(next)) continue;
    if (m[1] === '.') {
      const word = /([A-Za-z.]+)$/.exec(text.slice(start, m.index!))?.[1] ?? '';
      if (ABBREVIATIONS.has(word.toLowerCase()) || /^[A-Za-z]$/.test(word)) continue;
    }
    out.push(text.slice(start, stop).trim());
    start = m.index! + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Adds a full stop when a block of text doesn't end with punctuation, so the voice pauses. */
export function closeSentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  return /[.!?:;…]["'”’)\]]*$/.test(t) ? t : t + '.';
}
