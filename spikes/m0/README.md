# M0: quick checks (2026-11-09)

Throwaway test code that settled three questions before M1. Measured on the user's machine (Windows 11, Realtek speakers, VS Code 1.145, Claude Code 2.1.319). Nothing here ships. M1 rewrites what it needs in `src/`, using `player-waveout.ps1` and `audio.js` as references.

## Results

### 1. Player: one continuous waveOut stream, in a hidden PowerShell process
Two helpers were compared on the same three HeyGen sentences. Sound was recorded through WASAPI loopback and matched by loudness envelope (matches of 0.96 to 0.97).

| | `player.ps1` (SoundPlayer, one sound per file) | `player-waveout.ps1` (one waveOut stream) |
|---|---|---|
| Extra gap between sentences | +58 and −70 ms (the next sentence starts too early) | −2 and 0 ms |
| Sentence endings | the 2nd sentence's ending clipped | all heard, 0 ms off |
| Audio heard after Stop | its idea of the position is off by about 0.35 s, because the sound starts late | 29 ms |
| Audio heard after Pause | no pause | 5 ms; resume continues exactly where it paused |
| Queue to stream moving | 31 ms to Play(), then about 0.35 to 0.5 s to sound | 16 to 32 ms with the device open; 280 to 560 ms to open it |
| Helper ready after launch | 0.30 s | 0.45 s (includes compiling the C# with Add-Type) |
| CPU (one core) | 1.3% playing, 0% idle | 1.7 to 2.4% playing, 0% idle |

**Decision: the waveOut stream.** For M1:
- Open the device as soon as rawi starts fetching speech. Fetching takes 0.4 to 1.3 s, so the open cost is hidden.
- Close the device after a few seconds of silence.

### 2. Speed: WSOLA time-stretch in plain JavaScript (`audio.js`)
- 15 s of speech at 1.25× became 11.85 s and at 1.5× became 9.87 s: the exact expected lengths.
- The median pitch stayed the same: 152 Hz at 1×, 153 Hz at 1.25× and at 1.5×.
- It took 0.12 to 0.13 s for 15 s of speech, on the extension host's thread.
- The user heard both speeds; their verdict on how natural they sound is noted in `docs/plan.md`.

### 3. "Reply finished" signal
- Across the last 991 finished turns, 985 ended with one message, `thinking` (optional) then one `text` block, with `stop_reason: "end_turn"` and the text block last.
- **Speak 0.3 s after that line is written.**
- Don't wait for `system/stop_hook_summary`:
  - It's only written because the user has a Stop hook (`hookCount: 1` on all 955 lines).
  - It arrives a median of 3.1 s later (that hook's run time, up to 20 s).

### Other findings
- HeyGen Voice Turbo (free) for 63 to 92 characters: first byte after 0.41 to 1.25 s, everything after 0.77 to 1.5 s.
- Each clip starts with 0.23 to 0.31 s of silence and ends with 0.14 to 0.30 s. **Trim both** (keep 20 ms): it gets speech out sooner and makes the pauses between sentences rawi's choice. The tests used 250 ms.
- The PCM is 16-bit little-endian mono at the rate in `Content-Type` (`audio/pcm;rate=44100;channels=1`).
- **A measurement trap:** on Windows, numpy's default integer is 32-bit, so `np.arange(n) * 44100` overflowed and scrambled the first analyses. `analyze.py` uses float64 coordinates.

## Files
- `player.ps1`: the SoundPlayer helper (rejected, kept as the baseline).
- `player-waveout.ps1`: the waveOut helper.
  - stdin: `queue <id> <ms> <path>`, `pause`, `resume`, `stop`, `quit`.
  - stdout: `ready`, `started`, `ended`, `paused`, `resumed`, `stopped`, `error`.
- `audio.js`: PCM to float, trimming, fades, WAV, WSOLA, a pitch estimate.
- `tts.js`: fetches the test sentences from OpenRouter (needs `OPENROUTER_API_KEY`).
- `prepare.js`: builds the test WAVs and the 1.25× and 1.5× versions.
- `player-test.js`: drives a helper. Modes: `short`, `stop`, `pause`, `full`.
- `measure.py`: records the speakers through loopback while `player-test.js` runs.
- `analyze.py`: turns a recorded run into the numbers above.

## Running it again
These scripts **play audio**. Use a scratch folder outside the repo, and a Python venv with `numpy<2` and `soundcard`.
```
node tts.js <work>        # with OPENROUTER_API_KEY set
node prepare.js <work>
python measure.py <work> stop player-waveout.ps1
```
