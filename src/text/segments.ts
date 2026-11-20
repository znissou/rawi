import { splitSentences } from './sentences';
import { SpokenBlock } from './speakable';

/**
 * Groups sentences into the pieces sent to the voice, one request each. The first piece is a
 * single short sentence so speech starts quickly; the next ones gather several sentences (up to
 * `max` characters) so a reply costs few requests. A heading always starts a new piece.
 */

export interface Segment {
  text: string;
  /** Silence after this piece: longer at the end of a paragraph. */
  pauseAfterMs: number;
}

export interface SegmentOptions {
  firstMax: number;
  max: number;
  sentencePauseMs: number;
  paragraphPauseMs: number;
}

const defaults: SegmentOptions = { firstMax: 160, max: 400, sentencePauseMs: 250, paragraphPauseMs: 450 };
const HARD_MAX = 4000; // a voice request takes at most 5,000 characters

export function makeSegments(blocks: SpokenBlock[], options: Partial<SegmentOptions> = {}): Segment[] {
  const o = { ...defaults, ...options };
  const segments: Segment[] = [];
  let current: string[] = [];
  let size = 0;

  const close = (endOfBlock: boolean) => {
    if (!current.length) return;
    segments.push({ text: current.join(' '), pauseAfterMs: endOfBlock ? o.paragraphPauseMs : o.sentencePauseMs });
    current = [];
    size = 0;
  };

  blocks.forEach((block) => {
    if (block.kind === 'heading') close(true);
    const sentences = splitSentences(block.text).flatMap(splitHuge);
    sentences.forEach((sentence, i) => {
      const limit = segments.length === 0 ? o.firstMax : o.max;
      if (size && size + 1 + sentence.length > limit) close(false);
      current.push(sentence);
      size += (size ? 1 : 0) + sentence.length;
      const isLast = i === sentences.length - 1;
      // The first piece is one sentence, or two when the first is tiny ("Done."): the voice's
      // response time grows with the text, so a short first piece starts speech sooner.
      if (segments.length === 0 && (current.length >= 2 || size >= 20 || isLast)) close(isLast);
      else if (block.kind === 'heading' && isLast) close(true);
    });
  });
  close(true);
  return segments;
}

/** A single sentence longer than a request allows is cut at commas, then at spaces. */
function splitHuge(sentence: string): string[] {
  if (sentence.length <= HARD_MAX) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > HARD_MAX) {
    let cut = rest.lastIndexOf(', ', HARD_MAX);
    if (cut < HARD_MAX / 2) cut = rest.lastIndexOf(' ', HARD_MAX);
    if (cut <= 0) cut = HARD_MAX;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}
