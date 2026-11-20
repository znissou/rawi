import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createPlayer } from '../src/audio/player';
import { silentLogger } from '../src/util/log';

/** Stands in for media/win-player.ps1: it says it's ready, reads one command, then dies. */
const DYING_HELPER = `
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
$null = [Console]::In.ReadLine()
exit 3
`;

describe.skipIf(process.platform !== 'win32')('Windows audio player', () => {
  it('says so at once when its helper dies, so a reading doesn\'t wait for it for ever', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawi-player-test-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true })); // also after a failure or a timeout
    fs.mkdirSync(path.join(dir, 'media'));
    fs.writeFileSync(path.join(dir, 'media', 'win-player.ps1'), DYING_HELPER);
    const errors: string[] = [];
    const player = createPlayer(dir, { started() {}, ended() {}, error: (m) => errors.push(m) }, silentLogger);
    onTestFinished(() => player.dispose());
    // Windows' voice was making speech when the helper died: that fails now, not after its 20 s limit.
    await expect(player.synthesize!('Hello.', path.join(dir, 'hello.wav'))).rejects.toThrow('The audio player stopped.');
    expect(errors).toEqual(['The audio player stopped (code 3).']);
  }, 10_000);
});
