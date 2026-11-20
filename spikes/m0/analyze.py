"""M0 spike: turn a recorded run (measure.py) into numbers.

Matching works on loudness envelopes (2.5 ms frames, log scale), not raw waveforms, because the
sound driver's processing (EQ, enhancements) reshapes waveforms but not loudness over time.

Relative numbers (same recording, no clock involved) are exact to a few ms:
  extra gap between files, whether each file's last words were heard, and how much audio was heard
  after a Stop or Pause compared with the position the player reported.
Absolute numbers (command time vs. sound in the recording) include the recording setup's own delay;
the calibration beep shows its size.

Usage: python analyze.py <work dir> <run, e.g. player-waveout-stop>
"""
import json
import os
import sys
import wave

import numpy as np

SR, HOP = 48000, 120  # 2.5 ms frames
FPS = SR / HOP
work, run = sys.argv[1], sys.argv[2]
cap = np.load(os.path.join(work, f"capture-{run}.npy"))
meta = json.load(open(os.path.join(work, f"capture-{run}.json")))
ends, arrivals = np.array(meta["ends"]), np.array(meta["arrivals"])
ev = json.load(open(os.path.join(work, f"events-{run}.json"), encoding="utf-8"))
t, dur, log = ev["t"], ev["dur"], ev["log"]


def env(a):
    n = len(a) // HOP
    return np.log10(np.sqrt((a[: n * HOP].reshape(n, HOP) ** 2).mean(axis=1)) + 1e-4)


def load(name):
    with wave.open(os.path.join(work, name + ".wav"), "rb") as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    n = int(round(len(x) * SR / rate))  # float64 coordinates: int32 overflows on Windows
    return np.interp(np.arange(n, dtype=np.float64) * (rate / SR), np.arange(len(x)), x).astype(np.float32)


def frame_at(epoch):
    k = min(int(np.searchsorted(arrivals, epoch)), len(arrivals) - 1)
    return int((ends[k] - (arrivals[k] - epoch) * SR) / HOP)


def time_at(frame):
    i = frame * HOP
    k = min(int(np.searchsorted(ends, i, side="right")), len(ends) - 1)
    return arrivals[k] - (ends[k] - i) / SR


def match(tpl, ref, lo, hi):
    tt = (tpl - tpl.mean()) / (tpl.std() + 1e-9)
    best, bi = -2.0, lo
    for i in range(max(0, lo), min(len(ref) - len(tt), hi)):
        seg = ref[i:i + len(tt)]
        s = float(np.dot(tt, (seg - seg.mean()) / (seg.std() + 1e-9)) / len(tt))
        if s > best:
            best, bi = s, i
    return bi, best


E = env(cap)
res = {"run": run, "helperStartupMs": round(t["ready"] - t["spawn"]), "cpu": t.get("cpu")}
tone = env((0.3 * np.sin(2 * np.pi * 1000 * np.arange(int(0.1 * SR)) / SR)).astype(np.float32))
pad = np.full(40, -4.0)
bf, bq = match(np.concatenate([pad, tone, pad]), E, frame_at(meta["beep"]) - 80, frame_at(meta["beep"]) + 400)
res["calibrationBeepMs"] = round((time_at(bf + 40) - meta["beep"]) * 1000)

names = [n for n in ["s1", "s2", "s3", "p125", "p150"] if any(e.get("line") == f"started {n}" for e in log)]
src = {n: env(load(n)) for n in names}
zero, quality = {}, {}
for n in names:
    X = src[n]
    first = int(np.argmax(X > -2.0))
    around = frame_at(next(e["t"] for e in log if e.get("line") == f"started {n}") / 1000)
    f, q = match(X[first:first + int(FPS)], E, around - int(1.5 * FPS), around + int(1.5 * FPS))
    zero[n], quality[n] = f - first, round(q, 2)  # recording frame of the file's first sample
res["startMatch"] = quality
res["queueToSoundMs"] = round((time_at(zero["s1"]) - t["queueA"] / 1000) * 1000)
res["startedEventToSoundMs"] = {n: round((time_at(zero[n]) - next(e["t"] for e in log if e.get("line") == f"started {n}") / 1000) * 1000) for n in names}

order = [n for n in names if n != "s3" or "stop" not in t]
pairs = [(a, b) for a, b in zip(names, names[1:]) if not (a == "s3" and "stop" in t)]
res["extraGapMs"] = {f"{a}>{b}": round((zero[b] - zero[a]) / FPS * 1000 - dur[a]) for a, b in pairs}

lastwords = {}
for n in names:
    if (n == "s3" and "stop" in t) or (t.get("pause") and n == "s1"):
        continue  # cut on purpose / shifted by the pause
    X = src[n]
    loud = np.nonzero(X > -2.0)[0]
    a = int(loud[-1]) - int(0.5 * FPS)
    f, q = match(X[a:a + int(0.5 * FPS)], E, zero[n] + a - int(0.3 * FPS), zero[n] + a + int(0.3 * FPS))
    lastwords[n] = {"match": round(q, 2), "offByMs": round((f - zero[n] - a) / FPS * 1000)}
res["lastWordsHeard"] = lastwords


def heard_until(n, from_ms):
    """ms into file n where the recording goes silent while the file is still speaking."""
    X = src[n]
    for f in range(int(from_ms / 1000 * FPS), len(X) - 8):
        if X[f:f + 8].mean() > -1.6 and E[zero[n] + f:zero[n] + f + 8].mean() < -3.0:
            return round(f / FPS * 1000)
    return None


for cmd in ("stop", "pause"):
    if cmd in t:
        line = next(e["line"] for e in log if e.get("line", "").startswith("stopped" if cmd == "stop" else "paused"))
        _, item, ms = line.split()
        until = heard_until(item, 300)
        res[cmd] = {"item": item, "playerSaidMs": int(ms), "heardUntilMs": until,
                    "heardAfterCommandMs": None if until is None else until - int(ms)}
print(json.dumps(res, indent=1))
json.dump(res, open(os.path.join(work, f"result-{run}.json"), "w"), indent=1)
