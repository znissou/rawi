# Rawi — Read Aloud for Claude Code

Rawi reads Claude Code's replies aloud, so you can listen instead of reading. It works with Claude Code in the VS Code panel and in a terminal, and it needs nothing installed besides the extension.

It speaks with a cloud voice from [OpenRouter](https://openrouter.ai) (several are free), or with **Kokoro**, a free voice that runs on your computer: no internet, no account, no credit.

*Rawi* (Arabic راوي) is "the narrator": in classical Arabic poetry the rāwī memorized a poet's verses and recited them.

## What it does
- **Reads each reply when Claude finishes a turn:** only the final answer, the text after Claude's last tool call.
- **Or only when you ask:** use the ▶ button in the status bar, click a reply in the **Replies** list (Rawi icon in the activity bar), or press `Ctrl+Alt+P`.
- **One voice across VS Code windows.** The status-bar button shows the auto-read mode ("Rawi: auto", "Rawi: when away", "Rawi: manual") and what any window is reading ("Rawi 2/4 · other window"). Its controls and keys work on that reading, and a reading you ask for takes over from another window's.
- **Reads for the ear.**
  - Code blocks are announced ("TypeScript code, 12 lines"), not read out.
  - File paths become file names ("player.ts, line 42").
  - Links become their text, and tables are summarized.
  - Emoji are dropped, and symbols and units are said as words.
- **Starts fast.** The first sentence is fetched on its own, and Rawi plays it while the voice is still sending it, so speech starts about a second after Claude finishes (about 0.6 s with Kokoro, which gets ready while Claude works). The rest follows without gaps.
- **Works offline.** Kokoro runs on your computer, as the main voice or as the backup for OpenRouter. It has 28 English voices, American and British.
- **Never silent.** If the main voice fails, or the OpenRouter voice sends nothing for 3 s, a backup voice reads the rest of that reply: Kokoro, when you set it up as the backup, or else Windows' own voice. The next reply tries the main voice again.
- **Warns before a free voice ends.** Free models come and go. Rawi warns three days before yours stops being free, and offers the model list.
- **Keeps your settings.** You choose the voice, model and speed (the pitch stays natural from 0.5× to 2×). Workspace settings give a project its own voice.

## Getting started
**With OpenRouter** (cloud voices):
1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Run **Rawi: Set OpenRouter API Key**. The key is kept in VS Code's secret storage, never in your settings. `OPENROUTER_API_KEY` works too.
3. That's it. The default voice is free: `heygen/heygen-voice-1-turbo:free`, voice Nadine.

**With Kokoro** (on your computer, free, offline):
1. Run **Rawi: Set Up Local Voice (Kokoro)**. If [Read Aloud for Claude Code](https://marketplace.visualstudio.com/items?itemName=abdalrhman-attar.read-aloud-for-claude-code) already installed Kokoro, Rawi uses its copy. Otherwise it downloads Kokoro once (354 MB, checked against known checksums).
2. Choose **As the Main Voice** (Kokoro reads every reply) or **As the Backup Voice** (OpenRouter reads, and Kokoro takes over when OpenRouter fails or is slow).

Use **Rawi: Choose Model…** to switch between Kokoro and OpenRouter's speech models (free ones first; Kokoro stays in the list when you're offline), and **Rawi: Choose Voice…** to hear each voice as you move through the list.

## Controls
| | Keys (macOS) | Also |
|---|---|---|
| Read last reply | `Ctrl+Alt+P` (`Ctrl+Cmd+P`) | the status bar when idle |
| Pause / resume | `Ctrl+Alt+,` (`Ctrl+Cmd+,`) | the status bar while reading |
| Stop | `Ctrl+Alt+.` (`Ctrl+Cmd+.`) | |
| Skip forward / back | `Ctrl+Alt+/`, `Ctrl+Alt+B` | |

Reading also stops on its own when you send Claude a new prompt.

More in the Command Palette, under **Rawi:**
- Read Selection Aloud, also in the editor's context menu.
- Read Clipboard: copy any reply in Claude Code, then run it.
- Auto-Read (always, when away, off) and Mute for….
- Set Speed….

## Settings
All settings are under `rawi.*`. The main ones:

| Setting | Default | |
|---|---|---|
| `rawi.autoRead` | `always` | `always`, `whenAway` (only while VS Code isn't focused), or `off` |
| `rawi.read.longReplies` | `full` | `firstParagraph`, for short audio |
| `rawi.read.codeBlocks` | `announce` | or `skip`, `read` |
| `rawi.speed` | `1` | 0.5 to 2 |
| `rawi.engine` | `openrouter` | the main voice: `openrouter`, or `kokoro` on this computer |
| `rawi.openrouter.allowPaid` | `false` | paid models are refused until you allow them |
| `rawi.fallback` | `systemVoice` | the backup voice when the main voice fails or is slow: `systemVoice` (Windows' voice), `kokoro`, or `none` |
| `rawi.fallbackAfter` | `3` | seconds to wait for OpenRouter before the backup voice reads; `0` means only when it fails. Kokoro is always waited for |
| `rawi.kokoro.voice` | `af_heart` | Kokoro's voice (Heart, Read Aloud's voice) |
| `rawi.kokoro.threads` | `4` | CPU threads Kokoro uses |
| `rawi.kokoro.folder` | empty | where Kokoro's two files are; empty finds Read Aloud's copy or Rawi's own download |
| `rawi.scope` | `workspace` | `all` follows every Claude Code session on the computer |

## Costs and privacy
- **Cost:** free models and Kokoro cost nothing. Paid ones are only used once you allow them, and the model list shows what a typical reply would cost.
- **What gets sent:** with OpenRouter, the text Rawi reads goes to OpenRouter and the voice's provider. Code blocks aren't sent by default. With Kokoro, nothing leaves your computer.
- **Kokoro's memory:** about 0.6 GB once loaded, up to about 1 GB after long sentences. Rawi stops it after 10 minutes unused. When you send Claude a prompt, it loads Kokoro again in one window, if the reply will be read on its own.
- **Cache:** speech is cached on your computer (up to 100 MB), so replaying a reply costs no new request.
- **Logs:** they record lengths and timings, never reply text or keys.

## Requirements
- VS Code 1.90 or later.
- Windows 10 or 11, x64; tested on Windows 11. Playback uses the system's own audio through a hidden PowerShell process.
- This package is built for Windows x64, because it carries ONNX Runtime for Windows to run Kokoro. The code also has players for macOS (`afplay`) and Linux (`pw-play`, `paplay` or `aplay`), not tested or packaged yet.

## Credits
- Finding finished replies in Claude Code's session files follows [Read Aloud for Claude Code](https://github.com/Abdalrhman-Attar/claude-voice) (MIT).
- The local voice is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0), in the files of [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (MIT). Rawi's text-to-phoneme step is ported from [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) (Apache-2.0) and uses eSpeak NG (GPL-3.0-or-later) through [phonemizer](https://github.com/xenova/phonemizer.js). Kokoro runs on [ONNX Runtime](https://github.com/microsoft/onnxruntime) (MIT).
- All third-party licences are in `THIRD-PARTY-NOTICES.md`, which comes with the extension.
