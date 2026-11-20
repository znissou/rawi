// Bundles the extension (dist/extension.js) and the Kokoro worker (dist/kokoro-worker.js), and copies
// ONNX Runtime for Windows x64 next to the worker (dist/node_modules), since its native module can't be
// bundled. Flags: --production (minify, no source maps), --watch.
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const production = process.argv.includes('--production');
const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/kokoro/worker.ts'], outfile: 'dist/kokoro-worker.js', external: ['onnxruntime-node'] },
];

function copyRuntime() {
  const dest = 'dist/node_modules';
  fs.rmSync(dest, { recursive: true, force: true });
  const copy = (from, to) => fs.cpSync(path.join('node_modules', from), path.join(dest, to ?? from), { recursive: true });
  copy('onnxruntime-node/package.json');
  copy('onnxruntime-node/dist');
  copy('onnxruntime-node/bin/napi-v3/win32/x64');
  copy('onnxruntime-common/package.json');
  copy('onnxruntime-common/dist/cjs');
}

copyRuntime();
if (process.argv.includes('--watch')) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
