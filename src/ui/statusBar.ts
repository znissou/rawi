import * as vscode from 'vscode';
import { NarratorState } from '../audio/narrator';
import { Reading } from '../audio/sharedVoice';
import { SpeechModel } from '../engines/openrouter';
import { AutoRead, doingText, statusLook } from './statusText';

export interface StatusInputs {
  state(): NarratorState;
  /** What another VS Code window is reading, if one is. */
  remote(): Reading | undefined;
  hasKey(): boolean;
  mutedUntil(): number;
  autoRead(): AutoRead;
  voice(): string;
  speed(): number;
  model(): { id: string; info?: SpeechModel };
}

/**
 * One status-bar item that shows what rawi is doing and is the main button: read the last reply
 * when idle, pause while reading, here or in another window. Idle, it shows the auto-read mode.
 * Its tooltip holds the other controls and the current voice.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('rawi.status', vscode.StatusBarAlignment.Right, 101);
  private newReplyUntil = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly s: StatusInputs) {
    this.item.name = 'Rawi';
    this.update();
    this.item.show();
    // keeps the mute countdown and the "new reply" hint current
    this.timer = setInterval(() => this.update(), 30_000);
  }

  /** Shows "New reply" for 30 s, for replies that weren't read automatically. */
  flashNewReply(): void {
    this.newReplyUntil = Date.now() + 30_000;
    this.update();
    setTimeout(() => this.update(), 30_500);
  }

  update(): void {
    const state = this.s.state();
    const remote = this.s.remote();
    const now = Date.now();
    const muted = this.s.mutedUntil() > now;
    const look = statusLook({
      state,
      remote,
      hasKey: this.s.hasKey(),
      autoRead: this.s.autoRead(),
      newReply: this.newReplyUntil > now,
      mutedFor: muted ? remaining(this.s.mutedUntil() - now) : undefined,
    });
    this.item.text = look.text;
    this.item.command = look.command;
    this.item.backgroundColor = look.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = this.tooltip(state, remote, muted);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  private tooltip(st: NarratorState, remote: Reading | undefined, muted: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    const link = (label: string, command: string) => `[${label}](command:${command})`;
    if (!this.s.hasKey()) {
      md.appendMarkdown('**Rawi** needs a voice: an OpenRouter API key, or Kokoro on this computer (free, works offline).\n\n'
        + `${link('$(key) Set API key', 'rawi.setApiKey')} &nbsp; ${link('$(device-desktop) Set up local voice', 'rawi.setUpKokoro')}`);
      return md;
    }
    const doing = doingText({ state: st, remote, autoRead: this.s.autoRead() });
    md.appendMarkdown(`**Rawi** · ${escape(doing)}\n\n`);
    md.appendMarkdown([
      link('$(play) Read last reply', 'rawi.readLastReply'),
      link('$(debug-pause) Pause', 'rawi.pauseResume'),
      link('$(debug-stop) Stop', 'rawi.stop'),
      link('$(debug-step-back) Back', 'rawi.skipBack'),
      link('$(debug-step-over) Forward', 'rawi.skipForward'),
    ].join(' &nbsp; ') + '\n\n');
    const m = this.s.model();
    const modelName = m.info ? `${m.info.name}${m.info.free ? (m.info.expires ? `, free until ${shortDate(m.info.expires)}` : ', free') : ''}` : m.id;
    md.appendMarkdown(`Voice: ${link(cap(this.s.voice()), 'rawi.chooseVoice')} · ${link(escape(modelName), 'rawi.chooseModel')}\n\n`);
    md.appendMarkdown(`Speed: ${link(`${this.s.speed()}×`, 'rawi.setSpeed')} · Auto-read: ${link(this.s.autoRead() === 'whenAway' ? 'when away' : this.s.autoRead(), 'rawi.setAutoRead')}`
      + ` · ${link(muted ? 'Unmute…' : 'Mute…', 'rawi.mute')}`);
    return md;
  }
}

function remaining(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}m`;
}

export function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function escape(s: string): string {
  return s.replace(/[[\]()*_`]/g, '\\$&');
}
