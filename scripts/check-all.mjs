import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveNpmCli } from './pack-spaces-plugin.mjs';
import { refuseRealHome } from './lib/distribution-harness.mjs';

const REPO = resolve(import.meta.dirname, '..');
const CHECKS = ['check:test-lists', 'typecheck', 'typecheck:spaces', 'typecheck:tests', 'build',
  'test', 'test:spaces', 'test:workbench', 'test:workbench:recovery', 'test:llm',
  'test:blueprints', 'test:browser', 'check:plugin-package', 'test:workbench:browser'];

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
  const npm = resolveNpmCli(process.execPath);
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
      const child = spawn(process.execPath, [npm, 'run', check], { cwd: REPO, env: { ...isolated.env, DSH_SPACES_BUILD_TARGET: 'npm' },
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
