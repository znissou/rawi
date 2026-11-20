import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AudioCache } from './audio/cache';
import { Narrator, ReadItem, SpeechSource } from './audio/narrator';
import { createPlayer } from './audio/player';
import { SharedVoice } from './audio/sharedVoice';
import { Reply, ReplyStore } from './claude/store';
import { TranscriptWatcher, WatchedReply, folderFilters } from './claude/watcher';
import { config } from './config';
import { expiryNotice, expiryText } from './engines/expiry';
import { KOKORO, KokoroEngine } from './engines/kokoro';
import { OpenRouter, OpenRouterError, SpeechModel } from './engines/openrouter';
import { SystemVoice } from './engines/systemVoice';
import { DOWNLOAD_MB, downloadKokoro, findKokoro } from './kokoro/files';
import { speakableText } from './text/speakable';
import { pickAutoRead, pickModel, pickMute, pickSpeed, pickVoice } from './ui/pickers';
import { RepliesView } from './ui/repliesView';
import { StatusBar, shortDate } from './ui/statusBar';
import { Logger, errorText } from './util/log';

const KEY_SECRET = 'rawi.openrouter.apiKey';

class PaidModelError extends Error {}

let cleanup: (() => void) | undefined;

/**
 * When two VS Code windows follow the same session, only the first to claim a reply reads it.
 * The claim is a file created exclusively; a failure other than "already there" never blocks reading.
 */
const CLAIMS = path.join(os.tmpdir(), 'rawi-claims');
function claim(replyId: string): boolean {
  try {
    fs.mkdirSync(CLAIMS, { recursive: true });
    fs.writeFileSync(path.join(CLAIMS, crypto.createHash('sha1').update(replyId).digest('hex')), String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EEXIST';
  }
}
function pruneClaims(): void {
  fs.promises.readdir(CLAIMS).then((names) => Promise.all(names.map(async (n) => {
    const file = path.join(CLAIMS, n);
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (st && Date.now() - st.mtimeMs > 24 * 60 * 60_000) await fs.promises.rm(file, { force: true });
  }))).catch(() => undefined);
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Rawi', { log: true });
  ctx.subscriptions.push(channel);
  const log: Logger = {
    info: (m) => channel.info(m),
    warn: (m) => channel.warn(m),
    error: (m, e) => channel.error(e === undefined ? m : `${m}: ${errorText(e)}`),
  };

  // ---- API key: VS Code's secret storage, or OPENROUTER_API_KEY ----
  let storedKey = await ctx.secrets.get(KEY_SECRET);
  const hasKey = () => Boolean(storedKey || process.env.OPENROUTER_API_KEY);
  const openrouter = new OpenRouter(async () => storedKey || process.env.OPENROUTER_API_KEY || undefined);

  // ---- state shared by the pieces below ----
  const store = new ReplyStore();
  const cache = new AudioCache(path.join(ctx.globalStorageUri.fsPath, 'audio-cache'), log);
  const tempDir = path.join(os.tmpdir(), `rawi-${process.pid}`);
  let modelInfo: SpeechModel | undefined;
  const mutedUntil = () => ctx.globalState.get<number>('rawi.mutedUntil') ?? 0;
  let status: StatusBar | undefined;
  let view: RepliesView | undefined;

  // ---- reading ----
  // eslint-disable-next-line prefer-const
  let narrator: Narrator;
  /** Bumped whenever reading is stopped, so a reply waiting for another window's voice is dropped. */
  let stops = 0;
  // One voice for all VS Code windows: what another window reads shows here, and Stop reaches it.
  const shared = new SharedVoice({
    dir: path.join(os.tmpdir(), 'rawi-voice'),
    onCommand: (c) => {
      if (c === 'stop') {
        stops++;
        narrator.stop();
      } else if (c === 'pauseResume') {
        narrator.pauseResume();
      } else if (c === 'skipForward') {
        narrator.skipForward();
      } else {
        narrator.skipBack();
      }
    },
    onRemoteChange: () => status?.update(),
  });
  const player = createPlayer(ctx.extensionPath, {
    started: (id) => narrator.onStarted(id),
    ended: (id) => narrator.onEnded(id),
    error: (message) => {
      log.warn(`Audio: ${message}`);
      narrator.onPlayerError();
    },
  }, log);
  player.setVolume(config.volume);

  /**
   * Paid models only with rawi.openrouter.allowPaid. A model whose price can't be checked isn't used:
   * when OpenRouter's list was never fetched and can't be now, that error stops the reading here.
   */
  async function refuseUnwantedPaid(model: string): Promise<void> {
    if (config.allowPaid || model.endsWith(':free')) return;
    const info = await openrouter.model(model);
    if (info && !info.free) throw new PaidModelError(`${info.name} is a paid model, and paid models are turned off.`);
  }

  // OpenRouter's voices, streamed, with replays from the cache.
  const openRouterVoice: SpeechSource = {
    async stream(text, item, signal, onAudio) {
      const model = item.model ?? config.model;
      const voice = item.voice ?? config.voice;
      const checkStart = Date.now();
      await refuseUnwantedPaid(model);
      if (Date.now() - checkStart > 100) log.info(`Checking the model's price took ${Date.now() - checkStart} ms.`);
      const key = AudioCache.key('openrouter', model, voice, text);
      const hit = await cache.get(key);
      if (hit) {
        onAudio(hit.pcm, { rate: hit.rate, channels: hit.channels });
        return { cached: true };
      }
      const parts: Buffer[] = [];
      let format = { rate: 24000, channels: 1 };
      await openrouter.speakStream(text, model, voice, signal, (pcm, f) => {
        parts.push(pcm);
        format = f;
        onAudio(pcm, f);
      });
      void cache.put(key, { pcm: Buffer.concat(parts), ...format });
      return { cached: false };
    },
  };
  // The backup voice: Windows' own, through the audio helper (none on other systems yet).
  const systemVoice = player.synthesize
    ? new SystemVoice((text, file) => player.synthesize!(text, file), tempDir)
    : undefined;
  // Kokoro on this computer, in its own process (the files are Read Aloud's copy, or rawi's download).
  const storageDir = ctx.globalStorageUri.fsPath;
  const kokoro = new KokoroEngine({
    workerPath: path.join(ctx.extensionPath, 'dist', 'kokoro-worker.js'),
    files: () => findKokoro(config.kokoroFolder, storageDir),
    threads: () => config.kokoroThreads,
    voice: () => config.kokoroVoice,
    speed: () => config.speed,
    log,
    onStart: (pid) => player.fullSpeed?.(pid),
  });
  // The main voice: OpenRouter or Kokoro, as set in rawi.engine (voice samples say which themselves).
  const isLocal = (item: ReadItem) => item.model === KOKORO || (!item.model && config.engine === 'kokoro');
  const primary: SpeechSource = {
    stream: (text, item, signal, onAudio) => (isLocal(item) ? kokoro : openRouterVoice).stream(text, item, signal, onAudio),
  };
  /** Tries each voice in turn, until one speaks. */
  const chain = (...voices: SpeechSource[]): SpeechSource => ({
    async stream(text, item, signal, onAudio) {
      let last: unknown;
      for (const v of voices) {
        let spoke = false;
        try {
          return await v.stream(text, item, signal, (pcm, format) => {
            spoke = true;
            onAudio(pcm, format);
          });
        } catch (err) {
          if (spoke || signal.aborted) throw err;
          last = err;
          log.warn(`The backup voice failed (${errorText(err)}); trying the next one.`);
        }
      }
      throw last;
    },
  });
  const kokoroVoice: SpeechSource = { stream: (text, item, signal, onAudio) => kokoro.stream(text, item, signal, onAudio) };
  /** When the main voice fails or is too slow: Kokoro (then Windows' voice), or Windows' voice. */
  function backupVoice(): SpeechSource | undefined {
    if (config.fallback === 'none') return undefined;
    if (config.fallback === 'kokoro' && config.engine !== 'kokoro' && kokoro.available) {
      return systemVoice ? chain(kokoroVoice, systemVoice) : kokoroVoice;
    }
    return systemVoice;
  }
  /** What the backup voice is, for messages. */
  const backupName = () => (config.fallback === 'kokoro' && config.engine !== 'kokoro' && kokoro.available ? 'Kokoro' : "Windows' voice");
  let toldAboutSlowVoice = false;

  narrator = new Narrator({
    player,
    primary,
    backup: backupVoice,
    // Kokoro is never "too slow": a long first sentence just takes a few seconds. It falls back only when it fails.
    fallbackAfterMs: (item) => (isLocal(item) ? 0 : config.fallbackAfterMs),
    speakOptions: () => config.speakOptions,
    speed: () => config.speed,
    tempDir,
    log,
    onState: () => {
      const st = narrator.state;
      if (st.kind === 'idle') {
        shared.release();
      } else {
        const reading = { title: st.item.title, kind: st.kind, index: st.index, count: st.count };
        if (!shared.update(reading)) shared.tryClaim(reading);
      }
      status?.update();
      view?.refresh();
    },
    onError: (err, item, fellBack) => report(err, item, fellBack),
    onSlowFallback: (_item, waitedMs) => {
      if (toldAboutSlowVoice) return;
      toldAboutSlowVoice = true;
      void vscode.window.showInformationMessage(
        `Rawi: the main voice sent nothing for ${(waitedMs / 1000).toFixed(1)} s, so ${backupName()} read the rest of the reply. The next reply tries the main voice again.`,
        'Change the Wait')
        .then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'rawi.fallbackAfter'));
    },
  });

  // ---- errors: say what went wrong once a minute at most, with the fix one click away ----
  const lastShown = new Map<string, number>();
  function report(err: unknown, item: ReadItem, fellBack: boolean): void {
    const kind = err instanceof OpenRouterError ? err.kind : err instanceof PaidModelError ? 'paid' : 'other';
    // A passing hiccup the backup voice covered is only logged; things to fix are shown.
    if (fellBack && ['rateLimit', 'network', 'server'].includes(kind)) return;
    if ((lastShown.get(kind) ?? 0) > Date.now() - 60_000) return;
    lastShown.set(kind, Date.now());
    const actions: Record<string, string[]> = {
      noKey: ['Set API Key'], auth: ['Set API Key'], credits: ['Choose Model'], notFound: ['Choose Model'],
      badRequest: ['Choose Voice', 'Choose Model'], format: ['Choose Model'], paid: ['Choose Model', 'Allow Paid Models'],
      other: ['Show Log'],
    };
    const where = item.id.startsWith('sample:') ? 'the voice sample' : `"${item.title}"`;
    const message = fellBack
      ? `Rawi: the main voice failed, so ${backupName()} read ${where}. ${errorText(err)}`
      : `Rawi couldn't read ${where}. ${errorText(err)}`;
    let buttons = actions[kind] ?? [];
    if (kind === 'badRequest' && /\bmodel\b/i.test(errorText(err))) buttons = ['Choose Model', 'Choose Voice']; // the fix first
    void vscode.window.showWarningMessage(message, ...buttons)
      .then((choice) => {
        if (choice === 'Set API Key') void vscode.commands.executeCommand('rawi.setApiKey');
        else if (choice === 'Choose Model') void vscode.commands.executeCommand('rawi.chooseModel');
        else if (choice === 'Choose Voice') void vscode.commands.executeCommand('rawi.chooseVoice');
        else if (choice === 'Allow Paid Models') void config.set('openrouter.allowPaid', true);
        else if (choice === 'Show Log') channel.show(true);
      });
  }

  // ---- UI ----
  /** Kokoro needs no key; OpenRouter does. */
  const canSpeak = () => config.engine === 'kokoro' || hasKey();
  status = new StatusBar({
    state: () => narrator.state,
    remote: () => shared.remote(),
    hasKey: canSpeak,
    mutedUntil,
    autoRead: () => config.autoRead,
    voice: () => (config.engine === 'kokoro' ? kokoroName(config.kokoroVoice) : config.voice || 'Default'),
    speed: () => config.speed,
    model: () => config.engine === 'kokoro'
      ? { id: 'Kokoro, on this computer' }
      : { id: config.model, info: modelInfo?.id === config.model ? modelInfo : undefined },
  });

  /** Finds Kokoro's files (or downloads them), checks that it speaks, then asks how to use it. */
  async function setUpKokoro(askHowToUse = true): Promise<boolean> {
    let files = findKokoro(config.kokoroFolder, storageDir);
    if (!files) {
      const go = await vscode.window.showWarningMessage(
        `Kokoro needs a one-time download of ${DOWNLOAD_MB} MB: the model and its voices, from the kokoro-onnx release on GitHub. After that it works offline.`,
        { modal: true }, 'Download');
      if (go !== 'Download') return false;
      try {
        files = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Rawi: downloading Kokoro', cancellable: true },
          async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            let shown = 0;
            return downloadKokoro(storageDir, (done, total) => {
              const pct = Math.floor((done / total) * 100);
              if (pct > shown) {
                progress.report({ increment: pct - shown, message: `${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB` });
                shown = pct;
              }
            }, abort.signal);
          });
      } catch (err) {
        void vscode.window.showErrorMessage(`Rawi: Kokoro couldn't be downloaded. ${errorText(err)}`);
        return false;
      }
    }
    try {
      const ms = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Rawi: starting Kokoro…' },
        () => kokoro.test());
      log.info(`Kokoro test sentence made in ${ms} ms.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Rawi: Kokoro didn't start. ${errorText(err)}`, 'Show Log').then((c) => c && channel.show(true));
      return false;
    }
    if (!askHowToUse) return true;
    const where = files.source === 'readAloud' ? "Read Aloud's copy in ~/.claude/kokoro, so nothing was downloaded"
      : files.source === 'setting' ? files.folder : 'its own download';
    const main = 'As the Main Voice';
    const backup = 'As the Backup Voice';
    const pick = await vscode.window.showInformationMessage(
      `Rawi: Kokoro works (it uses ${where}). How should rawi use it?`, main, backup, 'Not Now');
    if (pick === main) await config.set('engine', 'kokoro');
    else if (pick === backup) await config.set('fallback', 'kokoro');
    return true;
  }
  view = new RepliesView(store, () => narrator.currentId);
  const tree = vscode.window.createTreeView('rawi.replies', { treeDataProvider: view, showCollapseAll: true });
  ctx.subscriptions.push(status, view, tree);

  async function refreshModelInfo(): Promise<void> {
    try {
      modelInfo = await openrouter.model(config.model);
    } catch {
      modelInfo = undefined;
    }
    status?.update();
  }

  /** Free models end (HeyGen Voice Turbo's free tier on 2026-11-30): warn 3 days ahead, once a day. */
  async function checkExpiry(): Promise<void> {
    if (config.engine === 'kokoro') return; // nothing expires on this computer
    let info: SpeechModel | undefined;
    try {
      info = await openrouter.model(config.model);
    } catch {
      return;
    }
    const notice = info?.free ? expiryNotice(info.expires, new Date()) : undefined;
    if (!info?.expires || !notice) return;
    const stamp = `${info.id}|${new Date().toDateString()}`;
    // Every window checks, and they often check together (start-up, a changed setting), before the
    // shared state has caught up: the claim lets one window warn.
    if (ctx.globalState.get('rawi.expiryWarned') === stamp || !claim(`expiry:${stamp}`)) return;
    await ctx.globalState.update('rawi.expiryWarned', stamp);
    log.info(`The free model ${info.id} ends on ${info.expires}.`);
    const choice = await vscode.window.showWarningMessage(
      `Rawi: ${expiryText(info.name, shortDate(info.expires), notice.daysLeft)} Choose another voice model?`,
      'Choose Model', 'Later');
    if (choice === 'Choose Model') void vscode.commands.executeCommand('rawi.chooseModel');
  }

  // ---- replies ----
  const toItem = (r: Reply): ReadItem => ({ id: r.id, title: r.title || 'Claude Code reply', markdown: r.text });
  let toldAboutKey = false;

  /**
   * Reads `item` in this window, with one voice for all windows. `asked`: the user just asked for it,
   * so it interrupts what's being read, here or in another window. Otherwise (auto-read) it follows
   * rawi.whenBusy, in another window too: "queue" waits for that reading to end.
   */
  async function speak(item: ReadItem, asked: boolean): Promise<void> {
    const whenBusy = asked ? 'interrupt' : config.whenBusy;
    if (!shared.mine) {
      const gen = stops;
      const placeholder = { title: item.title, kind: 'loading' as const, index: 0, count: 0 };
      if (!(await shared.acquire(placeholder, whenBusy === 'interrupt', () => stops !== gen))) return;
    }
    narrator.read(item, whenBusy);
    if (narrator.state.kind === 'idle') shared.release(); // nothing to read in it
  }

  function onReply(r: WatchedReply): void {
    if (!store.add(r) || r.history || r.interrupted) return;
    log.info(`Reply finished in "${r.title || r.sessionId.slice(0, 8)}" (${r.text.length} characters).`);
    const mode = config.autoRead;
    const auto = mode === 'always' || (mode === 'whenAway' && !vscode.window.state.focused);
    if (auto && mutedUntil() <= Date.now() && canSpeak()) {
      if (claim(r.id)) void speak(toItem(r), false);
      else log.info('Another VS Code window is reading this reply.');
      return;
    }
    status?.flashNewReply();
    if (auto && !canSpeak() && !toldAboutKey) {
      toldAboutKey = true;
      void vscode.window.showInformationMessage(
        'Claude Code finished a reply. To hear it, set an OpenRouter API key, or set up Kokoro, a free voice that runs on this computer.',
        'Set API Key', 'Use Local Voice')
        .then((c) => c && vscode.commands.executeCommand(c === 'Set API Key' ? 'rawi.setApiKey' : 'rawi.setUpKokoro'));
    }
  }

  let watcher: TranscriptWatcher | undefined;
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  function startWatcher(): void {
    watcher?.stop();
    store.clear();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const all = config.scope === 'all';
    if (!all && !folders.length) log.info('No folder is open, so this window follows no Claude Code session. Set rawi.scope to "all" to follow every session.');
    const filter = all ? { wantDir: () => true, wantCwd: () => true } : folderFilters(folders);
    watcher = new TranscriptWatcher({
      projectsDir,
      ...filter,
      which: () => config.which,
      log,
      onReply,
      onPrompt: (sessionId, _cwd, at, byUser) => {
        // Claude is about to work: have Kokoro loaded by the time the reply comes, when the reply
        // will be read without asking, and in one window only.
        const usesKokoro = config.engine === 'kokoro' || config.fallback === 'kokoro';
        if (usesKokoro && config.autoRead !== 'off' && (!at || claim(`warm:${sessionId}:${at}`))) kokoro.warmUp();
        // Only a prompt the user sent stops the reading. Claude Code also sends some itself: when a
        // background task finishes (often while the reply before it is still being read) or it compacts.
        if (!byUser || !config.stopOnPrompt) return;
        stops++; // also drops a reply waiting here for another window's reading to end
        const reading = narrator.currentId;
        if (reading && !reading.startsWith('sample:')) {
          log.info('You sent a new prompt: stopped reading.');
          narrator.stop();
        } else if (shared.send('stop')) {
          log.info('You sent a new prompt: stopped the reading in another window.');
        }
      },
      onTitle: (sessionId, title) => store.setTitle(sessionId, title),
    });
    void watcher.start();
  }

  // ---- commands ----
  const replyFrom = (arg: unknown): Reply | undefined => {
    if (typeof arg === 'string') return store.get(arg);
    const node = arg as { kind?: string; reply?: Reply } | undefined;
    return node?.kind === 'reply' ? node.reply : undefined;
  };
  const readLast = () => {
    const last = store.latest();
    if (!last) {
      void vscode.window.showInformationMessage('Rawi: no Claude Code reply yet in this window\'s folders.');
      return;
    }
    void speak(toItem(last), true);
  };
  const command = (id: string, fn: (...args: unknown[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const readingHere = () => narrator.state.kind !== 'idle';

  command('rawi.readLastReply', readLast);
  command('rawi.pauseResume', () => {
    // Pauses the reading here or in another window; with none, the same key starts the last reply.
    if (!narrator.pauseResume() && !shared.send('pauseResume')) readLast();
  });
  command('rawi.stop', () => {
    stops++;
    narrator.stop();
    shared.send('stop');
  });
  command('rawi.skipForward', () => (readingHere() ? narrator.skipForward() : shared.send('skipForward')));
  command('rawi.skipBack', () => (readingHere() ? narrator.skipBack() : shared.send('skipBack')));
  command('rawi.playReply', (arg) => {
    const r = replyFrom(arg);
    if (!r) return;
    if (narrator.currentId === r.id) narrator.pauseResume(); // clicking the reply being read pauses it
    else void speak(toItem(r), true);
  });
  command('rawi.copyReply', async (arg) => {
    const r = replyFrom(arg);
    if (r) await vscode.env.clipboard.writeText(r.text);
  });
  command('rawi.showSpeakable', async (arg) => {
    const r = replyFrom(arg);
    if (!r) return;
    const doc = await vscode.workspace.openTextDocument({ content: speakableText(r.text, config.speakOptions), language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  command('rawi.readSelection', () => {
    const editor = vscode.window.activeTextEditor;
    const text = editor?.document.getText(editor.selection).trim();
    if (!editor || !text) return;
    // Markdown is read like a reply; anything else as written: a text file by paragraph, code by line.
    const lang = editor.document.languageId;
    const plain = lang === 'markdown' ? undefined : lang === 'plaintext' ? 'prose' : 'code';
    void speak({ id: `selection:${Date.now()}`, title: 'Selection', markdown: text, plain }, true);
  });
  command('rawi.readClipboard', async () => {
    const text = (await vscode.env.clipboard.readText()).trim();
    if (!text) {
      void vscode.window.showInformationMessage('Rawi: the clipboard has no text.');
      return;
    }
    void speak({ id: `clipboard:${Date.now()}`, title: 'Clipboard', markdown: text }, true);
  });
  command('rawi.setAutoRead', () => pickAutoRead());
  command('rawi.mute', () => pickMute(ctx.globalState, () => status?.update()));
  command('rawi.chooseModel', () => pickModel(openrouter, { available: () => kokoro.available, setUp: () => setUpKokoro(false) }));
  // Voice samples take the voice like any reading the user asks for.
  const samples = {
    read: (item: ReadItem) => void speak(item, true),
    stop: () => narrator.stop(),
    get currentId() {
      return narrator.currentId;
    },
  };
  command('rawi.chooseVoice', () => pickVoice(openrouter, samples));
  command('rawi.setUpKokoro', () => setUpKokoro());
  command('rawi.setSpeed', () => pickSpeed());
  command('rawi.showReplies', () => vscode.commands.executeCommand('rawi.replies.focus'));
  command('rawi.showLog', () => channel.show(true));
  command('rawi.setApiKey', async () => {
    const key = (await vscode.window.showInputBox({
      title: 'Rawi: OpenRouter API key',
      prompt: 'Kept in VS Code\'s secret storage, never in your settings. Create one at openrouter.ai/keys.',
      placeHolder: 'sk-or-v1-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith('sk-or-') ? undefined : 'OpenRouter keys start with sk-or-'),
    }))?.trim();
    if (!key) return;
    try {
      const info = await openrouter.keyInfo(key);
      await ctx.secrets.store(KEY_SECRET, key);
      storedKey = key;
      const left = info.freeRequestsLeft !== undefined ? ` Free-model requests left today: ${info.freeRequestsLeft}.` : '';
      void vscode.window.showInformationMessage(`Rawi: key saved.${left}`);
    } catch (err) {
      if (err instanceof OpenRouterError && err.kind === 'auth') {
        void vscode.window.showErrorMessage('Rawi: OpenRouter rejected this key. Nothing was saved.');
        return;
      }
      await ctx.secrets.store(KEY_SECRET, key);
      storedKey = key;
      void vscode.window.showWarningMessage(`Rawi: key saved, but it couldn't be checked now (${errorText(err)}).`);
    }
    status?.update();
  });
  command('rawi.removeApiKey', async () => {
    const yes = 'Remove';
    if (await vscode.window.showWarningMessage('Remove the OpenRouter API key from VS Code?', { modal: true }, yes) !== yes) return;
    await ctx.secrets.delete(KEY_SECRET);
    storedKey = undefined;
    status?.update();
  });

  // ---- keeping up with changes ----
  ctx.subscriptions.push(
    ctx.secrets.onDidChange(async (e) => {
      if (e.key !== KEY_SECRET) return;
      storedKey = await ctx.secrets.get(KEY_SECRET);
      status?.update();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('rawi')) return;
      if (e.affectsConfiguration('rawi.scope')) startWatcher();
      if (e.affectsConfiguration('rawi.volume')) player.setVolume(config.volume);
      if (e.affectsConfiguration('rawi.openrouter.model')) {
        void refreshModelInfo();
        void checkExpiry();
      }
      status?.update();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => startWatcher()),
  );

  startWatcher();
  shared.start();
  pruneClaims();
  void refreshModelInfo();
  setTimeout(() => player.warmUp(), 1500);
  setTimeout(() => void checkExpiry(), 10_000);
  const expiryTimer = setInterval(() => void checkExpiry(), 6 * 60 * 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(expiryTimer) });
  log.info(`Rawi ${ctx.extension.packageJSON.version} started; following ${projectsDir}.`);

  if (!canSpeak() && !ctx.globalState.get('rawi.welcomed')) {
    void ctx.globalState.update('rawi.welcomed', true);
    void vscode.window.showInformationMessage(
      'Rawi reads Claude Code\'s replies aloud. Add an OpenRouter API key for its cloud voices, or set up Kokoro, a free voice that runs on this computer.',
      'Set API Key', 'Use Local Voice', 'Later')
      .then((c) => c && c !== 'Later' && vscode.commands.executeCommand(c === 'Set API Key' ? 'rawi.setApiKey' : 'rawi.setUpKokoro'));
  }

  cleanup = () => {
    watcher?.stop();
    narrator.dispose();
    shared.dispose();
    player.dispose();
    kokoro.dispose();
  };
}

export function deactivate(): void {
  cleanup?.();
}

/** af_heart -> "Heart" */
function kokoroName(voice: string): string {
  const n = voice.replace(/^[a-z]{2}_/, '');
  return n ? n[0].toUpperCase() + n.slice(1) : voice;
}
