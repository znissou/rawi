# rawi: Claude Code replies, read aloud

**rawi** (Arabic راوي, "the narrator") is a VS Code extension that reads Claude Code's replies aloud, so the user can listen instead of reading. In classical Arabic poetry the *rāwī* memorized a poet's verses and recited them to an audience; here Claude Code writes and rawi recites. Unlike the extension it replaces, rawi must work with **local** voices *or* **cloud** voices through **OpenRouter**, and it must be smart and configurable.

This file hands over from the session where the idea was discussed and the name chosen (2026-11-09). Read it fully before proposing anything. How the current extension works, and OpenRouter's speech API and models, are in [docs/research-2026-11-09.md](docs/research-2026-11-09.md). **rawi 0.3.3 is built and installed** in the user's VS Code (2026-11-20). It reads replies with OpenRouter voices (M1), plays them while they stream, has a backup voice (part of M2), has a local Kokoro voice (M3), shares one voice across VS Code windows (0.3.1), and has the fixes from a code review (0.3.2 and 0.3.3). The plan is [docs/plan.md](docs/plan.md): its section 9 has the decisions, and each milestone has its results. **Next:** choose the main voice before HeyGen's free tier ends on 2026-11-30, then the rest of M2, proposed before building. The open questions below were answered by the plan and M0 to M3, except agents, Arabic and release:
- TypeScript only.
- The OS player.
- OpenRouter first.
- Local voice: rawi's own Kokoro runner, reusing `~/.claude/kokoro`.

## What the user wants
- Hear Claude Code's replies instead of reading them.
- Choose the engine: local (Kokoro, as today) or OpenRouter. Two reasons, in the user's words: OpenRouter sometimes makes a good model free for a while, and some devices can't run Kokoro locally.
- "Smart and configurable": handle replies intelligently, not just read raw text, and expose real settings.
- Replace the installed **Read Aloud for Claude Code** (`abdalrhman-attar.read-aloud-for-claude-code` 0.6.2, MIT licence). It only runs local engines, and Kokoro is its only English voice.
- Other people may use rawi too (the user framed the problem as what "the user" of such an extension can't do), so a Marketplace release is possible. Not decided.

## About the user
- Experienced IT professional, comfortable with code and servers.
- Develops on Windows 11 in VS Code. Node 24 and Python 3.11 are installed.
- Budget-conscious: prefers free and local tools. Ask before using any paid API or service, paid OpenRouter models included.
- Decides step by step. Propose large pieces before building them; when a request is scoped, do only that and report back.

## Decisions (2026-11-09)
- **Name: rawi.** Extension `name` is `rawi`, settings live under `rawi.*`, commands show as "Rawi: …".
- **Display name: "Rawi — Read Aloud for Claude Code"**, confirmed by the user. The bare word doesn't say what the extension does, and people search the Marketplace for "read aloud".
- **Don't use "Claude" as the brand.** It's Anthropic's trademark, and it would box rawi in if other agents are added. "for Claude Code" in the display name and description is fine.
- The name was free on the VS Code Marketplace and Open VSX on 2026-11-09. Re-check before publishing.
- **Order: OpenRouter with an API key first, local Kokoro after** (the user's call).
- **Test model:** `heygen/heygen-voice-1-turbo:free`, voice `nadine`. It returns PCM only and is free until 2026-11-30.
- **The user's key** is among their saved credentials (the OpenRouter entry). It is never written into this repository.
- **What rawi must offer:** reading each reply automatically, **or** reading a chosen reply only when the user asks (a button or similar), plus voice and speed settings. It must be easy to use.
- **Icon: concept 2, "The prompt speaks"**, chosen by the user: a terminal `>` sending out sound waves, aqua to violet on a dark tile. See `design/README.md`.
  - No Arabic script in the icon.
  - The first round's palette (indigo, cream, gold) was rejected as not good.
- **Defaults:**
  - Auto-read is on (`rawi.autoRead: always`).
  - Long replies are read in full; shorter audio (a summary or the first paragraph) is only an option.
- **Player: the OS's own sound player** (a hidden PowerShell process on Windows), chosen by the user, because auto-read must work without opening any panel. A player inside a VS Code panel is the backup.
- **M0 done (2026-11-09).** Details: [spikes/m0/README.md](spikes/m0/README.md).
  - Windows plays through one continuous waveOut stream.
  - Speed uses WSOLA time-stretch.
  - A reply counts as finished shortly after its `end_turn` line (0.15 s since M1), without waiting for `stop_hook_summary`.
- **M1 done (2026-11-09).** Results are in docs/plan.md.
  - The user's setup is done. The OpenRouter key is set.
  - On 2026-11-15 the old Read Aloud system was removed: the extension, its `speak-pane@claude-voice` plugin, and its Python voice server with its login item. That server had kept reading every reply next to rawi.
  - `~/.claude/kokoro` keeps only the two Kokoro model files, which rawi uses.
  - The user confirmed that 1.25× and 1.5× sound natural, 1.25× most of all.
- **0.2.0 (2026-11-09)** added streamed playback, the Windows backup voice and the expiry warning; results are in docs/plan.md under M2.
- **0.3.0 (2026-11-09)** added local Kokoro (M3), approved by the user. Results are in docs/plan.md under M3.
  - OpenRouter stays the default main voice. Kokoro can be the main voice (`rawi.engine: kokoro`, for no internet or no credit) or OpenRouter's backup (`rawi.fallback: kokoro`). Windows' voice is the last resort.
  - Kokoro opts out of Windows power throttling, which otherwise halves its speed after about 3 s.
  - The 3 s "too slow" wait applies to OpenRouter only.
  - **Before any Marketplace release:** `dist/kokoro-worker.js` contains eSpeak NG (GPL-3.0-or-later) through `phonemizer`. See `THIRD-PARTY-NOTICES.md` and plan M3.
- **0.3.1 (2026-11-15):** one voice for all VS Code windows, the auto-read mode on the button, and Kokoro preloaded only for auto-read, in one window. Details are in docs/plan.md under M2.
  - `rawi.scope` is back at its default, `workspace`. The user read on demand (`rawi.autoRead: off`) until 2026-11-15, then switched back to `always` on purpose.
  - Free HeyGen often streams slower than real time (2× to 4× on 2026-11-15). Rawi then stutters: the backup voice only takes over when a part sends no audio at all for `rawi.fallbackAfter`, not when it trickles. A fix was proposed, not built.
- **0.3.2 (2026-11-16): two fixes from a review of the whole project.** Details are in docs/plan.md under M2.
  - Kokoro's worker gets one sentence at a time. Running the model blocks it, so a cancel sent meanwhile came too late, and a stopped reading made the next one wait up to 16.7 s.
  - Prompts Claude Code sends itself (background-task notifications, compaction summaries) no longer stop the reading.
- **0.3.3 (2026-11-20): the review's other bugs,** listed in CHANGELOG.md and in docs/plan.md under M2.
  - Models that list no voices can be used: rawi sends no voice when `rawi.openrouter.voice` is empty.
  - The review's enhancements and ideas were not done; they are listed in docs/plan.md under M2.
- **The repository will be public** (the user's decision, 2026-11-20). Keep personal details, real paths and keys out of every file, and commit with the repository's own no-reply email.
- **Next: the main voice after 2026-11-30.** HeyGen's free tier ends then.
  - On 2026-11-16 OpenRouter's only other free speech model was still `fish-audio/s2.1-pro-free:free`, with no end date. Since 0.3.3 it can be chosen in rawi: test its sound, speed and audio format; else Kokoro becomes the main voice.
- **Then the rest of M2.** The proposal for 0.4.0 is in docs/plan.md (M2), written 2026-11-09 and waiting for the user's approval.
  - Proposed for 0.4.0: read Claude's questions and plans, pronunciation, a shorter first piece, limits and usage.
  - The walkthrough and shorter audio wait for a release decision.
  - The `Notification` hook was dropped.

## Working on rawi
- **Build:** `npm run package` type-checks, runs the vitest suite, bundles with esbuild and writes `rawi-win32-x64-<version>.vsix` (Windows x64 only, because it carries ONNX Runtime's Windows binaries).
- **Install:** `code --install-extension rawi-win32-x64-<version>.vsix --force`. From this shell, unset `ELECTRON_RUN_AS_NODE` first.
- **Benchmarking Kokoro outside VS Code:** run the measuring script with Code.exe as Node (`ELECTRON_RUN_AS_NODE=1`). The worker talks over V8 serialization, which fails between Node 24 and Electron's Node. Expect Windows power throttling to halve any windowless CPU work after about 3 s; rawi's helper opts the worker out (`fullspeed <pid>`).
- **Core modules have no VS Code dependency** and are unit-tested: `src/claude`, `src/text`, `src/audio` (except the player), `src/engines`, `src/kokoro` (its worker test needs `~/.claude/kokoro` and a built `dist/`). VS Code code lives in `src/extension.ts`, `src/config.ts` and `src/ui`.
- **End-to-end tests** (screenshots and timings) run in an isolated VS Code. Use your own `--user-data-dir` and `--extensions-dir`, and point `CLAUDE_CONFIG_DIR` at a temp folder holding fake session files.
  - Also point `TEMP` and `TMP` at a temp folder. Rawi's reply claims and shared voice live in `%TEMP%`, and a test must not stop or show the user's real windows' reading.
  - A second window is opened by running Code.exe again with the same `--user-data-dir` and `--new-window <folder>`.
  - **Launch Code.exe with a clean environment.** This shell inherits VS Code's `ELECTRON_RUN_AS_NODE`, which makes Code.exe run as plain Node, and `VSCODE_*` handles, which make it talk to the running VS Code.
  - Playwright's Electron launcher fails because VS Code disables the Node inspector. Start Code.exe with `--remote-debugging-port=<port>` and use `chromium.connectOverCDP`.
  - Give each test reply a new message id: rawi claims each reply it reads in `%TEMP%\rawi-claims`, so a reused id is not read again for a day.
- **Logs:** rawi's log is the **Rawi** output channel, also written under `<user-data-dir>/logs/<time>/window1/exthost/rawi.rawi/Rawi.log`. It records timings per piece: "response after", "audio after", "First sound … ms".

## Open questions (settle with the user before building)
1. **Architecture.** Pure TypeScript (installs with the extension, no Python), or TypeScript plus a local helper process like the current extension's Python server? `kokoro-js` (Kokoro in Node through ONNX) could make local Kokoro work without Python; measure its speed on this machine first.
2. **Audio playback.** The extension host has no audio API. The options are an `<audio>` element in a webview, or spawning an OS player. Decide this early: it shapes everything else.
3. **Local engines.** Reuse the user's existing Kokoro install (`~/.claude/kokoro`), `kokoro-js`, any OpenAI-compatible local server (such as Kokoro-FastAPI), and/or OS voices (Windows SAPI) as a zero-install fallback.
4. **Cloud engines.** OpenRouter first. A generic "OpenAI-compatible endpoint" (base URL, key, model) would cover OpenRouter, OpenAI and local servers with one code path. Keep API keys in VS Code `SecretStorage`, never in settings.json.
5. **Agents.** Claude Code only at first, or also Codex, Gemini CLI and Cursor? The current extension supports all four.
6. **Arabic.** The current extension has an Arabic voice (diacritization, then a local NVIDIA Magpie model or the OS voice). Does the user need Arabic in rawi?
7. **Release.** Personal use, or publish to the Marketplace and Open VSX?

## "Smart" ideas raised so far (none agreed yet)
- Speak only a turn's final answer (the text after its last tool call) and skip subagents, as the current extension does.
- Make Markdown speakable: say "a Python snippet" instead of reading code aloud, condense tables, shorten file paths, drop URLs and emoji.
- Summarize long replies with a cheap or free OpenRouter text model before speaking. The current extension's "summarize" option only cuts a reply over 1,200 characters to its first paragraph.
- A fallback chain: when the chosen engine fails or is too slow, use the next one (for example local, then OpenRouter, then the OS voice).
- Discover OpenRouter's speech models live and flag the `:free` ones, because free models come and go (one disappeared between two checks on 2026-11-09).
- A spending cap for paid models, in characters per month.
- Parity with the current extension: per-project voices, mute for a while, speak only when the user is away from the editor, pause while the user dictates, replay a sentence, speed.
