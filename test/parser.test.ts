import { describe, expect, it } from 'vitest';
import { SessionParser } from '../src/claude/parser';
import { assistant, compactSummary, notification, prompt, text, think, title, tool, toolResult } from './fixtures';

function run(entries: object[], which: 'final' | 'all' = 'final') {
  const p = new SessionParser(() => which);
  const events = entries.flatMap((e) => p.feed(e));
  return { p, events, reply: p.flush() };
}

describe('SessionParser', () => {
  it('returns the final answer of a simple turn', () => {
    const { reply, events } = run([prompt('hi'), assistant('m1', [think(), text('Hello there.')], 'end_turn')]);
    expect(events).toEqual([{ kind: 'prompt', at: expect.any(String), byUser: true }]);
    expect(reply?.text).toBe('Hello there.');
    expect(reply?.messageId).toBe('m1');
  });

  it('keeps only the text after the last tool call, or all of it', () => {
    const turn = [
      prompt('fix it'),
      assistant('m1', [text('Let me look.'), tool()], 'tool_use'),
      toolResult(),
      assistant('m2', [think(), text('Found it.'), tool('Edit')], 'tool_use'),
      toolResult(),
      assistant('m3', [think(), text('Done. The bug is fixed.')], 'end_turn'),
    ];
    expect(run(turn).reply?.text).toBe('Done. The bug is fixed.');
    expect(run(turn, 'all').reply?.text).toBe('Let me look.\n\nFound it.\n\nDone. The bug is fixed.');
  });

  it('waits for the text line when a message is written in several lines', () => {
    const p = new SessionParser();
    p.feed(prompt('q'));
    p.feed(assistant('m1', [think()], 'end_turn'));
    expect(p.waiting).toBe(true);
    expect(p.flush()).toBeUndefined(); // no text yet
    p.feed(assistant('m1', [text('The answer.')], 'end_turn'));
    expect(p.flush()?.text).toBe('The answer.');
  });

  it('ignores subagents, meta, synthetic and API-error entries', () => {
    const p = new SessionParser();
    p.feed(prompt('q'));
    p.feed(assistant('s1', [text('subagent talk')], 'end_turn', { sidechain: true }));
    p.feed({ ...prompt('meta'), isMeta: true });
    p.feed({ ...assistant('e1', [text('API Error: overloaded')], 'end_turn'), isApiErrorMessage: true });
    const synthetic = assistant('x1', [text('No response requested.')], 'end_turn');
    synthetic.message.model = '<synthetic>';
    p.feed(synthetic);
    expect(p.waiting).toBe(false);
    expect(p.flush()).toBeUndefined();
  });

  it('hands over a waiting reply as interrupted when a new prompt comes first', () => {
    const p = new SessionParser();
    p.feed(prompt('q'));
    p.feed(assistant('m1', [text('First answer.')], 'end_turn'));
    const events = p.feed(prompt('next question'));
    expect(events[0]).toMatchObject({ kind: 'reply', interrupted: true, reply: { text: 'First answer.' } });
    expect(events[1]).toMatchObject({ kind: 'prompt' });
  });

  it('tells the prompts Claude Code sends itself from the user\'s', () => {
    const p = new SessionParser();
    p.feed(prompt('q'));
    p.feed(assistant('m1', [text('The tests are running in the background.')], 'end_turn'));
    // The task finishes before the reply was flushed: the reply isn't cut short, and the user said nothing.
    expect(p.feed(notification())).toEqual([
      { kind: 'reply', reply: expect.objectContaining({ text: 'The tests are running in the background.' }), interrupted: false },
      { kind: 'prompt', at: expect.any(String), byUser: false },
    ]);
    expect(p.feed(compactSummary())).toEqual([{ kind: 'prompt', at: expect.any(String), byUser: false }]);
    // A notification marked like a typed prompt (promptSource "sdk", seen in real files), or without `origin`.
    expect(p.feed({ ...notification(), promptSource: 'sdk' })).toMatchObject([{ byUser: false }]);
    expect(p.feed({ ...notification(), origin: undefined })).toMatchObject([{ byUser: false }]);
    // The user's own: typed, or an interrupt.
    expect(p.feed({ ...prompt('go on'), promptSource: 'sdk', origin: { kind: 'human' } })).toMatchObject([{ byUser: true }]);
    expect(p.feed(prompt('[Request interrupted by user]'))).toMatchObject([{ byUser: true }]);
  });

  it('does not count tool results as prompts', () => {
    const p = new SessionParser();
    expect(p.feed(toolResult())).toEqual([]);
  });

  it('ignores a late line of a reply it already returned', () => {
    const p = new SessionParser();
    p.feed(prompt('q'));
    p.feed(assistant('m1', [text('Answer.')], 'end_turn'));
    expect(p.flush()?.text).toBe('Answer.');
    p.feed(assistant('m1', [text('Answer.')], 'end_turn'));
    expect(p.waiting).toBe(false);
  });

  it('reports titles and remembers the working folder', () => {
    const p = new SessionParser();
    expect(p.feed(title('Fix the parser'))).toEqual([{ kind: 'title', title: 'Fix the parser' }]);
    expect(p.feed(title('Fix the parser'))).toEqual([]);
    p.feed(prompt('q', 'D:\\code\\x'));
    expect(p.cwd).toBe('D:\\code\\x');
  });
});
