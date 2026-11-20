# Changelog

## 0.3.3
Fixes from a review of the whole project.
- **Free models that list no voices work,** such as Fish Audio S2.1 Pro Free. Rawi used to send them the last voice chosen, which they refuse.
  - Choosing such a model in **Choose Model** now clears the voice, and the status bar shows "Default".
  - **Choose Voice** takes an empty answer for the model's own voice.
- **Read Selection Aloud reads what you selected.** A selection in a code file is read line by line, and one in a text file paragraph by paragraph. Before, both were treated as Markdown, so indented code was only announced ("A code block, 3 lines.").
- **Units after long numbers:** "16,731 ms" is read "16,731 milliseconds". Any number ending in 1 used to get the singular.
- **Paid models stay off when the price can't be checked.** If OpenRouter's model list was out of reach, a paid model set by hand was used anyway. Rawi now keeps the last list it fetched, and without one it doesn't use the model.
- **A reading no longer hangs when the audio helper stops.** The reading ends at once and the helper restarts with the next one.
- **Kokoro tries again after it failed to load,** on the next reading. Before, it kept failing for up to 10 minutes.
- **Sending a prompt also drops a reply that was waiting** for another window's reading to end.
- **The warning about a free model ending shows in one window,** not in every open one.
- Smaller fixes: a line break written `<br>` is read as a pause, resuming a reading no longer fails when another window took the voice meanwhile, and changing `rawi.scope` or the folders right at start-up no longer makes rawi handle each reply twice.

## 0.3.2
- **Kokoro moves on at once when a reading stops.** Before, Kokoro still made every sentence of a stopped reading, and the next one waited behind them: up to 17 s in a test. Now it only finishes the sentence it was making, and the next reading started 0.7 to 3.5 s after the stop in the same test. You notice it most when you stop a long reply to hear another, or move through the voices in **Choose Voice**.
- **Background tasks no longer stop the reading.** When a task Claude ran in the background finishes, Claude Code sends Claude a message itself, and rawi took it for a prompt from you: it stopped reading the reply (`rawi.stopOnPrompt`). The summary Claude Code writes when it compacts a conversation did the same. Now only the prompts you send stop the reading.

## 0.3.1
- **One voice for all VS Code windows.** Each window runs its own rawi, and before, they knew nothing of each other: clicking the button in one window could start a second voice over another window's reading, and Stop only reached the window it was pressed in.
  - Another window's reading now shows on the button ("Rawi 2/4 · other window"). Its click, Pause, Stop and Skip, and the keys, work on it.
  - Reading you ask for (the button, the Replies list, Read Selection, voice samples) takes over: the other window stops first.
  - A reply read on its own waits for another window's reading to end, or interrupts it with `rawi.whenBusy: interrupt`.
  - Sending a prompt stops the reading in another window too (`rawi.stopOnPrompt`).
- **The button shows the auto-read mode** when nothing is read: "Rawi: auto", "Rawi: when away" or "Rawi: manual". A changed setting is seen at a glance; before, the button looked the same in every mode.
- **Kokoro is only loaded ahead of time when a reply will be read on its own**, and in one window only. Before, every window loaded it (0.6 to 1 GB each) on every prompt, even with auto-read off.

## 0.3.0
- **A local voice: Kokoro.** It runs on your computer: free, offline, no account. It has 28 English voices, American and British, with samples in **Choose Voice**.
  - As the main voice (`rawi.engine: kokoro`), or as the backup when OpenRouter fails or is slow (`rawi.fallback: kokoro`).
  - **Rawi: Set Up Local Voice (Kokoro)** uses Read Aloud's copy of Kokoro if there is one, or downloads it once (354 MB, checked against known checksums).
  - It gets ready when you send Claude a prompt, and is stopped after 10 minutes unused to give its memory back (about 0.6 to 1 GB).
  - Measured: speech starts about 0.6 s after Claude finishes; Kokoro makes speech about 4× faster than real time on a 13th-gen Core i5 laptop.
- **Kokoro in the model list**, under "On this computer". The list still opens without the internet, with Kokoro in it.
- **No API key needed with Kokoro.** The welcome and the status bar offer the local voice next to the OpenRouter key.
- **Kokoro keeps its speed.** Windows slows windowless background processes down after a few seconds (power throttling), which halved Kokoro's speed. Rawi opts Kokoro's process out; it only uses the CPU while it speaks.
- **Kokoro is never cut off for being slow:** the 3 s wait (`rawi.fallbackAfter`) is for OpenRouter. Kokoro falls back to the backup voice only when it fails.
- **Fixed:** with Kokoro as the main voice, the model list also ticked the OpenRouter model.
- The package is now built for Windows x64 (it carries ONNX Runtime for Windows), with third-party licences in THIRD-PARTY-NOTICES.md.

## 0.2.0
- **Speech starts sooner.**
  - Replies play while the voice is still sending them.
  - The audio device is started while the voice works, saving about half a second on the first sound.
  - Measured: about 1.2 s from Claude finishing to the first sound with HeyGen's free voice, of which rawi itself takes 0.06 to 0.14 s.
- **A backup voice.** Windows' own voice (an English one when installed) reads the rest of a reply when the OpenRouter voice fails or sends nothing for 3 s. Settings: `rawi.fallback`, `rawi.fallbackAfter`.
- **A warning three days before a free model stops being free**, with the model list one click away.
- **Error notices put the likely fix first.**
- **Fixed:** a part could be fetched twice just as it finished.

## 0.1.0 — first version
- Reads Claude Code's replies aloud with OpenRouter voices, automatically (always, or only when you're away) or when you ask.
- Status-bar button, a Replies list with ▶ on every reply, keyboard shortcuts, Read Selection, Read Clipboard.
- Speakable text: code announced, paths shortened, tables summarized, emoji dropped, symbols and units as words.
- Voice, model (free first) and speed pickers; voice samples; pitch-preserving speed.
- Stops when you send a new prompt; mute for a while; paid models off until you allow them.
