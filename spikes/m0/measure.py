"""M0 spike: record what the speakers actually play while player-test.js runs, then analyze it.

Records the default output device through WASAPI loopback (python-soundcard) in 50 ms blocks, each
stamped with its arrival time, while a silent stream keeps the audio engine running. A 100 ms beep
played at a known time marks the recording setup's own delay. The recording, the block times and
the player's event log are saved per run, and analyze.py turns them into numbers.

Usage: python measure.py <work dir> <mode> <helper.ps1>      (needs numpy and soundcard)
"""
import json
import os
import subprocess
import sys
import threading
import time

import numpy as np
import soundcard as sc

SR = 48000
BLOCK = 2400  # 50 ms
here = os.path.dirname(os.path.abspath(__file__))
work, mode, helper = sys.argv[1], sys.argv[2], sys.argv[3]
run = f"{os.path.splitext(helper)[0]}-{mode}"

speaker = sc.default_speaker()
loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
stop, beep_now = threading.Event(), threading.Event()
blocks, beep = [], {"t": None}
TONE = (0.3 * np.sin(2 * np.pi * 1000 * np.arange(int(0.1 * SR)) / SR)).astype(np.float32)


def keepalive():
    with speaker.player(samplerate=SR, channels=1, blocksize=BLOCK) as p:
        z = np.zeros((BLOCK, 1), dtype=np.float32)
        while not stop.is_set():
            if beep_now.is_set() and beep["t"] is None:
                beep["t"] = time.time()
                p.play(TONE.reshape(-1, 1))
            else:
                p.play(z)


def record():
    with loopback.recorder(samplerate=SR, channels=2, blocksize=BLOCK) as r:
        while not stop.is_set():
            d = r.record(numframes=BLOCK)
            blocks.append((time.time(), d.mean(axis=1).astype(np.float32)))


threads = [threading.Thread(target=keepalive, daemon=True), threading.Thread(target=record, daemon=True)]
for th in threads:
    th.start()
time.sleep(1.0)
beep_now.set()
time.sleep(0.6)
subprocess.run(["node", os.path.join(here, "player-test.js"), work, mode, helper], check=True)
time.sleep(0.8)
stop.set()
for th in threads:
    th.join(timeout=3)

np.save(os.path.join(work, f"capture-{run}.npy"), np.concatenate([b[1] for b in blocks]))
json.dump({"ends": np.cumsum([len(b[1]) for b in blocks]).tolist(), "arrivals": [b[0] for b in blocks], "beep": beep["t"]},
          open(os.path.join(work, f"capture-{run}.json"), "w"))
os.replace(os.path.join(work, "events.json"), os.path.join(work, f"events-{run}.json"))
subprocess.run([sys.executable, "-I", os.path.join(here, "analyze.py"), work, run], check=True)
