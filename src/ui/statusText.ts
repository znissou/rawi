import type { NarratorState } from '../audio/narrator';
import type { Reading } from '../audio/sharedVoice';

export type AutoRead = 'always' | 'whenAway' | 'off';

/** What the status-bar button shows, and what clicking it does. */
export interface StatusLook {
  text: string;
  command: string;
  /** Highlighted, to catch the eye. */
  warn?: boolean;
}

export interface StatusFacts {
  state: NarratorState;
  /** What another VS Code window is reading, if one is. */
  remote?: Reading;
  hasKey: boolean;
  autoRead: AutoRead;
  /** A reply came that wasn't read automatically (shown for 30 s). */
  newReply: boolean;
  /** Time left while muted, such as "25m". */
  mutedFor?: string;
}

/**
 * The button: what this window reads, else what another window reads (the click pauses it there),
 * else the auto-read mode, so a change to it is seen at a glance.
 */
export function statusLook(f: StatusFacts): StatusLook {
  const st = f.state;
  if (!f.hasKey) return { text: '$(key) Rawi', command: 'rawi.setApiKey' };
  if (st.kind === 'loading') return { text: '$(loading~spin) Rawi', command: 'rawi.stop' };
  if (st.kind === 'playing') return { text: `$(debug-pause) Rawi ${st.index + 1}/${st.count}`, command: 'rawi.pauseResume' };
  if (st.kind === 'paused') return { text: `$(play) Rawi paused ${st.index + 1}/${st.count}`, command: 'rawi.pauseResume' };
  const r = f.remote;
  if (r) {
    const part = r.count ? ` ${r.index + 1}/${r.count}` : '';
    if (r.kind === 'loading') return { text: '$(loading~spin) Rawi · other window', command: 'rawi.stop' };
    if (r.kind === 'playing') return { text: `$(debug-pause) Rawi${part} · other window`, command: 'rawi.pauseResume' };
    return { text: `$(play) Rawi paused${part} · other window`, command: 'rawi.pauseResume' };
  }
  if (f.newReply) return { text: '$(play) New reply', command: 'rawi.readLastReply', warn: true };
  if (f.mutedFor) return { text: `$(mute) Rawi ${f.mutedFor}`, command: 'rawi.mute' };
  if (f.autoRead === 'off') return { text: '$(play) Rawi: manual', command: 'rawi.readLastReply' };
  if (f.autoRead === 'whenAway') return { text: '$(unmute) Rawi: when away', command: 'rawi.readLastReply' };
  return { text: '$(unmute) Rawi: auto', command: 'rawi.readLastReply' };
}

/** The first line of the tooltip: what rawi is doing, here or in another window. */
export function doingText(f: Pick<StatusFacts, 'state' | 'remote' | 'autoRead'>): string {
  const st = f.state;
  if (st.kind !== 'idle') {
    return `${st.kind === 'paused' ? 'Paused on' : 'Reading'} "${st.item.title}", part ${st.index + 1} of ${st.count}.`
      + (st.backup ? ' The backup voice is reading it: the main voice failed or was too slow.' : '');
  }
  const r = f.remote;
  if (r) {
    const part = r.count ? `, part ${r.index + 1} of ${r.count}` : '';
    return `${r.kind === 'paused' ? 'Paused on' : 'Reading'} "${r.title}"${part}, in another VS Code window. The buttons below work on it.`;
  }
  if (f.autoRead === 'off') return 'Ready. Auto-read is off: replies are read when you ask.';
  if (f.autoRead === 'whenAway') return 'Ready. Replies are read on their own while VS Code isn\'t focused.';
  return 'Ready. Replies are read on their own as Claude finishes them.';
}
