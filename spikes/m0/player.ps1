# rawi M0 spike: plays queued WAV files one after another through Windows' built-in SoundPlayer.
# Runs hidden and long-lived; rawi talks to it over stdin/stdout, one line per message.
#   stdin:  queue <id> <durationMs> <path>  |  stop  |  quit
#   stdout: ready | started <id> | ended <id> | stopped <id> <elapsedMs> | error <message>
# SoundPlayer has no "finished" event, so the end of each file comes from its known duration.
$ErrorActionPreference = 'Stop'
$out = [Console]::Out
function Emit([string]$line) { $out.WriteLine($line); $out.Flush() }

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$player = New-Object System.Media.SoundPlayer
$queue = New-Object 'System.Collections.Generic.Queue[object]'
$clock = New-Object System.Diagnostics.Stopwatch
$current = $null
$pending = $reader.ReadLineAsync()
Emit 'ready'

:main while ($true) {
    # Idle: block until a command arrives (no CPU). Playing: wake every 5 ms to start the next file on time.
    $timeout = if ($current -or $queue.Count -gt 0) { 5 } else { -1 }
    if ($pending.Wait($timeout)) {
        $line = $pending.Result
        if ($null -eq $line) { break main }   # stdin closed: rawi went away
        $pending = $reader.ReadLineAsync()
        $parts = $line.Split(' ', 4)
        switch ($parts[0]) {
            'queue' { $queue.Enqueue([pscustomobject]@{ Id = $parts[1]; Ms = [double]$parts[2]; Path = $parts[3] }) }
            'stop' {
                $player.Stop()
                $queue.Clear()
                if ($current) { Emit "stopped $($current.Id) $($clock.ElapsedMilliseconds)"; $current = $null }
                else { Emit 'stopped - 0' }
            }
            'quit' { break main }
        }
    }
    if ($current -and $clock.Elapsed.TotalMilliseconds -ge $current.Ms) {
        Emit "ended $($current.Id)"
        $current = $null
    }
    if (-not $current -and $queue.Count -gt 0) {
        $current = $queue.Dequeue()
        try {
            $player.SoundLocation = $current.Path
            $player.Load()
            $player.Play()
            $clock.Restart()
            Emit "started $($current.Id)"
        } catch {
            Emit "error $($_.Exception.Message)"
            $current = $null
        }
    }
}
$player.Stop()
