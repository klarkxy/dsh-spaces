import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { refuseRealHome } from './lib/distribution-harness.mjs';

const REPO = resolve(import.meta.dirname, '..');
const CHECKS = ['check:test-lists', 'catalog:check', 'test:catalog', 'typecheck', 'typecheck:spaces', 'typecheck:tests', 'build',
  'test', 'test:spaces', 'test:workbench', 'test:workbench:recovery', 'test:llm',
  'test:blueprints', 'test:browser', 'check:plugin-package', 'test:workbench:browser', 'test:release'];

export function assertCheckTempRoot(tempRoot, repo = REPO, platform = process.platform) {
  refuseRealHome(tempRoot);
  const actual = realpathSync.native(tempRoot);
  refuseRealHome(actual);
  const rel = relative(realpathSync.native(repo), actual);
  const inside = rel === '' || (!isAbsolute(rel) && rel.split(sep)[0] !== '..');
  if (platform === 'win32' && inside) {
    throw new Error('Windows checks require a temporary directory outside the repository: a workspace reader can hold a child open and make an atomic directory rename fail with EPERM. Set --temp-root to an existing writable external directory. No checks were started.');
  }
  return actual;
}

export function createCheckEnvironment({ tempRoot = tmpdir(), repo = REPO, platform = process.platform, env = process.env } = {}) {
  const parent = assertCheckTempRoot(tempRoot, repo, platform);
  const directory = mkdtempSync(join(parent, 'dsh-spaces-check-'));
  const home = join(directory, 'home');
  return { directory, env: { ...env, TMP: directory, TEMP: directory, TMPDIR: directory,
    DSH_HOME: home, DSH_SPACES_HOME: home, DSH_SPACES_WEB_HOME: home,
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_store_dir: join(directory, 'pnpm-store'),
    pnpm_config_store_dir: join(directory, 'pnpm-store'),
    pnpm_config_cache_dir: join(directory, 'pnpm-cache'),
  } };
}

export function resolvePnpmCommand({ nodeExe = process.execPath, env = process.env, platform = process.platform } = {}) {
  const override = env.DSH_TEST_PNPM_CJS?.trim();
  if (override) {
    const resolved = resolve(override);
    if (!existsSync(resolved)) throw new Error(`DSH_TEST_PNPM_CJS is missing: ${resolved}`);
    return { command: nodeExe, prefixArgs: [resolved] };
  }
  const execPath = env.npm_execpath?.trim();
  if (execPath) {
    const resolved = resolve(execPath);
    if (existsSync(resolved) && /^pnpm(?:\.(?:c?js|mjs|exe))?$/i.test(basename(resolved))) {
      if (/\.(?:c?js|mjs)$/i.test(resolved)) return { command: nodeExe, prefixArgs: [resolved] };
      return { command: resolved, prefixArgs: [] };
    }
  }
  const found = spawnSync(platform === 'win32' ? 'where.exe' : 'which', ['pnpm'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  for (const line of (found.stdout || '').split(/\r?\n/)) {
    const loc = line.trim();
    if (!loc) continue;
    const cjs = join(dirname(loc), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (existsSync(cjs)) return { command: nodeExe, prefixArgs: [resolve(cjs)] };
    if (platform !== 'win32' || loc.toLowerCase().endsWith('.exe')) {
      return { command: resolve(loc), prefixArgs: [] };
    }
  }
  const fallback = env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') : '';
  if (fallback && existsSync(fallback)) return { command: nodeExe, prefixArgs: [resolve(fallback)] };
  throw new Error('pnpm not found. Put pnpm on PATH or set DSH_TEST_PNPM_CJS.');
}

export async function main(argv = process.argv.slice(2)) {
  let output, tempRoot = tmpdir();
  for (let i = 0; i < argv.length; i++) {
    if (!['--output', '--temp-root'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: check-all.mjs [--output new-directory] [--temp-root external-directory]');
    const flag = argv[i++], value = resolve(argv[i]);
    if (flag === '--output') output = value; else tempRoot = value;
  }
  // Validate before creating output or starting any child. Never silently change a caller's temp root.
  assertCheckTempRoot(tempRoot);
  if (output) { refuseRealHome(output); mkdirSync(output); } else {
    mkdirSync(join(REPO, '.sandbox'), { recursive: true });
    output = mkdtempSync(join(REPO, '.sandbox', 'checks-'));
  }
  const isolated = createCheckEnvironment({ tempRoot });
  const pnpm = resolvePnpmCommand();
  const result = { status: 'running', output, temp: isolated.directory, checks: [] };
  const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  save();
  console.log(`Evidence: ${output}\nIsolated temporary directory: ${isolated.directory}`);
  for (const check of CHECKS) {
    const log = join(output, check.replaceAll(':', '-') + '.log');
    const fd = openSync(log, 'wx'), started = Date.now();
    console.log(`RUN ${check}`);
    let code, error;
    try {
      const child = spawn(pnpm.command, [...pnpm.prefixArgs, 'run', check], { cwd: REPO, env: { ...isolated.env, DSH_SPACES_BUILD_TARGET: 'distribution' },
        windowsHide: true, stdio: ['ignore', fd, fd] });
      [code] = await once(child, 'close');
    } catch (cause) { code = null; error = String(cause); }
    finally { closeSync(fd); }
    result.checks.push({ check, code, ...(error ? { error } : {}), durationMs: Date.now() - started, log });
    save();
    console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${check}\n${readFileSync(log, 'utf8').trim().split(/\r?\n/).slice(-8).join('\n')}`);
    // Test groups are independent. A failed preparation cannot validate its dependent build/tests.
    if (code !== 0 && CHECKS.indexOf(check) <= CHECKS.indexOf('build')) break;
  }
  result.status = result.checks.length === CHECKS.length && result.checks.every(row => row.code === 0) ? 'passed' : 'failed';
  result.finishedAt = new Date().toISOString();
  save();
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1; });
