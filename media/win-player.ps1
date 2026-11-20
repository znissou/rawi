# rawi's audio player for Windows. rawi starts it hidden and talks to it one line at a time.
# It keeps one waveOut stream (winmm, built into Windows) and writes each queued WAV into it back to
# back: no gap between sentences, nothing cut off, and the stream position says what is audible
# (measured in M0: Stop silences within 29 ms, Pause within 5 ms).
# It also holds the backup voice: Windows' own speech synthesizer (System.Speech), writing WAV files.
# And it keeps Windows from slowing rawi's Kokoro worker down (fullspeed <pid>, see RawiPower).
#   stdin:  prepare <rate> <channels> | queue <id> <wav path> | pause | resume | stop | volume <0-1>
#           | say <id> <base64 UTF-8 text> <wav path> | fullspeed <pid> | quit
#   stdout: ready | started <id> | ended <id> | paused <id> <ms> | resumed <id> | stopped <id> <ms>
#           | said <id> <voice> | sayerror <id> <message> | fullspeed <pid> <ok or message>
#           | error <message>
$ErrorActionPreference = 'Stop'
$out = [Console]::Out
function Emit([string]$line) { $out.WriteLine($line); $out.Flush() }

Add-Type -AssemblyName System.Speech
$speechAssembly = [System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location
Add-Type -Language CSharp -ReferencedAssemblies $speechAssembly -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

/// Windows 11 slows down background processes without a window (power throttling, "EcoQoS"):
/// a few seconds after it starts, Kokoro's worker would run on the efficiency cores at half speed
/// (measured on an i5-13500HX: 4.4x real time drops to 2.0x). This opts a process out. The worker
/// waits idle between replies, so this only matters while it is speaking.
public static class RawiPower {
    [StructLayout(LayoutKind.Sequential)]
    struct ThrottlingState { public uint Version; public uint ControlMask; public uint StateMask; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref ThrottlingState info, int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    const uint PROCESS_SET_INFORMATION = 0x0200;
    const int ProcessPowerThrottling = 4;
    const uint EXECUTION_SPEED = 1;

    public static string FullSpeed(int pid) {
        IntPtr h = OpenProcess(PROCESS_SET_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "OpenProcess failed: " + Marshal.GetLastWin32Error();
        try {
            // Control the execution-speed policy (mask) and turn it off (state 0).
            var s = new ThrottlingState { Version = 1, ControlMask = EXECUTION_SPEED, StateMask = 0 };
            return SetProcessInformation(h, ProcessPowerThrottling, ref s, Marshal.SizeOf(s))
                ? "ok" : "SetProcessInformation failed: " + Marshal.GetLastWin32Error();
        } finally {
            CloseHandle(h);
        }
    }
}

/// The backup voice: Windows' speech synthesizer, an English voice when one is installed.
/// Synthesis runs off the main loop, so playback keeps reporting while a WAV is being made.
public class RawiVoice {
    readonly object gate = new object();
    SpeechSynthesizer synth;
    string voiceName = "";
    int pending;
    public readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
    public bool Pending { get { return Volatile.Read(ref pending) > 0; } }

    public void Say(string id, string base64, string path) {
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(base64));
        Interlocked.Increment(ref pending);
        Task.Run(() => {
            try {
                lock (gate) {
                    if (synth == null) {
                        synth = new SpeechSynthesizer();
                        foreach (InstalledVoice v in synth.GetInstalledVoices()) {
                            if (v.Enabled && v.VoiceInfo.Culture.Name.StartsWith("en", StringComparison.OrdinalIgnoreCase)) {
                                synth.SelectVoice(v.VoiceInfo.Name);
                                break;
                            }
                        }
                        voiceName = synth.Voice.Name.Replace(' ', '_');
                    }
                    synth.SetOutputToWaveFile(path, new SpeechAudioFormatInfo(44100, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                    synth.Speak(text);
                    synth.SetOutputToNull();
                }
                Events.Enqueue("said " + id + " " + voiceName);
            } catch (Exception e) {
                Events.Enqueue("sayerror " + id + " " + e.Message.Replace('\r', ' ').Replace('\n', ' '));
            } finally {
                Interlocked.Decrement(ref pending);
            }
        });
    }
}

public class RawiPlayer {
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
    [DllImport("winmm.dll")] static extern int waveOutSetVolume(IntPtr h, uint volume);
    [DllImport("winmm.dll")] static extern int waveOutGetPosition(IntPtr h, ref MmTime t, int size);

    static readonly int HdrSize = Marshal.SizeOf(typeof(WaveHdr));
    static readonly int FlagsAt = (int)Marshal.OffsetOf(typeof(WaveHdr), "flags");
    class Item { public string Id; public IntPtr Hdr, Data; public long Start, Bytes; public bool Started; }

    IntPtr dev = IntPtr.Zero;
    int rate, channels;
    long written;
    bool paused;          // kept while no stream is open, so audio queued later starts paused
    double volume = 1.0;
    readonly List<Item> items = new List<Item>();
    public readonly Queue<string> Events = new Queue<string>();
    public bool Busy { get { return items.Count > 0; } }
    public bool Open { get { return dev != IntPtr.Zero; } }

    static void Check(int r, string what) { if (r != 0) throw new Exception(what + " failed: MMSYSERR " + r); }

    void OpenDevice(int r, int ch) {
        WaveFormat f = new WaveFormat();
        f.tag = 1; f.channels = (short)ch; f.rate = r; f.bits = 16; f.blockAlign = (short)(ch * 2); f.bytesPerSec = r * ch * 2;
        Check(waveOutOpen(out dev, -1, ref f, IntPtr.Zero, IntPtr.Zero, 0), "waveOutOpen");
        rate = r; channels = ch; written = 0;
        ApplyVolume();
        if (paused) waveOutPause(dev);
    }

    void ApplyVolume() {
        if (dev == IntPtr.Zero) return;
        uint v = (uint)Math.Round(Math.Max(0, Math.Min(1, volume)) * 0xFFFF);
        waveOutSetVolume(dev, v | (v << 16));
    }

    /// Opens the stream ahead of time, while speech downloads. Opening alone isn't enough: Windows
    /// starts the stream on the first write, which takes about 0.5 s. So a moment of silence is played
    /// at once; after that, audio starts within about 30 ms (measured), even seconds later.
    public void Prepare(int r, int ch) {
        if (dev != IntPtr.Zero && r == rate && ch == channels) return;
        if (dev != IntPtr.Zero) { if (items.Count > 0) return; Close(); }
        OpenDevice(r, ch);
        Write("~prime", new byte[(r * ch * 2 * 60 / 1000) / (ch * 2) * (ch * 2)]); // 60 ms
    }

    void Write(string id, byte[] pcm) {
        IntPtr data = Marshal.AllocHGlobal(pcm.Length);
        Marshal.Copy(pcm, 0, data, pcm.Length);
        WaveHdr h = new WaveHdr(); h.data = data; h.length = pcm.Length;
        IntPtr hdr = Marshal.AllocHGlobal(HdrSize);
        Marshal.StructureToPtr(h, hdr, false);
        Check(waveOutPrepareHeader(dev, hdr, HdrSize), "waveOutPrepareHeader");
        items.Add(new Item { Id = id, Hdr = hdr, Data = data, Start = written, Bytes = pcm.Length });
        written += pcm.Length;
        Check(waveOutWrite(dev, hdr, HdrSize), "waveOutWrite");
    }

    public void SetVolume(string v) {
        volume = double.Parse(v, CultureInfo.InvariantCulture);
        ApplyVolume();
    }

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
        if (dev == IntPtr.Zero) OpenDevice(r, ch);
        byte[] pcm = new byte[len];
        Buffer.BlockCopy(wav, at, pcm, 0, len);
        Write(id, pcm);
    }

    long Position() {
        MmTime t = new MmTime(); t.type = 4; // TIME_BYTES
        waveOutGetPosition(dev, ref t, Marshal.SizeOf(typeof(MmTime)));
        return (uint)t.value;
    }

    int Ms(long bytes) { return rate == 0 ? 0 : (int)(bytes * 1000L / (rate * channels * 2)); }

    void Free(Item it) {
        waveOutUnprepareHeader(dev, it.Hdr, HdrSize);
        Marshal.FreeHGlobal(it.Hdr); Marshal.FreeHGlobal(it.Data);
    }

    /// Called every few ms while busy: turns the stream position into started/ended events.
    public void Tick() {
        if (dev == IntPtr.Zero || items.Count == 0) return;
        long p = Position();
        foreach (Item it in items) {
            if (!it.Started && p > it.Start) { it.Started = true; Report("started", it); }
        }
        while (items.Count > 0 && p >= items[0].Start + items[0].Bytes && (Marshal.ReadInt32(items[0].Hdr, FlagsAt) & 1) != 0) {
            Item it = items[0];
            if (!it.Started) Report("started", it);
            Report("ended", it);
            Free(it); items.RemoveAt(0);
        }
    }

    /// The priming silence ("~prime") is rawi's own business: no events for it.
    void Report(string what, Item it) {
        if (!it.Id.StartsWith("~")) Events.Enqueue(what + " " + it.Id);
    }

    Item Current(long p) {
        foreach (Item it in items) if (p < it.Start + it.Bytes && !it.Id.StartsWith("~")) return it;
        return null;
    }

    public void Pause() {
        if (paused) return;
        paused = true;
        if (dev == IntPtr.Zero) { Events.Enqueue("paused - 0"); return; }
        waveOutPause(dev);
        long p = Position(); Item it = Current(p);
        Events.Enqueue(it == null ? "paused - 0" : "paused " + it.Id + " " + Ms(p - it.Start));
    }

    public void Resume() {
        if (!paused) return;
        paused = false;
        if (dev == IntPtr.Zero) { Events.Enqueue("resumed -"); return; }
        waveOutRestart(dev);
        Item it = Current(Position());
        Events.Enqueue("resumed " + (it == null ? "-" : it.Id));
    }

    public void Stop() {
        bool wasPaused = paused;
        paused = false;
        if (dev == IntPtr.Zero) { Events.Enqueue("stopped - 0"); return; }
        long p = Position(); Item it = Current(p);
        waveOutReset(dev); // returns every buffer at once and resets the position to 0
        foreach (Item x in items) Free(x);
        items.Clear(); written = 0;
        if (wasPaused) waveOutRestart(dev);
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

$player = New-Object RawiPlayer
$voice = New-Object RawiVoice
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$pending = $reader.ReadLineAsync()
$idle = New-Object System.Diagnostics.Stopwatch
Emit 'ready'

:main while ($true) {
    # Busy (playing or making speech): wake every 10 ms to report progress. Idle with the stream
    # open: close it after 8 s. Idle and closed: block until a command arrives (no CPU).
    $timeout = if ($player.Busy -or $voice.Pending) { 10 } elseif ($player.Open) { 1000 } else { -1 }
    if ($pending.Wait($timeout)) {
        $line = $pending.Result
        if ($null -eq $line) { break main }   # stdin closed: rawi went away
        $pending = $reader.ReadLineAsync()
        $space = $line.IndexOf(' ')
        $cmd = if ($space -lt 0) { $line } else { $line.Substring(0, $space) }
        $rest = if ($space -lt 0) { '' } else { $line.Substring($space + 1) }
        try {
            switch ($cmd) {
                'prepare' { $a = $rest.Split(' '); $player.Prepare([int]$a[0], [int]$a[1]); $idle.Reset() }
                'queue' { $a = $rest.Split(' ', 2); $player.Queue($a[0], $a[1]) }
                'say' { $a = $rest.Split(' ', 3); $voice.Say($a[0], $a[1], $a[2]) }
                'pause' { $player.Pause() }
                'resume' { $player.Resume() }
                'stop' { $player.Stop() }
                'volume' { $player.SetVolume($rest) }
                'fullspeed' { Emit "fullspeed $rest $([RawiPower]::FullSpeed([int]$rest))" }
                'quit' { break main }
            }
        } catch { Emit "error $($_.Exception.Message)" }
    }
    $player.Tick()
    while ($player.Events.Count -gt 0) { Emit $player.Events.Dequeue() }
    $said = $null
    while ($voice.Events.TryDequeue([ref]$said)) { Emit $said }
    if ($player.Busy) { $idle.Reset() }
    elseif ($player.Open) {
        if (-not $idle.IsRunning) { $idle.Start() }
        if ($idle.ElapsedMilliseconds -ge 8000) { $player.Close(); $idle.Reset() }
    }
}
$player.Close()
