import * as vscode from 'vscode';
import { ReadWhich } from './claude/parser';
import { SpeakOptions } from './text/speakable';

export type AutoRead = 'always' | 'whenAway' | 'off';

/** rawi's settings, read fresh each time so changes apply at once. */
export const config = {
  get raw(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('rawi');
  },
  get autoRead(): AutoRead {
    return this.raw.get<AutoRead>('autoRead', 'always');
  },
  get whenBusy(): 'queue' | 'interrupt' {
    return this.raw.get<'queue' | 'interrupt'>('whenBusy', 'queue');
  },
  get stopOnPrompt(): boolean {
    return this.raw.get<boolean>('stopOnPrompt', true);
  },
  get scope(): 'workspace' | 'all' {
    return this.raw.get<'workspace' | 'all'>('scope', 'workspace');
  },
  get which(): ReadWhich {
    return this.raw.get<ReadWhich>('read.which', 'final');
  },
  get model(): string {
    return this.raw.get<string>('openrouter.model', 'heygen/heygen-voice-1-turbo:free').trim();
  },
  get voice(): string {
    return this.raw.get<string>('openrouter.voice', 'nadine').trim();
  },
  get allowPaid(): boolean {
    return this.raw.get<boolean>('openrouter.allowPaid', false);
  },
  get speed(): number {
    return clamp(this.raw.get<number>('speed', 1), 0.5, 2);
  },
  get volume(): number {
    return clamp(this.raw.get<number>('volume', 100), 0, 100) / 100;
  },
  /** The main voice: OpenRouter's, or Kokoro on this computer. */
  get engine(): 'openrouter' | 'kokoro' {
    return this.raw.get<'openrouter' | 'kokoro'>('engine', 'openrouter');
  },
  get fallback(): 'systemVoice' | 'kokoro' | 'none' {
    return this.raw.get<'systemVoice' | 'kokoro' | 'none'>('fallback', 'systemVoice');
  },
  get kokoroVoice(): string {
    return this.raw.get<string>('kokoro.voice', 'af_heart').trim() || 'af_heart';
  },
  get kokoroThreads(): number {
    return Math.round(clamp(this.raw.get<number>('kokoro.threads', 4), 1, 32));
  },
  get kokoroFolder(): string {
    return this.raw.get<string>('kokoro.folder', '');
  },
  /** 0: the backup voice only takes over when the main voice fails. */
  get fallbackAfterMs(): number {
    return Math.round(clamp(this.raw.get<number>('fallbackAfter', 3), 0, 30) * 1000);
  },
  get speakOptions(): SpeakOptions {
    const r = this.raw;
    return {
      codeBlocks: r.get('read.codeBlocks', 'announce'),
      tables: r.get('read.tables', 'announce'),
      paths: r.get('read.paths', 'fileName'),
      longReplies: r.get('read.longReplies', 'full'),
      longReplyLength: r.get('read.longReplyLength', 1500),
    };
  },
  /** Saves where the setting is defined now: the workspace if it overrides it there, else the user settings. */
  async set(key: string, value: unknown): Promise<void> {
    const info = this.raw.inspect(key);
    const target = info?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : info?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await this.raw.update(key, value, target);
  },
};

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
