#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// A checkout gets its own Electron instance lock and browser storage. Home data
// stays in the existing sandbox; no reset or temporary replacement Home.
const env = {
  ...process.env,
  DSH_SPACES_HOME: resolve(process.env.DSH_SPACES_HOME || join(root, '.sandbox/dsh-home')),
  DSH_SPACES_USER_DATA: resolve(process.env.DSH_SPACES_USER_DATA || join(root, '.sandbox/electron-user-data')),
  DSH_SPACES_DEVELOPMENT: '1',
};
delete env.ELECTRON_RUN_AS_NODE;

async function run(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  // Forward a requested stop; never relaunch a failed child.
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 && !signal
        ? accept() : reject(new Error(`Development command exited (${signal || code}).`)));
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

try {
  console.log('[dev] Building the current Spaces component group…');
  await run([join(root, 'scripts/build-spaces.mjs')]);
  const vite = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js');
  await run([vite, 'dev', ...process.argv.slice(2)]);
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
