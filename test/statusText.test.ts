import { describe, expect, it } from 'vitest';
import { NarratorState } from '../src/audio/narrator';
import { doingText, statusLook, StatusFacts } from '../src/ui/statusText';

const idle: NarratorState = { kind: 'idle' };
const item = { id: 'r1', title: 'Login fix', markdown: 'Fixed.' };
const facts = (more: Partial<StatusFacts> = {}): StatusFacts => ({ state: idle, hasKey: true, autoRead: 'always', newReply: false, ...more });

describe('status bar button', () => {
  it('shows the auto-read mode when idle, so a change to it is seen', () => {
    expect(statusLook(facts({ autoRead: 'always' }))).toEqual({ text: '$(unmute) Rawi: auto', command: 'rawi.readLastReply' });
    expect(statusLook(facts({ autoRead: 'whenAway' })).text).toBe('$(unmute) Rawi: when away');
    expect(statusLook(facts({ autoRead: 'off' }))).toEqual({ text: '$(play) Rawi: manual', command: 'rawi.readLastReply' });
  });

  it('shows what this window reads, with pause on click', () => {
    const playing: NarratorState = { kind: 'playing', item, index: 1, count: 4, backup: false };
    expect(statusLook(facts({ state: playing }))).toEqual({ text: '$(debug-pause) Rawi 2/4', command: 'rawi.pauseResume' });
    expect(statusLook(facts({ state: { ...playing, kind: 'paused' } })).text).toBe('$(play) Rawi paused 2/4');
    expect(statusLook(facts({ state: { ...playing, kind: 'loading' } })).command).toBe('rawi.stop');
  });

  it('shows another window\'s reading instead of starting a second voice', () => {
    const remote = { title: 'Login fix', kind: 'playing' as const, index: 0, count: 3 };
    expect(statusLook(facts({ remote }))).toEqual({ text: '$(debug-pause) Rawi 1/3 · other window', command: 'rawi.pauseResume' });
    expect(statusLook(facts({ remote: { ...remote, kind: 'paused' } })).text).toBe('$(play) Rawi paused 1/3 · other window');
    expect(statusLook(facts({ remote: { ...remote, kind: 'loading', count: 0 } }))).toEqual({ text: '$(loading~spin) Rawi · other window', command: 'rawi.stop' });
  });

  it('keeps the key, new-reply and mute states', () => {
    expect(statusLook(facts({ hasKey: false })).command).toBe('rawi.setApiKey');
    expect(statusLook(facts({ autoRead: 'off', newReply: true }))).toEqual({ text: '$(play) New reply', command: 'rawi.readLastReply', warn: true });
    expect(statusLook(facts({ mutedFor: '25m' })).text).toBe('$(mute) Rawi 25m');
  });

  it('says in the tooltip what is read, and where', () => {
    expect(doingText({ state: idle, autoRead: 'off' })).toBe('Ready. Auto-read is off: replies are read when you ask.');
    expect(doingText({ state: idle, autoRead: 'always', remote: { title: 'Login fix', kind: 'paused', index: 1, count: 3 } }))
      .toBe('Paused on "Login fix", part 2 of 3, in another VS Code window. The buttons below work on it.');
  });
});
