'use strict';
// M0 spike: drives a player helper the way rawi will, logging every command and event with epoch times.
// Usage: node player-test.js <dir with the prepared WAVs and durations.json> <mode> [helper.ps1]
//   short: two sentences in a row
//   stop:  three sentences, Stop 1.5 s into the third
//   full:  the same, then the paragraph at 1.25x and 1.5x
//   pause: two sentences, with a 1 s pause 1.5 s into the first (waveOut helper only)
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const [dir, mode = 'full', helper = 'player.ps1'] = process.argv.slice(2);
const dur = JSON.parse(fs.readFileSync(path.join(dir, 'durations.json'), 'utf8'));
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const t = { spawn: now(), helper, mode };

const ps = spawn('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, helper)],
  { windowsHide: true });
const waiters = [];
readline.createInterface({ input: ps.stdout }).on('line', (line) => {
  const ev = { t: now(), line };
  log.push(ev);
  if (line.startsWith('error')) console.error(line);
  for (const w of [...waiters]) if (line.startsWith(w.prefix)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
});
ps.stderr.on('data', (d) => process.stderr.write(d));
const waitFor = (prefix) => new Promise((resolve) => waiters.push({ prefix, resolve }));
const send = (cmd) => { const at = now(); ps.stdin.write(cmd + '\n'); log.push({ t: at, cmd }); return at; };
const queue = (name) => send(`queue ${name} ${dur[name]} ${path.join(dir, name + '.wav')}`);
// Whole milliseconds, so the number doesn't depend on the system's decimal separator.
const cpu = () => ({ t: now(), ms: Number(execFileSync('powershell.exe',
  ['-NoProfile', '-Command', `[int64](Get-Process -Id ${ps.pid}).TotalProcessorTime.TotalMilliseconds`],
  { windowsHide: true }).toString().trim()) });

(async () => {
  t.ready = (await waitFor('ready')).t;
  console.log(`${helper}: ready ${Math.round(t.ready - t.spawn)} ms after spawn`);
  const c0 = cpu();
  if (mode === 'short') {
    t.queueA = queue('s1'); queue('s2');
    await waitFor('ended s2');
  } else if (mode === 'pause') {
    t.queueA = queue('s1'); queue('s2');
    await waitFor('started s1');
    await sleep(1500);
    t.pause = send('pause');
    console.log((await waitFor('paused')).line);
    await sleep(1000);
    t.resume = send('resume');
    await waitFor('ended s2');
  } else {
    t.queueA = queue('s1'); queue('s2'); queue('s3');
    await waitFor('started s3');
    await sleep(1500);
    t.stop = send('stop');
    const stopped = await waitFor('stopped');
    console.log(`stop acknowledged after ${Math.round(stopped.t - t.stop)} ms (${stopped.line})`);
    await sleep(1200);
    if (mode === 'full') {
      t.queueB = queue('p125'); queue('p150');
      await waitFor('ended p150');
    }
  }
  const c1 = cpu();
  await sleep(4000);
  const c2 = cpu();
  t.cpu = {
    playingPercent: Math.round(((c1.ms - c0.ms) / (c1.t - c0.t)) * 1000) / 10,
    idlePercent: Math.round(((c2.ms - c1.ms) / (c2.t - c1.t)) * 1000) / 10,
  };
  const firstStart = log.find((e) => e.line === 'started s1');
  console.log(`first "started" ${Math.round(firstStart.t - t.queueA)} ms after queue; CPU ${t.cpu.playingPercent}% of a core while playing, ${t.cpu.idlePercent}% idle`);
  send('quit');
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ t, log, dur }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
