# rawi M0 spike, second player: one continuous Windows audio stream (winmm waveOut) that queued WAV
# files are written into back to back. No start-up cost per sentence, no gap, nothing cut off,
# and the stream's own position says what is audible now (so pause/resume keep their place).
# Same protocol as player.ps1, plus pause/resume:
#   stdin:  queue <id> <durationMs, ignored> <path> | pause | resume | stop | quit
#   stdout: ready | started <id> | ended <id> | paused <id> <ms> | resumed <id> | stopped <id> <ms> | error <message>
$ErrorActionPreference = 'Stop'
$out = [Console]::Out
function Emit([string]$line) { $out.WriteLine($line); $out.Flush() }

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class RawiWaveOut {
    [StructLayout(LayoutKind.Sequential)] struct WaveFormat { public short tag, channels; public int rate, bytesPerSec; public short blockAlign, bits, extra; }
    [StructLayout(LayoutKind.Sequential)] struct WaveHdr { public IntPtr data; public int length, recorded; public IntPtr user; public int flags, loops; public IntPtr next, reserved; }
    [StructLayout(LayoutKind.Sequential)] struct MmTime { public int type, value, pad; }
    [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, int device, ref WaveFormat fmt, IntPtr cb, IntPtr inst, int flags);
    [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutPause(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutRestart(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveOutGetPosition(IntPtr h, ref MmTime t, int size);

    static readonly int HdrSize = Marshal.SizeOf(typeof(WaveHdr));
    static readonly int FlagsAt = (int)Marshal.OffsetOf(typeof(WaveHdr), "flags");
    class Item { public string Id; public IntPtr Hdr, Data; public long Start, Bytes; public bool Started; }

    IntPtr dev = IntPtr.Zero;
    int rate, channels;
    long written;
    bool paused;
    readonly List<Item> items = new List<Item>();
    public readonly Queue<string> Events = new Queue<string>();
    public bool Busy { get { return items.Count > 0; } }
    public bool Open { get { return dev != IntPtr.Zero; } }

    static void Check(int r, string what) { if (r != 0) throw new Exception(what + " failed: MMSYSERR " + r); }

    public void Queue(string id, string path) {
        byte[] wav = File.ReadAllBytes(path);
        int pos = 12, r = 0, ch = 0, bits = 0, at = -1, len = 0;
        while (pos + 8 <= wav.Length) {
            string tag = Encoding.ASCII.GetString(wav, pos, 4);
            int size = BitConverter.ToInt32(wav, pos + 4);
            if (tag == "fmt ") { ch = BitConverter.ToInt16(wav, pos + 10); r = BitConverter.ToInt32(wav, pos + 12); bits = BitConverter.ToInt16(wav, pos + 22); }
            else if (tag == "data") { at = pos + 8; len = Math.Min(size, wav.Length - at); break; }
            pos += 8 + size + (size & 1);
        }
        if (at < 0 || bits != 16) throw new Exception("not a 16-bit PCM WAV: " + path);
        if (dev != IntPtr.Zero && (r != rate || ch != channels)) {
            if (items.Count > 0) throw new Exception("sample format changed while playing");
            Close();
        }
        if (dev == IntPtr.Zero) {
            WaveFormat f = new WaveFormat();
            f.tag = 1; f.channels = (short)ch; f.rate = r; f.bits = 16; f.blockAlign = (short)(ch * 2); f.bytesPerSec = r * ch * 2;
            Check(waveOutOpen(out dev, -1, ref f, IntPtr.Zero, IntPtr.Zero, 0), "waveOutOpen");
            rate = r; channels = ch; written = 0; paused = false;
        }
        IntPtr data = Marshal.AllocHGlobal(len);
        Marshal.Copy(wav, at, data, len);
        WaveHdr h = new WaveHdr(); h.data = data; h.length = len;
        IntPtr hdr = Marshal.AllocHGlobal(HdrSize);
        Marshal.StructureToPtr(h, hdr, false);
        Check(waveOutPrepareHeader(dev, hdr, HdrSize), "waveOutPrepareHeader");
        items.Add(new Item { Id = id, Hdr = hdr, Data = data, Start = written, Bytes = len });
        written += len;
        Check(waveOutWrite(dev, hdr, HdrSize), "waveOutWrite");
    }

    long Position() {
        MmTime t = new MmTime(); t.type = 4; // TIME_BYTES
        waveOutGetPosition(dev, ref t, Marshal.SizeOf(typeof(MmTime)));
        return (uint)t.value;
    }

    int Ms(long bytes) { return (int)(bytes * 1000L / (rate * channels * 2)); }

    void Free(Item it) {
        waveOutUnprepareHeader(dev, it.Hdr, HdrSize);
        Marshal.FreeHGlobal(it.Hdr); Marshal.FreeHGlobal(it.Data);
    }

    /// Called every few ms while busy: turns the stream position into started/ended events.
    public void Tick() {
        if (dev == IntPtr.Zero || items.Count == 0) return;
        long p = Position();
        foreach (Item it in items) {
            if (!it.Started && p > it.Start) { it.Started = true; Events.Enqueue("started " + it.Id); }
        }
        while (items.Count > 0 && p >= items[0].Start + items[0].Bytes && (Marshal.ReadInt32(items[0].Hdr, FlagsAt) & 1) != 0) {
            Item it = items[0];
            if (!it.Started) Events.Enqueue("started " + it.Id);
            Events.Enqueue("ended " + it.Id);
            Free(it); items.RemoveAt(0);
        }
    }

    Item Current(long p) {
        foreach (Item it in items) if (p < it.Start + it.Bytes) return it;
        return null;
    }

    public void Pause() {
        if (dev == IntPtr.Zero || paused) return;
        waveOutPause(dev); paused = true;
        long p = Position(); Item it = Current(p);
        Events.Enqueue(it == null ? "paused - 0" : "paused " + it.Id + " " + Ms(p - it.Start));
    }

    public void Resume() {
        if (dev == IntPtr.Zero || !paused) return;
        waveOutRestart(dev); paused = false;
        Item it = Current(Position());
        Events.Enqueue("resumed " + (it == null ? "-" : it.Id));
    }

    public void Stop() {
        if (dev == IntPtr.Zero) { Events.Enqueue("stopped - 0"); return; }
        long p = Position(); Item it = Current(p);
        waveOutReset(dev); // returns every buffer at once and resets the position to 0
        foreach (Item x in items) Free(x);
        items.Clear(); written = 0;
        if (paused) { waveOutRestart(dev); paused = false; }
        Events.Enqueue(it == null ? "stopped - 0" : "stopped " + it.Id + " " + Ms(p - it.Start));
    }

    public void Close() {
        if (dev == IntPtr.Zero) return;
        waveOutReset(dev);
        foreach (Item x in items) Free(x);
        items.Clear();
        waveOutClose(dev); dev = IntPtr.Zero;
    }
}
'@

$player = New-Object RawiWaveOut
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$pending = $reader.ReadLineAsync()
$idle = New-Object System.Diagnostics.Stopwatch
Emit 'ready'

:main while ($true) {
    # Busy: wake every 10 ms to report progress. Idle with the stream open: close it after 5 s.
    # Idle and closed: block until a command arrives (no CPU).
    $timeout = if ($player.Busy) { 10 } elseif ($player.Open) { 1000 } else { -1 }
    if ($pending.Wait($timeout)) {
        $line = $pending.Result
        if ($null -eq $line) { break main }
        $pending = $reader.ReadLineAsync()
        $parts = $line.Split(' ', 4)
        try {
            switch ($parts[0]) {
                'queue' { $player.Queue($parts[1], $parts[3]) }
                'pause' { $player.Pause() }
                'resume' { $player.Resume() }
                'stop' { $player.Stop() }
                'quit' { break main }
            }
        } catch { Emit "error $($_.Exception.Message)" }
    }
    $player.Tick()
    while ($player.Events.Count -gt 0) { Emit $player.Events.Dequeue() }
    if ($player.Busy) { $idle.Reset() }
    elseif ($player.Open) {
        if (-not $idle.IsRunning) { $idle.Start() }
        if ($idle.ElapsedMilliseconds -ge 5000) { $player.Close(); $idle.Reset() }
    }
}
$player.Close()
