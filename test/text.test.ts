import { describe, expect, it } from 'vitest';
import { makeSegments } from '../src/text/segments';
import { splitSentences } from '../src/text/sentences';
import { normalize, plainBlocks, speakableBlocks, speakableText } from '../src/text/speakable';

const say = (md: string, o = {}) => speakableText(md, o);

describe('speakable text', () => {
  it('announces code blocks instead of reading them', () => {
    expect(say('Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```')).toBe('Here:\n\nTypeScript code, 2 lines.');
    expect(say('```bash\nnpm test\n```')).toBe('A shell command.');
    expect(say('```\nfoo\nbar\nbaz\n```')).toBe('A code block, 3 lines.');
    expect(say('```ts\nconst a = 1;\n```', { codeBlocks: 'skip' })).toBe('');
    expect(say('```js\nrun()\n```', { codeBlocks: 'read' })).toBe('run().');
  });

  it('shortens file paths and links', () => {
    expect(say('I updated `src/audio/player.ts:42` and `README.md`.')).toBe('I updated player.ts, line 42 and README.md.');
    expect(say('See [transcript.test.ts](src/test/transcript.test.ts).')).toBe('See transcript.test.ts.');
    expect(say('Docs: https://openrouter.ai/docs/guides/tts for details.')).toBe('Docs: a link to openrouter.ai for details.');
    expect(say('Read [the guide](https://example.com/guide) first.')).toBe('Read the guide first.');
    expect(say('Lines `a/b.ts:10-20` changed.')).toBe('Lines b.ts, lines 10 to 20 changed.');
    expect(say('Set `src/x.ts` here.', { paths: 'full' })).toBe('Set src slash x.ts here.');
  });

  it('reads identifiers and flags as words', () => {
    expect(say('Check `stop_reason` and use `--no-dependencies`.')).toBe('Check stop reason and use no dependencies.');
  });

  it('summarizes tables, or reads their rows', () => {
    const table = '| Model | Price |\n|---|---|\n| HeyGen | free |\n| Kokoro | $0.62 |';
    expect(say(table)).toBe('A table with 2 columns, Model and Price, and 2 rows.');
    expect(say(table, { tables: 'rows' })).toBe('A table. Model: HeyGen, Price: free. Model: Kokoro, Price: $0.62.');
  });

  it('turns headings and list items into sentences', () => {
    expect(speakableBlocks('## Results\n\n- fast start\n- no gaps')).toEqual([
      { kind: 'heading', text: 'Results.' },
      { kind: 'item', text: 'fast start.' },
      { kind: 'item', text: 'no gaps.' },
    ]);
  });

  it('drops emoji and says symbols as words', () => {
    expect(normalize('✅ Done 🎉')).toBe(' Done ');
    expect(say('Tests ✓, lint ✗.')).toBe('Tests yes, lint no.');
    expect(say('Cache → disk, ~5 MB.')).toBe('Cache to disk, about 5 megabytes.');
    expect(say('Speed ≥ 1.5 is fine.')).toBe('Speed at least 1.5 is fine.');
    expect(say('Free until 2026-11-30.')).toBe('Free until November 30, 2026.');
    expect(say('It took 0.4–1.3 s and 250ms.')).toBe('It took 0.4 to 1.3 seconds and 250 milliseconds.');
    expect(say('Play 1.5x faster at 1024×1024.')).toBe('Play 1.5 times faster at 1024 by 1024.');
    expect(say('In the 1990s, MP3s ruled.')).toBe('In the 1990s, MP3s ruled.');
  });

  it('says a unit in the plural unless the whole number is one', () => {
    expect(say('It took 16,731 ms, then 21 s, 1 ms and 1 h.')).toBe('It took 16,731 milliseconds, then 21 seconds, 1 millisecond and 1 hour.');
  });

  it('pauses at an HTML line break', () => {
    expect(say('Use the new API.<br>Press <kbd>Esc</kbd> to stop.')).toBe('Use the new API. Press Esc to stop.');
  });

  it('reads text that isn\'t Markdown as written: code line by line, prose by paragraph', () => {
    const code = '    const run = this.run;\n    if (!run) return;\n\n    # not a heading\n    this.pump(run);';
    expect(plainBlocks(code, 'code').map((b) => b.text)).toEqual(['const run = this.run;', 'if (!run) return;', '# not a heading.', 'this.pump(run);']);
    // code keeps its symbols: in prose "5 - 3" is a range and "->" an arrow
    expect(plainBlocks('const d = 5 - 3;\na -> b', 'code').map((b) => b.text)).toEqual(['const d = 5 - 3;', 'a -> b.']);
    expect(plainBlocks('A wrapped line\nthat goes on.\n\nA second ✅ paragraph', 'prose').map((b) => b.text))
      .toEqual(['A wrapped line that goes on.', 'A second paragraph.']);
    expect(plainBlocks('To do:\n- buy milk\n  and bread\n- call home\n1. then rest', 'prose').map((b) => b.text))
      .toEqual(['To do:', 'buy milk and bread.', 'call home.', '1. then rest.']);
  });

  it('keeps the first paragraph and the closing question of a long reply when asked', () => {
    const long = `${'Intro sentence. '.repeat(10)}\n\n${'Detail sentence here. '.repeat(40)}\n\nShould I commit it?`;
    const blocks = speakableBlocks(long, { longReplies: 'firstParagraph', longReplyLength: 200 });
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'note', 'paragraph']);
    expect(blocks[1].text).toBe('The rest is on screen.');
    expect(blocks[2].text).toBe('Should I commit it?');
    expect(speakableBlocks(long).length).toBe(3);
  });
});

describe('sentences', () => {
  it('splits at sentence ends only', () => {
    expect(splitSentences('Done. I added it. Want me to go on?')).toEqual(['Done.', 'I added it.', 'Want me to go on?']);
    expect(splitSentences('Use e.g. the cache. Then stop.')).toEqual(['Use e.g. the cache.', 'Then stop.']);
    expect(splitSentences('Version 1.5 is out. It works.')).toEqual(['Version 1.5 is out.', 'It works.']);
    expect(splitSentences('It costs $4.00 per million. Fine.')).toEqual(['It costs $4.00 per million.', 'Fine.']);
    expect(splitSentences('Ask Dr. Smith. He knows.')).toEqual(['Ask Dr. Smith.', 'He knows.']);
    expect(splitSentences('See player.ts for it. ok then')).toEqual(['See player.ts for it. ok then']);
  });
});

describe('segments', () => {
  it('starts with one short sentence, then groups sentences up to the limit', () => {
    const blocks = speakableBlocks('Done. I added the transcript watcher and the engine. ' + 'This sentence is about forty-five chars long. '.repeat(12));
    const segs = makeSegments(blocks);
    expect(segs[0].text).toBe('Done. I added the transcript watcher and the engine.');
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(400);
    expect(segs.map((s) => s.text).join(' ')).toBe(blocks[0].text);
    expect(segs[segs.length - 1].pauseAfterMs).toBe(450);
  });

  it('starts a new piece at each heading', () => {
    const segs = makeSegments(speakableBlocks('Intro here.\n\n## Next\n\nMore text.'));
    expect(segs.map((s) => s.text)).toEqual(['Intro here.', 'Next.', 'More text.']);
  });
});
