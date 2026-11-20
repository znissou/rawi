import * as vscode from 'vscode';
import { ReadItem } from '../audio/narrator';
import { config } from '../config';
import { KOKORO } from '../engines/kokoro';
import { OpenRouter, SpeechModel } from '../engines/openrouter';
import { DOWNLOAD_MB } from '../kokoro/files';
import { describeVoice } from '../kokoro/voices';
import { errorText } from '../util/log';
import { shortDate } from './statusBar';

const TYPICAL_REPLY = 1500; // characters, to show what a paid model costs per reply

/** Plays the voice samples, and stops them when the picker closes without a choice. */
export interface SampleReader {
  read(item: ReadItem, whenBusy: 'queue' | 'interrupt'): void;
  stop(): void;
  readonly currentId: string | undefined;
}

/** Kokoro's English voices (the voices file also has other languages). */
export const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
  'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

interface ModelItem extends vscode.QuickPickItem { model?: SpeechModel; local?: boolean }

export interface LocalVoice {
  available(): boolean;
  /** Finds or downloads Kokoro and checks it speaks; false if the user cancelled or it failed. */
  setUp(): Promise<boolean>;
}

export async function pickModel(openrouter: OpenRouter, local: LocalVoice): Promise<void> {
  const qp = vscode.window.createQuickPick<ModelItem>();
  qp.title = 'Rawi: speech model';
  qp.placeholder = 'Live list from OpenRouter, free models first. Type to filter.';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.show();
  // Offline (or OpenRouter down), the list still offers Kokoro.
  let models: SpeechModel[] = [];
  let loadError: string | undefined;
  try {
    models = await openrouter.speechModels(true);
  } catch (err) {
    loadError = errorText(err);
  }
  const kokoroIsMain = config.engine === 'kokoro';
  // Only the voice in use gets a check mark: OpenRouter's model is kept while Kokoro is the main voice.
  const current = kokoroIsMain ? undefined : config.model;
  const toItem = (m: SpeechModel): ModelItem => ({
    label: `${m.id === current ? '$(check) ' : ''}${m.name}`,
    description: describePrice(m),
    detail: [
      m.voices.length ? `${m.voices.length} voice${m.voices.length === 1 ? '' : 's'}` : 'voice by ID',
      m.free || m.billsOutput ? undefined : `about $${replyCost(m)} for a ${TYPICAL_REPLY.toLocaleString('en-US')}-character reply`,
      m.id,
    ].filter(Boolean).join(' · '),
    model: m,
  });
  const free = models.filter((m) => m.free);
  const paid = models.filter((m) => !m.free);
  const kokoroItem: ModelItem = {
    label: `${kokoroIsMain ? '$(check) ' : ''}Kokoro`,
    description: `free, works offline${local.available() ? '' : ` · one-time ${DOWNLOAD_MB} MB download`}`,
    detail: `${KOKORO_VOICES.length} English voices · runs on this computer, no internet or credit needed`,
    local: true,
  };
  qp.items = [
    { label: 'On this computer', kind: vscode.QuickPickItemKind.Separator },
    kokoroItem,
    ...(loadError
      ? [
        { label: 'OpenRouter', kind: vscode.QuickPickItemKind.Separator },
        { label: "$(warning) OpenRouter's models couldn't be loaded", detail: loadError, alwaysShow: true },
      ]
      : [
        { label: 'Free on OpenRouter', kind: vscode.QuickPickItemKind.Separator },
        ...free.map(toItem),
        { label: config.allowPaid ? 'Paid on OpenRouter' : 'Paid on OpenRouter (turned off: choosing one asks first)', kind: vscode.QuickPickItemKind.Separator },
        ...paid.map(toItem),
      ]),
  ];
  if (loadError) qp.placeholder = 'OpenRouter is out of reach; Kokoro works offline.';
  qp.activeItems = kokoroIsMain || loadError ? [kokoroItem] : qp.items.filter((i) => i.model?.id === current);
  qp.busy = false;

  const picked = await new Promise<ModelItem | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
  });
  qp.dispose();
  if (picked?.local) {
    if (!local.available() && !(await local.setUp())) return;
    await config.set('engine', 'kokoro');
    void vscode.window.showInformationMessage('Rawi: Kokoro on this computer is now the main voice.', 'Choose Voice')
      .then((c) => c && vscode.commands.executeCommand('rawi.chooseVoice'));
    return;
  }
  const chosen = picked?.model;
  if (!chosen) return;
  if (!chosen.free && !config.allowPaid) {
    const allow = 'Allow paid models';
    const cost = chosen.billsOutput
      ? 'it is billed by the length of the audio it makes'
      : `about $${replyCost(chosen)} for a ${TYPICAL_REPLY.toLocaleString('en-US')}-character reply`;
    const answer = await vscode.window.showWarningMessage(
      `${chosen.name} is a paid model: ${cost}, charged to your OpenRouter credits. Allow paid models?`,
      { modal: true }, allow);
    if (answer !== allow) return;
    await config.set('openrouter.allowPaid', true);
  }
  const modelBefore = config.model;
  await config.set('openrouter.model', chosen.id);
  if (config.engine !== 'openrouter') await config.set('engine', 'openrouter');
  if (chosen.voices.length && !chosen.voices.includes(config.voice)) {
    await config.set('openrouter.voice', chosen.voices[0]);
    void vscode.commands.executeCommand('rawi.chooseVoice');
  } else if (!chosen.voices.length && config.voice && chosen.id !== modelBefore) {
    // Another model, one that lists no voices: it speaks with its own (Fish Audio's free one refuses any
    // other). Picking the same model again keeps a voice ID typed for it.
    await config.set('openrouter.voice', '');
  }
}

function describePrice(m: SpeechModel): string {
  if (m.free) return m.expires ? `free until ${shortDate(m.expires)}` : 'free';
  const perMillion = `$${(m.pricePerChar * 1e6).toFixed(2)} per million characters`;
  if (!m.billsOutput) return perMillion;
  return m.pricePerChar > 0 ? `${perMillion}, plus the audio length` : 'billed by audio length';
}

function replyCost(m: SpeechModel): string {
  return (m.pricePerChar * TYPICAL_REPLY).toFixed(4);
}

interface VoiceItem extends vscode.QuickPickItem { voice: string }

export async function pickVoice(openrouter: OpenRouter, narrator: SampleReader): Promise<void> {
  if (config.engine === 'kokoro') return pickKokoroVoice(narrator);
  const modelId = config.model;
  let model: SpeechModel | undefined;
  try {
    model = await openrouter.model(modelId);
  } catch {
    // offline: fall back to typing a voice ID
  }
  const current = config.voice;
  if (!model?.voices.length) {
    const typed = await vscode.window.showInputBox({
      title: 'Rawi: voice',
      prompt: `${model?.name ?? modelId} doesn't list its voices. Enter a voice ID, or leave this empty for the model's own voice.`,
      placeHolder: "The model's own voice",
      value: current,
    });
    if (typed !== undefined) await config.set('openrouter.voice', typed.trim()); // empty: the model's own
    return;
  }
  const qp = vscode.window.createQuickPick<VoiceItem>();
  qp.title = `Rawi: voice for ${model.name}`;
  qp.placeholder = 'Move through the list to hear each voice; Enter chooses it.';
  qp.items = model.voices.map((v) => ({ label: `${v === current ? '$(check) ' : ''}${cap(v)}`, voice: v }));
  qp.activeItems = qp.items.filter((i) => i.voice === current);
  const openedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let accepted = false;
  qp.onDidChangeActive((items) => {
    if (timer) clearTimeout(timer);
    const v = items[0]?.voice;
    if (!v || Date.now() - openedAt < 300) return; // not when the list first opens
    timer = setTimeout(() => {
      narrator.read({ id: `sample:${v}`, title: `Voice sample: ${cap(v)}`, markdown: sample(v), voice: v, model: modelId }, 'interrupt');
    }, 450);
  });
  qp.onDidAccept(async () => {
    accepted = true;
    const v = qp.selectedItems[0]?.voice;
    qp.hide();
    if (v) await config.set('openrouter.voice', v);
  });
  qp.onDidHide(() => {
    if (timer) clearTimeout(timer);
    if (!accepted && narrator.currentId?.startsWith('sample:')) narrator.stop();
    qp.dispose();
  });
  qp.show();
}

function sample(voice: string): string {
  return `Hi, I'm ${cap(voice)}. This is how I'll read Claude's replies to you.`;
}

interface KokoroItem extends vscode.QuickPickItem { voice: string }

/** Kokoro's English voices, each heard as the list moves (made on this computer, so free). */
async function pickKokoroVoice(narrator: SampleReader): Promise<void> {
  const current = config.kokoroVoice;
  const name = (v: string) => cap(v.replace(/^[a-z]{2}_/, ''));
  const qp = vscode.window.createQuickPick<KokoroItem>();
  qp.title = 'Rawi: Kokoro voice (on this computer)';
  qp.placeholder = 'Move through the list to hear each voice; Enter chooses it.';
  qp.matchOnDescription = true;
  qp.items = KOKORO_VOICES.map((v) => ({
    label: `${v === current ? '$(check) ' : ''}${name(v)}`,
    description: describeVoice(v) + (v === 'af_heart' ? ' · Read Aloud\'s voice' : ''),
    voice: v,
  }));
  qp.activeItems = qp.items.filter((i) => i.voice === current);
  const openedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let accepted = false;
  qp.onDidChangeActive((items) => {
    if (timer) clearTimeout(timer);
    const v = items[0]?.voice;
    if (!v || Date.now() - openedAt < 300) return;
    timer = setTimeout(() => {
      narrator.read({ id: `sample:${v}`, title: `Voice sample: ${name(v)}`, markdown: sample(name(v)), voice: v, model: KOKORO }, 'interrupt');
    }, 450);
  });
  qp.onDidAccept(async () => {
    accepted = true;
    const v = qp.selectedItems[0]?.voice;
    qp.hide();
    if (v) await config.set('kokoro.voice', v);
  });
  qp.onDidHide(() => {
    if (timer) clearTimeout(timer);
    if (!accepted && narrator.currentId?.startsWith('sample:')) narrator.stop();
    qp.dispose();
  });
  qp.show();
}

export async function pickSpeed(): Promise<void> {
  const current = config.speed;
  const speeds = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const items = speeds.map((s) => ({
    label: `${s === current ? '$(check) ' : ''}${s}×`,
    description: s === 1 ? 'normal' : undefined,
    speed: s,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Rawi: reading speed',
    placeHolder: 'The pitch stays the same at every speed.',
  });
  if (picked) await config.set('speed', picked.speed);
}

export async function pickAutoRead(): Promise<void> {
  const current = config.autoRead;
  const items = [
    { mode: 'always', label: 'Always', detail: 'Read every reply as soon as Claude finishes a turn.' },
    { mode: 'whenAway', label: 'When away', detail: 'Read replies only while the VS Code window isn\'t focused.' },
    { mode: 'off', label: 'Off', detail: 'Only when you ask: the status bar, the Replies list or Ctrl+Alt+P.' },
  ].map((i) => ({ ...i, label: `${i.mode === current ? '$(check) ' : ''}${i.label}` }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Rawi: read replies automatically?' });
  if (picked) await config.set('autoRead', picked.mode);
}

export async function pickMute(memento: vscode.Memento, changed: () => void): Promise<void> {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const muted = (memento.get<number>('rawi.mutedUntil') ?? 0) > Date.now();
  const items = [
    ...(muted ? [{ label: '$(unmute) Unmute', until: 0 }] : []),
    { label: 'For 15 minutes', until: Date.now() + 15 * 60_000 },
    { label: 'For 1 hour', until: Date.now() + 60 * 60_000 },
    { label: 'For 3 hours', until: Date.now() + 3 * 60 * 60_000 },
    { label: 'Until tomorrow', until: tomorrow },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Rawi: mute automatic reading',
    placeHolder: 'Replies you ask for are still read.',
  });
  if (!picked) return;
  await memento.update('rawi.mutedUntil', picked.until);
  changed();
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
