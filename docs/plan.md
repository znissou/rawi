# rawi: build plan

Plan of 2026-11-09; the decisions are in [section 9](#9-decisions). M0 and M1 were done the same day (results under each milestone), and rawi 0.1.0 is installed in the user's VS Code. M2 is next.

The order you set: **OpenRouter with an API key first, local Kokoro after.** The test model is `heygen/heygen-voice-1-turbo:free`.

## 1. What using rawi feels like

- You work with Claude Code as usual. When a turn ends, rawi reads Claude's **final answer** aloud (the text after its last tool call), cleaned up for listening. Code isn't read out; it says "a TypeScript snippet, 12 lines" instead.
- You choose when it reads: **always**, **only when you're away** from VS Code (the window isn't focused), or **only when you ask**.
- To ask, you have:
  - a **▶ button in the status bar**, which reads the latest reply;
  - a **Replies list** with a ▶ next to every reply of your sessions;
  - **keyboard shortcuts**: read last, pause/resume, stop, next and previous sentence;
  - **Read selection** and **Read clipboard**: copy any reply in Claude Code and hear it.
- **Voice, model and speed** are chosen from lists filled live from OpenRouter. Free models come first, and each voice plays a short sample as you move through the list.
- Every option is a normal VS Code setting, so a project can have its own voice or mode (workspace settings).

**One limit to know:** rawi can't put a button inside Claude Code's own chat panel. That panel belongs to another extension, and VS Code doesn't let one extension add to another's views. The status-bar button, the Replies list and the shortcuts replace it. The Replies list can be dragged next to Claude Code's panel.

## 2. Facts checked on 2026-11-09

Earlier findings are in [research-2026-11-09.md](research-2026-11-09.md).

- **Claude Code session files** (version 2.1.319): `~/.claude/projects/<folder>/<session>.jsonl`.
  - The 40 most recent sessions on this machine all came from the VS Code extension (`entrypoint: "claude-vscode"`).
  - A turn's last message has `stop_reason: "end_turn"` and ends with its one text block (985 of the last 991 turns).
  - A `system` line with `subtype: "stop_hook_summary"` follows only because the user has a Stop hook, and it comes about 3 s later. rawi doesn't wait for it (M0).
  - Subagents now write separate files (`<session>/subagents/*.jsonl`), so rawi skips them by not reading those files.
- **OpenRouter speech:** `POST /api/v1/audio/speech`. The models API (`?output_modalities=speech`, no key needed) gives each model's `supported_voices` and `expiration_date`, so the voice list and expiry warnings can be live.
- **HeyGen Voice Turbo (free):**
  - 10 voices: nadine, tabitha, bram, gareth, noelle, meredith, sabrina, lucian, weston, vincent.
  - Returns **raw PCM only**: 44.1 kHz, 16-bit, mono, with the rate given in `Content-Type`. Asking for mp3 returns 400.
  - Streams the audio, requires a voice, and takes up to 5,000 characters per request.
  - **Free until 2026-11-30** (per `expiration_date`).
  - Test: 170 characters gave 10 s of speech, with the first bytes after 1.05 s and the rest at 1.55 s.
- **Speed:** most speech models ignore the `speed` parameter (HeyGen does), so rawi must change speed itself.
- **The key:** 1,000 free-model requests per day, and no spending limit set on it.

## 3. Architecture

**One TypeScript extension.** No Python and no server; nothing to install for the OpenRouter path.

```
~/.claude/projects/*/*.jsonl
        │  new lines
        ▼
 Transcript watcher ──► Reply store ──► status bar · Replies list · commands
        │ turn finished                         │ user asks
        ▼                                       ▼
 Auto-read policy ─────────────────────► Narrator (queue, pause, skip, back)
                                                │
                     Speakable text (Markdown → sentences → chunks)
                                                │
                     Engine: OpenRouter │ OS voice (M2) │ Kokoro (M3)  →  PCM
                                                │
                     Audio: speed (pitch kept), volume, pauses → WAV → cache
                                                │
                     Player: hidden PowerShell (Windows) │ afplay (macOS) │ pw-play/paplay/aplay (Linux)
```

1. **Transcript watcher**
   - Follows the session files of this window's folders, with `fs.watch` plus a 1 s poll as a safety net, and reads only new bytes.
   - Ends a reply 0.3 s after the turn's last message (`end_turn`, with its text) is written (M0).
   - Skips meta lines and API errors, and keeps each session's title (`ai-title`). Old replies are never read at start-up.
   - Ported from the current extension's `transcripts.py` (MIT, credit kept in LICENSE).
2. **Speakable text:** Markdown parsed with markdown-it, then rendered for the ear (rules in section 4). It's split into sentences, aware of abbreviations, then into chunks.
3. **Engines:** one interface, `synthesize(text, voice) → PCM stream + sample rate`.
   - M1: OpenRouter.
   - M2: the OS voice as a zero-install fallback (Windows SAPI, macOS `say`, Linux espeak-ng).
   - M3: local Kokoro, and any OpenAI-compatible server.
4. **Narrator:** the queue.
   - Sends the first sentence alone so speech starts in about a second, then fetches larger chunks while it plays, with at most 2 requests in flight.
   - Handles pause, stop, next and previous sentence, replay, and a new reply arriving while one is being read (queue it, or interrupt).
5. **Audio:** PCM goes through speed change (WSOLA time-stretch, pitch kept), volume, and short pauses between paragraphs, then becomes WAV.
   - The cache keeps the raw PCM, keyed by engine, model, voice and text. Replays and speed changes cost no new request.
6. **Player:** uses what the OS already has.
   - Windows: one long-running hidden PowerShell process. It keeps a single waveOut audio stream and writes each sentence into it.
     - M0 measured: seamless between sentences, Stop in 29 ms, Pause in 5 ms, exact position.
     - The device is opened while speech is being fetched, and closed after a few idle seconds.
   - macOS: `afplay`. Linux: `pw-play`, `paplay` or `aplay`. Checked when those platforms are tested.
   - A custom command (for example `ffplay`) can be set instead.
7. **UI:** status-bar item, Replies view (a native tree view), commands, settings, pickers, and a log channel.

### Why an OS player and not a webview

The extension host (Node) has no audio. A webview could play sound, but only after you open the Rawi view in that window. After each VS Code restart, auto-read would stay silent until you clicked it.

An OS player works from the moment rawi activates, with no view open. And since rawi applies speed and volume itself on raw PCM, the player only needs to play, pause and stop, which every OS has built in. M0 confirmed this on Windows.

**Plan B:** a webview player, if some platform's built-in player falls short. It needs the view opened once per window.

## 4. Reading for the ear

These are the defaults; each rule is a setting.

| In the reply | rawi says |
|---|---|
| A code block | "a TypeScript snippet, 12 lines" (or skips it, or reads it) |
| Inline code, a file path | the name only: `src/audio/player.ts:42` becomes "player.ts, line 42" |
| A link | its text. A bare URL becomes "a link to github.com" |
| A table | "a table with 3 columns, Model, Price and Note, and 5 rows" (or reads it row by row) |
| Headings, list items | separate sentences with a short pause |
| Emoji, decorative symbols | nothing. →, ≥, ≈ and × are read as words |
| A long reply (over 1,500 characters) | full, or a summary by a free OpenRouter text model, or the first paragraph. **The closing question is always read** |

Also: a pronunciation list (`"kubectl": "cube control"`), and camelCase and snake_case split into words.

Example. Claude writes:

> Done. I updated `src/extension.ts` and added [transcript.test.ts](src/test/transcript.test.ts).
> *(a 12-line TypeScript block)*
> Want me to package it?

rawi says: "Done. I updated extension.ts and added transcript.test.ts. Here's a TypeScript snippet, 12 lines. Want me to package it?"

## 5. Settings

| Setting | Default | Values |
|---|---|---|
| `rawi.autoRead` | `always` | `always`, `whenAway`, `off` |
| `rawi.whenBusy` | `queue` | `queue`, `interrupt` (a new reply while one is being read) |
| `rawi.stopOnPrompt` | `true` | stop reading when you send Claude a new prompt |
| `rawi.scope` | `workspace` | `workspace` (sessions in this window's folders), `all` |
| `rawi.engine` | `openrouter` | `openrouter`; later `system`, `kokoro`, `openaiCompatible` |
| `rawi.fallback` | `["system"]` | engines to try when the main one fails (M2) |
| `rawi.openrouter.model` | `heygen/heygen-voice-1-turbo:free` | any speech model |
| `rawi.openrouter.voice` | `nadine` | that model's voices |
| `rawi.openrouter.allowPaid` | `false` | paid models need this on |
| `rawi.openrouter.monthlyCharacterLimit` | `500000` | paid models only, `0` = no limit (≈ $2 a month on HeyGen Turbo paid) |
| `rawi.speed` | `1.0` | 0.5 to 2.0 |
| `rawi.volume` | `100` | 0 to 100 |
| `rawi.read.which` | `final` | `final` (after the last tool call), `all` (also the notes between tool calls) |
| `rawi.read.codeBlocks` | `announce` | `announce`, `skip`, `read` |
| `rawi.read.tables` | `announce` | `announce`, `rows`, `skip` |
| `rawi.read.paths` | `fileName` | `fileName`, `full` |
| `rawi.read.longReplies` | `full` | `full`, `summary`, `firstParagraph` |
| `rawi.read.longReplyLength` | `1500` | characters |
| `rawi.pronunciations` | `{}` | word → how to say it |

The API key is **not** a setting. It lives in VS Code's SecretStorage, set with a command; `OPENROUTER_API_KEY` works too.

## 6. Commands and controls

- **Rawi: Read Last Reply** (`Ctrl+Alt+P`), **Pause / Resume** (`Ctrl+Alt+,`), **Stop** (`Ctrl+Alt+.`), **Skip Forward** (`Ctrl+Alt+/`) and **Skip Back** (`Ctrl+Alt+B`).
  - Pause, stop and skip forward keep Read Aloud's keys.
  - P and B were free among the user's extensions.
- **Read Selection** (editor context menu) and **Read Clipboard**.
- **Auto-Read: Always / When Away / Off**, and **Mute for…** (15 min, 1 h, rest of the day).
- **Choose Model…**: free first, with the price of a typical reply and expiry dates.
- **Choose Voice…** (with samples) and **Set Speed…**.
- **Set OpenRouter API Key**, **Remove Key**, **Show Replies**, **Show Usage**, **Show Log**.
- **Status bar**, one item that shows the state:

  | State | Shows |
  |---|---|
  | Idle | the auto-read mode: `Rawi: auto`, `Rawi: when away` or `Rawi: manual` (click: read last reply) |
  | Fetching | spinner |
  | Reading | `⏸ 2/5` (click: pause) |
  | Paused | `▶ Paused` |
  | Another window reads | `⏸ 2/5 · other window` (click: pause it there; Stop and Skip reach it too) |
  | Muted | `muted 42 min` |
  | Auto-read off | `▶ New reply` for 30 s after a reply |

  Its tooltip holds clickable controls plus the current voice, model and mode.

## 7. Cost, limits, privacy

- **Free first.**
  - The model picker lists free models first.
  - Paid models need `rawi.openrouter.allowPaid` and stop at the monthly character limit, then fall back to the OS voice.
  - Three days before a free model expires, rawi offers to pick another.
- **After 2026-11-30**, when HeyGen's free tier ends, at today's prices:

  | Option | Price | Cost of a 1,500-character reply |
  |---|---|---|
  | HeyGen Turbo, paid | $4 per million characters | $0.006 |
  | Kokoro on OpenRouter (`hexgrad/kokoro-82m`, the same voices as local Kokoro) | $0.62 per million | $0.001 |
  | Fish Audio S2.1 Pro Free | free, no end date listed | none (voices still to test) |
  | Local Kokoro (M3) or the OS voice | free | none |
- **Requests:** about 2 to 5 per reply (the first sentence alone, then large chunks). Replays come from the cache. HeyGen reportedly allows 30 requests per minute.
  - OpenRouter's free models (checked 2026-11-09):
    - 20 requests a minute;
    - 50 a day for accounts that bought less than 10 credits, 1,000 a day otherwise.
  - The user's account has 1,000 a day (30 used that day, by testing).
  - `GET /api/v1/key` reports the day's count in `free_model_daily_requests`.
- **Privacy:**
  - Reply text goes to OpenRouter and the voice provider. Code blocks aren't sent by default, because they're announced, not read.
  - An option routes only to zero-data-retention endpoints; it may exclude free models.
  - Logs record lengths and timings, never text or keys.

## 8. Milestones

### M0: quick checks (done on 2026-11-09)
Details and numbers are in [spikes/m0/README.md](../spikes/m0/README.md).
- **Player: one continuous waveOut stream** in a hidden PowerShell process.
  - Seamless between sentences: Stop in 29 ms, Pause in 5 ms, resume exactly in place.
  - 0% CPU when idle.
  - The simpler SoundPlayer was rejected: it clipped sentence endings and lost track of the position.
- **Speed:** WSOLA in plain JavaScript gives the exact lengths at 1.25× and 1.5× with the pitch unchanged. It takes 0.13 s for 15 s of speech.
- **Reply finished:** speak 0.3 s after the turn's last message is written. `stop_hook_summary` only exists with a Stop hook and comes about 3 s later.
- **Also:**
  - Trim HeyGen's 0.2–0.3 s of silence around each clip.
  - Open the audio device while speech is being fetched. Opening takes 0.3–0.56 s; once it's open, sound starts within 32 ms.

### M1: rawi reads Claude Code's replies with an OpenRouter voice (built on 2026-11-09)
1. **Scaffold:**
   - `package.json` (`rawi`, VS Code `^1.90.0`), strict TypeScript, esbuild, vitest.
   - `.gitignore` (`node_modules`, `dist`, `*.vsix`, `desktop.ini`), and `git init` with `.claude/screenshots/` in `.git/info/exclude`.
   - MIT LICENSE, a README stub, the icon, and a one-colour SVG of the symbol for the activity bar.
2. **Transcript watcher and reply store**, tested against anonymized real session files.
3. **Speakable text v1**, with snapshot tests.
4. **OpenRouter engine:**
   - The key in SecretStorage, and models and voices from the live API (cached for a day).
   - PCM streaming, and clear messages for 401, 402, 404 and 429.
5. **Audio:** WAV, volume, time-stretch, cache.
6. **Windows player:** the waveOut helper from M0, plus a `prepare` command that opens the device early. The macOS and Linux paths are written, but tested later.
7. **Narrator:** queue, fetching ahead, controls.
8. **UI:** status bar, Replies view with ▶ per reply, commands, keys, settings, and model, voice and speed pickers with samples.
9. **Package a VSIX**, install it, and disable Read Aloud for Claude Code.

**Done when:**
- With HeyGen free, a reply starts playing within 2 s of the turn ending.
- Stop and pause react within 0.2 s, and sending a new prompt stops the voice.
- Any earlier reply plays from the Replies list in one click.
- 1.5× speed sounds natural.

**Results** (rawi 0.1.0; 38 unit tests; end-to-end runs in an isolated VS Code with the packaged VSIX):
- **Reply written to first sound:** 1.43 s and 1.44 s when HeyGen answers normally.
  - rawi's own share is about 0.2 s: 0.15 s to notice the turn ended, plus 0.05 s from audio to sound.
  - HeyGen's free tier varied from 0.6 to 5.9 s per request that day, and that sets the rest. A replay from the cache starts in 0.05 to 0.13 s.
- **Sending a new prompt stopped the voice in 64 to 65 ms.**
- **Replies list:** ▶ on an older reply plays it; `Ctrl+Alt+,` pauses and `Ctrl+Alt+.` stops it.
- **Speed:** exact lengths and an unchanged pitch were measured. The user listened and confirmed that 1.25× and 1.5× sound natural, 1.25× most of all.
- **Changes from this plan:**
  - "Next/Previous Sentence" became **Skip Forward/Back**, because they move by piece (one to three sentences).
  - A claim file stops two windows on the same folder from reading the same reply.
  - The settle time is 0.15 s instead of 0.3 s.

### M2: smart and comfortable
**Done in 0.2.0 (2026-11-09)**, measured end to end in an isolated VS Code:
- **Playback while the audio downloads.**
  - Each part becomes chunks of 0.3 to 0.6 s, played back to back. The stretch, resample and trim steps were rewritten to work on audio as it arrives, and give the same result as before.
  - The helper also plays 60 ms of silence when it prepares the device. Opening alone left a 0.53 s delay on the first sound; now it's 0.02 to 0.03 s.
  - Reply written to first sound: 1.17 and 1.27 s with HeyGen. rawi's share after HeyGen's first byte is 0.06 to 0.14 s; it was about 0.4 s.
- **Backup voice:**
  - Windows' System.Speech, with the first English voice. The test machine's default voice is French (Hortense), so Zira is used.
  - It takes over when OpenRouter fails, or sends nothing for `rawi.fallbackAfter` s (3 by default), for the rest of that reply only.
  - Measured: with the wait at 0.3 s, sound came 0.71 s after the reply was written. With a model that doesn't exist, it came 0.97 s after.
- **Expiry warning:** three days before a free model's `expiration_date`, at most once a day. It was unit-tested only, since the date can't be reached in a test.

**Done in 0.3.1 (2026-11-15)**, after the user heard two voices and found the button saying nothing was read:
- **One voice for all VS Code windows** (`src/audio/sharedVoice.ts`).
  - The window that reads owns `%TEMP%\rawi-voice\voice.json`: created exclusively, refreshed every 5 s, deleted when done. Owners whose process is gone or which stop refreshing for 15 s don't count.
  - Other windows show its reading on the button. Their click, Pause, Stop, Skip and keys reach it through `command.json`.
  - Reading the user asks for takes over: the other window is told to stop, and after 2 s the voice is taken anyway. Auto-read follows `rawi.whenBusy` across windows. A prompt stops another window's reading too.
- **The button shows the auto-read mode** when idle (`Rawi: auto`, `when away`, `manual`). On 2026-11-13 the user's `"rawi.autoRead": "off"` had silently gone back to the default, and the button looked the same in every mode.
- **Kokoro is preloaded only when auto-read is on**, in one window (a claim per prompt). Before, every window loaded it on every prompt.
- Checked end to end in a separate VS Code with two windows, 0.3.0 and then 0.3.1. With 0.3.0, clicking window B's button while A read started a second voice. With 0.3.1 it paused A, "Read Last Reply" in B took over, and Stop in A reached B. The screenshots are in `.claude/screenshots/rawi-windows/`.

**Fixed in 0.3.2 (2026-11-16)**, after a review of the whole project:
- **Kokoro after Stop.**
  - The worker got a reading's sentences all at once, and its cancel message didn't get through in time. Running the model blocks the worker, and on Windows a message sent meanwhile is read late: even with a timer turn between sentences, 2 or 3 stopped sentences were still made in 3 of 12 trials. So the next reading waited up to 16.7 s.
  - Now the engine keeps the sentences and sends the next one only when the worker has answered; the cancel message is gone. In 12 stops at different moments, the worker finished exactly one sentence, and the next reading started 0.7 to 3.5 s after the stop. That one sentence can't be interrupted.
  - Cost: 0.9 ms per sentence. First sound with Kokoro loaded is unchanged (0.33 to 0.36 s).
- **Prompts Claude Code sends itself no longer stop the reading.**
  - These are background tasks' notifications (`origin.kind: "task-notification"`; 23 of 278 have `promptSource: "sdk"`, like typed prompts) and compaction summaries (`isCompactSummary`). In the user's session files, 77 notifications came within a minute after a reply, while it would still be read.
  - Replayed through the new parser, all 278 notifications and 58 summaries count as Claude Code's, and every typed prompt, slash command and interrupt as the user's. Kokoro is still loaded ahead for them.
- **Checked end to end** in an isolated VS Code with the packaged VSIX: a notification 4 s into a Kokoro reading left it going; a typed prompt then stopped it, and the next reply's first sound came 0.49 s after rawi started reading it.

**Fixed in 0.3.3 (2026-11-20):** the review's other bugs. CHANGELOG.md lists them for users. For each, a test fails on the 0.3.2 code, except the three marked as checked by reading.
- **Models that list no voices** (Fish Audio S2.1 Pro Free): no `voice` field is sent when the voice is empty. Choosing such a model clears the voice, and Choose Voice accepts an empty answer. Screenshots: `.claude/screenshots/voice-default/`. Fish's speech endpoint itself was not called.
- **Read Selection Aloud** reads code line by line, untouched, and text files by paragraph and list item. Markdown files are read like replies.
- **Units:** the plural looked at the last digit only ("16,731 millisecond").
- **Paid-model guard:** a failed refresh keeps the last model list; with none, a model that isn't `:free` isn't used.
- **Watcher** stopped while starting: it arms nothing and reports nothing.
- **Narrator:** resuming when another window took the voice no longer throws.
- **Audio helper** exit: the reading ends, and pending Windows-voice requests fail at once.
- **Kokoro** that failed to load is stopped, so the next reading tries again (about once per three parts of a reply).
- **Checked by reading only:** a prompt drops a reply waiting for another window's voice; the expiry warning shows in one window (a claim file); picking the same model again keeps a typed voice ID.

**Still open from the review (2026-11-16), none started:**
- Listening: ordered lists lose their numbers; ✅ and ❌ are dropped and their lines run together; "[x]" and struck-out text are read as written; with several windows nothing says which project a reply comes from.
- Slow HeyGen stutter: measure each part's speed, hold playback until enough is buffered, fetch further ahead.
- Start-up reads only the last 2 MB of a session (3 of 9 and 3 of 12 replies found in two long sessions).
- One audio helper per window, about 62 MB each, started with the window and never stopped.
- Package: `DirectML.dll` is 9.4 MB of the 16.4 MB VSIX, and Kokoro spoke without it (tested outside VS Code).
- `npm run package` runs the tests before building, so the worker test checks the previous build.
- Some older tests leave folders in `%TEMP%`; vitest and esbuild have 9 advisories (development only).
- Before a release: download ONNX Runtime and the phonemizer at Kokoro setup instead of shipping them (removes the GPL code and the Windows-only limit); Ctrl+Alt shortcuts collide with AltGr on several layouts; a workspace's settings can turn paid models on.

**Proposal for the rest of M2 (0.4.0), written 2026-11-09, waiting for the user's approval.** Most useful first:
1. **Read Claude's questions and plans.**
   - Today rawi only reads at `end_turn`, so it is silent exactly when Claude waits for the user: when Claude asks through the question dialog (`AskUserQuestion`) or presents a plan (`ExitPlanMode`). Both end with `stop_reason: tool_use`, and the answer comes later as a `tool_result` (checked in real session files).
   - A question is read after Claude's text before it, with its options: "Which database should I use? PostgreSQL, SQLite or MySQL." Option descriptions are skipped. Several questions are read in turn.
   - A plan is read like a reply, after "Claude's plan is ready."
   - Answering stops the voice. Auto-read, When Away and the ▶ button work as they do for replies. Setting: `rawi.read.questions` (on).
   - This replaces the optional `Notification` hook. It needs no change to Claude Code's settings, and the user's own notifier hooks already flag permission prompts.
2. **Pronunciation.**
   - A built-in list of tech words, starting from Read Aloud's 107 entries (MIT): JSON "jason", kubectl "cube control", e.g. "for example". Each entry is checked by ear with HeyGen and Kokoro, and kept only if it helps.
   - The user's own words go in `rawi.pronunciations` (user or workspace settings). **Rawi: Add Pronunciation…** takes a selected word: type how to say it, hear it, save it.
   - camelCase and PascalCase names in inline code are split into words (`switchToBackup` becomes "switch to backup"). All-caps names are checked so they're said as words, not spelled.
   - A review of numbers and symbols: versions (0.3.0), keys (Ctrl+Alt+P), "#12", "50/day", money, percentages.
3. **A shorter first piece.**
   - A first sentence over 160 characters is cut at a comma, semicolon or colon.
   - Kokoro then starts after about 1 s instead of 3.9 s (269 characters, see M3). OpenRouter also answers sooner for shorter text.
   - The join is checked by ear with both voices.
4. **Limits and usage**, before HeyGen's free tier ends on 2026-11-30.
   - A voice that is gone for good (model removed, no credit, key refused) is no longer tried on every reply. rawi says so once, uses the backup voice, and tries again after a settings change or a restart. Today it retries on each reply and warns at most once a minute.
   - **Rawi: Show Usage**, also in the tooltip, shows:
     - characters read this month per voice, and what they cost;
     - OpenRouter's free requests left today (`GET /api/v1/key`, which doesn't count against any limit).
   - A monthly budget for paid voices, in dollars, replacing the character limit in section 5.
     - Setting: `rawi.openrouter.monthlyBudget`, $1 by default.
     - A warning at 80%, and the backup voice once the budget is spent.
     - OpenRouter can also cap the key itself.
   - New accounts get 50 free requests a day (section 7). rawi warns when 10 are left, and uses the backup voice once they're gone.

Later, once a Marketplace release is decided:

5. **Getting Started walkthrough** on VS Code's Welcome page.
   - Steps: OpenRouter or Kokoro, voice and speed with samples, when to read, try it.
   - It also notices Read Aloud for Claude Code and its `speak-pane` plugin and offers to turn them off, so new users don't hear two voices.
6. **Shorter audio, opt-in.** The user said summaries aren't needed.
   - A "Short replies" switch in the tooltip, which reads the first paragraph.
   - An optional summary by a free text model, such as `google/gemma-4-26b-a4b-it:free` (no end date listed). A summary adds a few seconds before speech, and free text endpoints may log or train on what they receive.

### M3: local Kokoro
**Analysis (2026-11-09).** Measured on the user's laptop: i5-13500HX (14 cores, 20 threads), 32 GB, RTX 4050. Two other heavy jobs were using the CPU at the same time, so these figures are under load. Voice `af_heart`.

| Engine | One sentence (52 chars) | Longer text | Memory |
|---|---|---|---|
| Python kokoro-onnx 0.6.1, fp32, all threads (Read Aloud's setup) | 3.7 s | 1.0–1.2× real time | |
| Same, limited to 4 threads | 1.65 s | 1.6–1.7× | |
| kokoro-js 1.2.1, q8 (92 MB) | 7.2 s | 0.5–0.7×: q8 is *slower* than fp32 on this CPU | 0.9 GB |
| kokoro-js 1.2.1, fp32 (326 MB), plain Node | 3.5 s | 1.1–1.4× | 1.1 GB |
| kokoro-js, fp32, inside VS Code's runtime (Electron 43, Node 24.22) | 0.95 s | 1.4× | 1.1 GB |
| kokoro-js, GPU through DirectML | fails: Kokoro's `ConvTranspose` layer isn't supported ("Paramètre incorrect") | | |

- **Same engine underneath.** kokoro-js and the Python setup both run ONNX Runtime on the CPU, so their speeds match. ONNX Runtime for Node has no CUDA build on Windows.
- **Weight of each route:**
  - `onnxruntime-node` is 208 MB for all platforms, of which Windows x64 is 34 MB.
  - kokoro-js also pulls in transformers.js (47 MB), onnxruntime-web (91 MB) and sharp (21 MB), none of which text-to-speech needs.
  - The user's Python setup already has `kokoro-v1.0.onnx` (310 MB) and `voices-v1.0.bin` (27 MB) in `~/.claude/kokoro`.
- **Free cloud option:** `fish-audio/s2.1-pro-free:free` works only with *no* `voice` field. It returns 44.1 kHz PCM, first byte after 1.35 s, all of a 52-character sentence after 2.76 s, and has no end date listed.

**Done in 0.3.0 (2026-11-09),** as proposed below and approved by the user: OpenRouter stays the default main voice; Kokoro can be the main voice ("Kokoro only", for no internet or no credit) or the backup for OpenRouter, and Windows' voice is the last resort.
- **How it works:**
  - The runner is rawi's own, on `onnxruntime-node` 1.21.0 (CPU), in a child process started with VS Code's runtime.
  - Text to phonemes: kokoro-js's normalization and phonemization ported to TypeScript, on `phonemizer` (eSpeak NG in WebAssembly). It gives the same phonemes as kokoro-onnx on the test sentences, and per sentence the audio matches the user's Python Kokoro (correlation 0.998).
  - Each part is sent sentence by sentence; sentences over 300 characters are split at commas. Kokoro applies the speed itself.
- **Files:** Read Aloud's copy in `~/.claude/kokoro` is used when present. Otherwise rawi downloads 354 MB from kokoro-onnx's `model-files-v1.0` release, checked by SHA-256. `rawi.kokoro.folder` points elsewhere.
- **Settings and UI:**
  - Settings: `rawi.engine: kokoro`; `rawi.fallback: kokoro` (Kokoro, then Windows' voice); `rawi.kokoro.voice` (28 English voices); `rawi.kokoro.threads` (4).
  - **Rawi: Set Up Local Voice (Kokoro)** finds or downloads the files, checks that Kokoro speaks, then asks: main voice, backup voice, or not now.
  - The model list has an "On this computer" section, and still opens offline with Kokoro in it.
  - Without an OpenRouter key, the welcome and the status bar offer the local voice.
- **Lifecycle:** the worker is warmed up when the user sends Claude a prompt, and stopped after 10 idle minutes.
- **Found while measuring: Windows power throttling.**
  - About 3 s after the worker started, Windows 11 moved it to the efficiency cores (EcoQoS): 4.4× real time dropped to 2.0×, and stayed there.
  - The audio helper now opts the worker out with `SetProcessInformation(ProcessPowerThrottling)`. Kokoro then holds 4.3 to 4.6× real time (4 threads). The worker sits idle between replies, so this costs nothing while it waits.
- **Kokoro is never "too slow":** the `rawi.fallbackAfter` wait (3 s) applies to OpenRouter only. Kokoro hands over to the backup only when it fails. Before this change, a 269-character first sentence went to Windows' voice after 3.0 s.
- **Measured end to end** (isolated VS Code; time from the reply written to the session file to playback):

  | Case | Time |
  |---|---|
  | Kokoro main voice, first reply after the prompt warmed it | 0.59 to 0.81 s |
  | Second reply, 20 s later | 0.76 s (0.89 s before the throttling fix) |
  | First sentence of 269 characters | 4.1 s, read by Kokoro |
  | OpenRouter failing, Kokoro as backup | 1.47 s |

  The set-up command found Read Aloud's files and made its test sentence in 0.29 s.
- **Memory** (working set): 0.62 GB once the model is loaded, 0.69 GB after a short sentence, 0.95 to 1.0 GB after sentences of 270 to 310 characters (private bytes up to 1.3 GB).
- **Package:** Windows x64 VSIX, 15.6 MB (ONNX Runtime's binaries are 33 MB unpacked).
- **Licences:** `THIRD-PARTY-NOTICES.md` is shipped in the package.
  - **Before any Marketplace release:** `phonemizer` embeds eSpeak NG, which is GPL-3.0-or-later, so `dist/kokoro-worker.js` contains GPL code.
  - Decide how that file is licensed and where its source is offered, or replace the phonemizer.

**Proposed approach (approved by the user on 2026-11-09):**
- A small TypeScript Kokoro runner on `onnxruntime-node`, in its own background process. That keeps the 1.1 GB and the CPU work out of VS Code.
  - It reuses the model files the user already has, and downloads them (337 MB) where they're missing.
  - It's warmed up when the user sends Claude a prompt, and unloaded after 10 idle minutes.
  - It uses Kokoro's own speed control, limits its threads (4 here), and uses a shorter first part.
- Ship the Windows ONNX Runtime (34 MB) in a Windows-specific VSIX.
- Add `rawi.engine` (`openrouter` or `kokoro`). The Windows voice stays the backup when the main voice is slow or fails.
- Other routes considered:
  - kokoro-js as-is: heavier, and can't reuse the existing files.
  - A Python helper: needs Python on other machines.
  - Kokoro-FastAPI: needs Docker or a separate install. Any OpenAI-compatible server can be added later cheaply.
  - The GPU: fails, as shown above.

The original M3 plan follows.
- **Measure first:** time `kokoro-js` (Kokoro in Node through ONNX, model of about 90 MB downloaded on first use) on this machine, for time to first audio and speed relative to real time. Done; see above.
- **Kokoro engine:** runs in a worker thread, shows download progress, uses native speed, and offers the same voice names as `hexgrad/kokoro-82m` on OpenRouter. A device that can't run Kokoro keeps its voice in the cloud for about $0.001 a reply.
- **"OpenAI-compatible server" engine:** Kokoro-FastAPI, LocalAI, OpenAI.
- **Fallback chain**, for example Kokoro, then OpenRouter, then the OS voice.

### M4: later, if wanted
Marketplace and Open VSX release (re-check the name first), other agents (Codex, Gemini CLI, Cursor) through their hooks, and Arabic.

## 9. Decisions

Settled with the user on 2026-11-09:
1. **Icon:** concept 2, "The prompt speaks" (`media/icon.png`, `design/rawi.ico`).
2. **Auto-read is on by default** (`rawi.autoRead: always`).
3. **Long replies are read in full by default.** Shorter audio stays a setting: `rawi.read.longReplies` can be `summary` or `firstParagraph`.
4. **Display name:** "Rawi — Read Aloud for Claude Code".

5. **Player:** the OS's own player (hidden PowerShell on Windows), so replies are read without opening any panel. A player in a VS Code panel is plan B if M0 fails.
6. **Local voice (M3):** Kokoro, run by rawi itself. OpenRouter stays the default. Kokoro can be the only voice (offline, no credit) or the backup for OpenRouter, with Windows' voice as the last resort.

Arabic, other agents and a Marketplace release can wait until after M3.

## 10. Risks

| Risk | What we do |
|---|---|
| Claude Code changes its session-file format (it's undocumented) | A tolerant parser, tests on real files, and the Claude Code version in the log. A Stop hook is plan B |
| The free voice goes away (HeyGen's free tier ends 2026-11-30) | Expiry warning, fallback engine, other free models offered, paid only on opt-in with a cap |
| Playback quirks without an audio API | M0 passed on Windows; macOS and Linux are checked when tested; webview player as plan B |
| 429 errors on shared free capacity | One retry with backoff, then the fallback engine; few requests per reply |
| Two VS Code windows on the same folder read the same reply | Each reply is claimed with a lock file; the first window wins. Since 0.3.1 all windows also share one voice |
| Private code sent to a voice provider | Code isn't read by default, a zero-data-retention option, the key in SecretStorage |

## Appendix: source layout

As built (0.3.0):
```
src/
  extension.ts            activation and wiring
  config.ts               typed settings
  claude/parser.ts        session-file lines → prompts and finished replies
  claude/watcher.ts       follows the session files
  claude/store.ts         recent replies per session
  text/speakable.ts       Markdown → speakable text
  text/sentences.ts       sentence splitting
  text/segments.ts        speakable text → parts (a short first part, then up to 400 characters)
  engines/openrouter.ts   models, voices, speech
  engines/kokoro.ts       the local voice: starts and talks to the worker
  engines/systemVoice.ts  Windows' voice, the backup
  engines/expiry.ts       free-model expiry notice
  kokoro/worker.ts        child process: ONNX Runtime + Kokoro
  kokoro/phonemize.ts     text → phonemes (kokoro-js port)
  kokoro/voices.ts  kokoro/vocab.ts  kokoro/files.ts
  audio/pcm.ts  audio/stream.ts   WAV, trim, time-stretch, resample (batch and streamed)
  audio/cache.ts          speech cache
  audio/player.ts         OS players
  audio/narrator.ts       queue, fetching ahead, backup voice, controls
  ui/statusBar.ts  ui/repliesView.ts  ui/pickers.ts
  util/log.ts
test/                     vitest suites and fixtures
media/win-player.ps1      Windows helper: waveOut playback, Windows' voice, power throttling opt-out
media/icon.png  media/rawi.svg
design/                   icon sources, prompts, make_icons.py, rawi.ico (not shipped)
THIRD-PARTY-NOTICES.md    licences of bundled and adapted work
```
