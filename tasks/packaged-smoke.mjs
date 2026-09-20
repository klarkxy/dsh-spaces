import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bin, home } from './real-config-check.mjs';
import { findNodeDir, toolchainRoot } from '../src/adapters/node/toolchain.ts';
import { terminateProcessTree } from '../src/adapters/node/terminate-process.ts';
import { writeSettings } from '../src/adapters/node/hub-settings.ts';
import { DEFAULT_HUB_SETTINGS } from '../src/shared/types.ts';
const root = mkdtempSync(join(tmpdir(), 'spaces-packaged-smoke-'));
const tools = join(root, 'tools'); mkdirSync(tools);
symlinkSync(findNodeDir(), join(tools, 'node'), 'junction');
symlinkSync(join(toolchainRoot(), 'pnpm'), join(tools, 'pnpm'), 'junction');
writeSettings(home, { ...DEFAULT_HUB_SETTINGS, portStart: 3380, portEnd: 3409 });
const env = { ...process.env, DSH_SPACES_HOME: home, DSH_SPACES_USER_DATA: join(root, 'app'), DSH_SPACES_TOOLCHAIN: tools,
  DSH_SPACES_CLI: resolve(dirname(bin), '../../../..'), DSH_SPACES_SMOKE: '1', DSH_SPACES_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolve('release/win-unpacked/DSH Spaces.exe'), [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk); });
child.stderr.on('data', chunk => process.stderr.write(chunk));
try {
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('packaged smoke exceeded 180 seconds')), 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolveExit(code); });
  });
  assert.equal(code, 0); assert.ok(output.includes('SMOKE: PASS'));
  console.log(`PASS final packaged lifecycle; test root ${root}`);
} finally { if (child.exitCode === null) await terminateProcessTree(child); }
