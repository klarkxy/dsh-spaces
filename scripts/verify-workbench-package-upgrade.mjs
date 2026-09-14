#!/usr/bin/env node
/**
 * Workbench manager-package upgrade acceptance. Isolated Home only.
 * Packed supervisor for success. Source-seam driver for rollback inject
 * (not a packed-product failure). Real dsh plugin add. No model calls.
 *
 * Does not import verify-workbench-maintenance-product.mjs,
 * verify-workbench-product.mjs, or verify-workbench-interactions.mjs
 * (those parse argv / run at load). Safe to import this file; main is guarded.
 *
 *   node scripts/verify-workbench-package-upgrade.mjs [--phase success|rollback|all]
 *     [--self-check] [--http-only] [--with-browser] [--output DIR] [--home DIR]
 *     [--job-ms N]
 *
 * Reuses `.sandbox/workbench-maintenance-network-acceptance/results.json`
 * `phases.runtime.home` when present. New Homes are created only under
 * `.sandbox/workbench-package-acceptance`. Never ~/.dsh. Never prints tokens.
 *
 * Env: DSH_TEST_BIN, DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE,
 * DSH_TEST_OUTPUT, DSH_TEST_HOME, DSH_TEST_PNPM_CJS, DSH_TEST_JOB_MS.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_BIN,
  isolatedEnv,
  refuseRealHome,
  resolveNpmCli,
  resolvePnpmCjs,
  run,
  runDsh,
  stopOwned,
  writePnpmShim,
  cliVersion,
  sha256File,
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const NETWORK_SOURCE = join(root, '.sandbox', 'workbench-maintenance-network-acceptance');
const DEFAULT_OUTPUT = join(root, '.sandbox', 'workbench-package-acceptance');
const DRIVER = join(root, 'tests/fixtures/workbench-package/driver.ts');
const PACKED_SUPERVISOR = join(root, 'packages/supervisor/lib/index.js');
const PACKED_WORKER = join(root, 'packages/supervisor/lib/snapshot-worker.mjs');
const PRODUCT_SCRIPT = join(root, 'scripts/verify-workbench-product.mjs');
const MAINTENANCE_SCRIPT = join(root, 'scripts/verify-workbench-maintenance-product.mjs');
const INTERACTIONS_SCRIPT = join(root, 'scripts/verify-workbench-interactions.mjs');
const DEFAULT_PLAYWRIGHT =
  'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const SPACE = 'coding';
const SPACE_NAME = '编程';
const PHASES = ['success', 'rollback'];
const PLUGIN_FILES = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
  'lib/supervisor/manifest.json',
  'lib/supervisor/index.js',
  'lib/supervisor/snapshot-worker.mjs',
];
const BRIDGE_FILES = ['package.json', 'lib/index.js', 'lib/client.js'];
const SUPERVISOR_MS = 240_000;
const SEED_MS = 180_000;
const HEARTBEAT_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 3_000;
const JOB_QUERY_MS = 5_000;
const DEFAULT_JOB_MS = 900_000;
const PACK_MS = 60_000;
const GUIDE_MS = 15_000;

export const PACKAGE_PHASES = PHASES;

function parseFlags(argv) {
  let phase = 'all';
  let selfCheck = false;
  let httpOnly = false;
  let out = process.env.DSH_TEST_OUTPUT || DEFAULT_OUTPUT;
  let home = process.env.DSH_TEST_HOME || '';
  let jobMs = Number(process.env.DSH_TEST_JOB_MS || DEFAULT_JOB_MS);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--self-check') {
      selfCheck = true;
      continue;
    }
    if (token === '--http-only') {
      httpOnly = true;
      continue;
    }
    if (token === '--with-browser') {
      httpOnly = false;
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const take = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) throw new Error(`missing value for ${name}`);
      i += 1;
      return next;
    };
    if (name === '--phase') phase = take();
    else if (name === '--output') out = take();
    else if (name === '--home') home = take();
    else if (name === '--job-ms') jobMs = Number(take());
    else throw new Error(`unknown flag: ${token}`);
  }
  if (!['all', 'self-check', ...PHASES].includes(phase)) {
    throw new Error(`unknown --phase ${phase}; expected success|rollback|all`);
  }
  if (!Number.isFinite(jobMs) || jobMs < 60_000 || jobMs > 15 * 60_000) {
    throw new Error('--job-ms must be between 60000 and 900000 (15 min budget)');
  }
  return {
    phase,
    selfCheck: selfCheck || phase === 'self-check',
    httpOnly,
    output: resolve(out),
    home: home.trim() ? resolve(home.trim()) : '',
    jobMs,
  };
}

const redact = value =>
  String(value)
    .replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/\/bootstrap\/[^\s"'<>]+/g, '/bootstrap/[redacted]')
    .replace(/(dsh-auth-[^=\s]+)=([^;\s"']+)/g, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer [redacted]')
    .replace(/"nonce"\s*:\s*"[^"]+"/g, '"nonce":"[redacted]"');

function insideDir(rootDir, target) {
  const rel = relative(resolve(rootDir), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function allowedHome(home) {
  return insideDir(DEFAULT_OUTPUT, home) || insideDir(NETWORK_SOURCE, home);
}

function persist(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, name), `${new Date().toISOString()} ${text}\n`);
}

function stripSecrets(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) {
      delete next[key];
    }
  }
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function controlDir(home) {
  return join(home, '.dsh-spaces-control');
}

function readToolchain(home) {
  const path = join(controlDir(home), 'toolchain.json');
  if (!existsSync(path)) throw new Error('Home private toolchain.json is missing');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.version !== 1) throw new Error(`toolchain.json version ${record.version} is not 1`);
  for (const key of ['bin', 'nodeExe', 'toolchainRoot', 'runtimeRoot', 'snapshotRoot']) {
    if (!record[key] || !isAbsolute(String(record[key]))) {
      throw new Error(`toolchain.json missing absolute ${key}`);
    }
    if (!existsSync(record[key]) && key !== 'runtimeRoot') {
      throw new Error(`toolchain.json ${key} does not exist`);
    }
  }
  return record;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { unreadable: true, error: redact(error instanceof Error ? error.message : error) };
  }
}

function managerIdOf(home) {
  const body = readJsonIfPresent(join(controlDir(home), 'manager.json'));
  if (body?.profileId && typeof body.profileId === 'string') return body.profileId;
  return 'spaces-hub';
}

function installedFile(home, managerId, packageName, rel) {
  return join(home, 'profiles', managerId, 'node_modules', ...packageName.split('/'), ...rel.split('/'));
}

function hashIfPresent(path) {
  if (!existsSync(path)) return null;
  return sha256File(path);
}

function packageFileHashes(home, managerId) {
  const files = {};
  for (const rel of PLUGIN_FILES) {
    const path = installedFile(home, managerId, '@dsh-spaces/plugin', rel);
    files[`plugin:${rel}`] = { path, sha256: hashIfPresent(path) };
  }
  for (const rel of BRIDGE_FILES) {
    const path = installedFile(home, managerId, '@dsh-spaces/view-bridge', rel);
    files[`bridge:${rel}`] = { path, sha256: hashIfPresent(path) };
  }
  files['manager:package.json'] = {
    path: join(home, 'profiles', managerId, 'package.json'),
    sha256: hashIfPresent(join(home, 'profiles', managerId, 'package.json')),
  };
  return files;
}

function markerPaths(home) {
  return {
    hub: join(home, 'hub', SPACE, 'sessions', 'package-acceptance-marker.txt'),
    home: join(home, 'sessions', SPACE, 'package-acceptance-marker.txt'),
  };
}

function writeMarkers(home, body) {
  const paths = markerPaths(home);
  mkdirSync(dirname(paths.hub), { recursive: true });
  mkdirSync(dirname(paths.home), { recursive: true });
  writeFileSync(paths.hub, body, 'utf8');
  writeFileSync(paths.home, body, 'utf8');
}

function readMarkers(home) {
  const paths = markerPaths(home);
  return {
    hub: existsSync(paths.hub) ? readFileSync(paths.hub, 'utf8') : null,
    home: existsSync(paths.home) ? readFileSync(paths.home, 'utf8') : null,
  };
}

function runtimePointer(runtimeRoot) {
  const path = join(runtimeRoot, 'current.json');
  if (!existsSync(path)) return { path, present: false, sha256: null };
  return { path, present: true, sha256: sha256File(path), body: readJsonIfPresent(path) };
}

function snapshotState(home, runtimeRoot, label) {
  const managerId = managerIdOf(home);
  return {
    label,
    at: new Date().toISOString(),
    managerId,
    files: packageFileHashes(home, managerId),
    markers: readMarkers(home),
    runtime: runtimePointer(runtimeRoot),
  };
}

function fileMapEqual(before, after, keys) {
  for (const key of keys) {
    assert.equal(after[key]?.sha256, before[key]?.sha256, `${key} hash changed`);
  }
}

function supervisorPayloadKeys() {
  return [
    'plugin:lib/supervisor/manifest.json',
    'plugin:lib/supervisor/index.js',
    'plugin:lib/supervisor/snapshot-worker.mjs',
  ];
}

function assertPublicDto(value, label) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /"nonce"\s*:/, `${label} leaked nonce`);
  assert.doesNotMatch(json, /"pid"\s*:\s*\d+/, `${label} leaked pid`);
  assert.doesNotMatch(json, /Bearer /i, `${label} leaked bearer`);
  assert.doesNotMatch(json, /dsh-auth-/i, `${label} leaked cookie name`);
  assert.doesNotMatch(json, /bootstrap\//i, `${label} leaked bootstrap path`);
  assert.doesNotMatch(json, /[?&]token=/i, `${label} leaked token`);
  assert.doesNotMatch(json, /host\.bearer/i, `${label} leaked host bearer path`);
  assert.doesNotMatch(json, /\\\\users\\\\[^\\s"]+\\\\.dsh/i, `${label} leaked production Home path`);
}

function jobByExactId(jobs, id, label) {
  if (typeof id !== 'string' || !id) throw new Error(`${label}: exact job id is required`);
  const found = (jobs || []).find(item => item.id === id);
  if (!found) throw new Error(`${label}: exact job ${id} missing from state.jobs`);
  return found;
}

function productModuleSafety(path) {
  const source = readFileSync(path, 'utf8');
  const hasInvokedGuard = /const invoked = process\.argv\[1\]/.test(source);
  const parsesArgvAtLoad = /parseFlags\(process\.argv\.slice\(2\)\)/.test(source);
  return {
    path,
    safeImport: hasInvokedGuard && !parsesArgvAtLoad,
    hasInvokedGuard,
    parsesArgvAtLoad,
  };
}

function scriptImportsUnsafe(source) {
  return {
    product: /from\s+['"]\.\/verify-workbench-product\.mjs['"]/.test(source),
    interactions: /from\s+['"]\.\/verify-workbench-interactions\.mjs['"]/.test(source),
    maintenance: /from\s+['"]\.\/verify-workbench-maintenance-product\.mjs['"]/.test(source),
    fulfill: /route\.fulfill\s*\(/.test(source),
    cookieUrlAndPath: /addCookies\([\s\S]{0,400}url\s*:[\s\S]{0,200}path\s*:/.test(source)
      || /addCookies\([\s\S]{0,400}path\s*:[\s\S]{0,200}url\s*:/.test(source),
    recoveryRequiredMatch: /jobs\.find\([^)]*recovery-required/.test(source),
  };
}

export async function runSelfCheck(outputDir = DEFAULT_OUTPUT) {
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  const report = {
    status: 'running',
    mode: 'self-check',
    realDsh: false,
    packedRestoreEntry: true,
    injectSeam: 'source-test-seam',
    modelCalls: false,
    startedAt: new Date().toISOString(),
  };
  const checks = [];
  const fail = (name, error) => {
    checks.push({ name, ok: false, error: redact(error instanceof Error ? error.message : error) });
  };
  const pass = (name, extra) => {
    checks.push({ name, ok: true, ...extra });
  };

  const script = join(root, 'scripts/verify-workbench-package-upgrade.mjs');
  const syntax = spawnSync(node, ['--check', script], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (syntax.status !== 0) fail('syntax verify-workbench-package-upgrade.mjs', syntax.stderr || syntax.stdout);
  else pass('syntax verify-workbench-package-upgrade.mjs');

  try {
    const source = readFileSync(script, 'utf8');
    const unsafe = scriptImportsUnsafe(source);
    if (unsafe.product || unsafe.interactions || unsafe.maintenance) fail('no-unsafe-imports', unsafe);
    else pass('no-unsafe-imports');
    if (unsafe.fulfill) fail('no-route-fulfill', 'script contains route.fulfill');
    else pass('no-route-fulfill');
    if (unsafe.cookieUrlAndPath) fail('playwright-cookie-no-url-and-path', 'addCookies uses url and path together');
    else pass('playwright-cookie-no-url-and-path');
    if (unsafe.recoveryRequiredMatch) fail('job-id-exact', 'script matches any recovery-required job');
    else if (!source.includes('jobByExactId')) fail('job-id-exact', 'missing jobByExactId');
    else pass('job-id-exact');
    if (!source.includes('import.meta.url === pathToFileURL(process.argv[1]).href')) {
      fail('import-guard', 'missing invoked guard');
    } else pass('import-guard');
    if (/createRequire/.test(source) && !source.includes('import { createRequire as __createRequire }')) {
      fail('esm-require-banner', 'createRequire without ESM banner');
    } else pass('esm-require-banner');
    if (!source.includes('workbench-package-acceptance')) fail('independent-output', 'default output is not workbench-package-acceptance');
    else pass('independent-output');
    if (!source.includes('phases.runtime.home')) fail('reuse-prior-home', 'script does not read phases.runtime.home');
    else pass('reuse-prior-home');
    if (!source.includes("kind: 'controller.acquire'") && !source.includes('kind: "controller.acquire"')) {
      fail('explicit-acquire', 'cold start must POST controller.acquire');
    } else pass('explicit-acquire');
    const heartbeatFn = source.slice(source.indexOf('function startEntryHeartbeat'), source.indexOf('function makeApi'));
    if (!heartbeatFn.includes('function startEntryHeartbeat') || /spawnSync/.test(heartbeatFn)) {
      fail('entry-heartbeat-async-fetch', 'startEntryHeartbeat missing or uses spawnSync');
    } else pass('entry-heartbeat-async-fetch');
  } catch (error) {
    fail('source-policy', error);
  }

  for (const [name, path] of [
    ['product', PRODUCT_SCRIPT],
    ['maintenance', MAINTENANCE_SCRIPT],
    ['interactions', INTERACTIONS_SCRIPT],
  ]) {
    try {
      const safety = productModuleSafety(path);
      if (safety.safeImport) fail(`${name}-module-not-imported`, `${name} looks import-safe now; re-evaluate before sharing helpers`);
      else pass(`${name}-module-unsafe-not-imported`, safety);
    } catch (error) {
      fail(`${name}-module-unsafe-not-imported`, error);
    }
  }

  try {
    const dist = await import(pathToFileURL(join(root, 'scripts/verify-spaces-distribution.mjs')).href);
    assert.equal(typeof dist.refuseRealHome, 'function');
    assert.equal(typeof dist.isolatedEnv, 'function');
    assert.equal(typeof dist.stopOwned, 'function');
    pass('distribution-helpers-safe-import');
  } catch (error) {
    fail('distribution-helpers-safe-import', error);
  }

  try {
    const imported = await import(pathToFileURL(script).href);
    assert.equal(typeof imported.runSelfCheck, 'function');
    const probe = spawnSync(node, ['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(script).href)}; console.log('import-ok')`], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20_000, env: { ...process.env, DSH_TEST_HOME: '' },
    });
    const probeOut = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    if (probe.status !== 0 || !probeOut.includes('import-ok')) fail('import-does-not-launch', probeOut.slice(0, 400));
    else if (/bootstrap=|PASS |supervisor launched/i.test(probeOut)) fail('import-does-not-launch', 'import started a live run');
    else pass('import-does-not-launch');
  } catch (error) {
    fail('import-does-not-launch', error);
  }

  try {
    if (!existsSync(PACKED_SUPERVISOR) || !existsSync(PACKED_WORKER)) {
      fail('packed-supervisor', 'packages/supervisor/lib is missing');
    } else pass('packed-supervisor', { supervisor: PACKED_SUPERVISOR, worker: PACKED_WORKER });
  } catch (error) {
    fail('packed-supervisor', error);
  }

  try {
    const result = spawnSync(node, ['--import', 'tsx', DRIVER, '--self-check'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env },
    });
    if (result.status !== 0) fail('package-driver-self-check', result.stderr || result.stdout);
    else if (!String(result.stdout).includes('package-driver-self-check=ok')) fail('package-driver-self-check', result.stdout);
    else pass('package-driver-self-check', { stdout: String(result.stdout).trim() });
  } catch (error) {
    fail('package-driver-self-check', error);
  }

  try {
    const refused = spawnSync(node, ['--import', 'tsx', DRIVER, '--allow-real-home', '--home', 'C:\\nope', '--bin', 'C:\\nope'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env },
    });
    const text = `${refused.stderr || ''}\n${refused.stdout || ''}`;
    if (refused.status === 0) fail('driver-refuses-allow-real-home', 'driver accepted --allow-real-home');
    else if (!/isolated Home only/i.test(text)) fail('driver-refuses-allow-real-home', text.slice(0, 400));
    else pass('driver-refuses-allow-real-home');
  } catch (error) {
    fail('driver-refuses-allow-real-home', error);
  }

  try {
    const production = join(homedir(), '.dsh');
    const refused = spawnSync(node, ['--import', 'tsx', DRIVER, '--home', production, '--bin', node, '--plugin-artifact', node, '--view-bridge-artifact', node, '--snapshot-worker', PACKED_WORKER], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env },
    });
    const text = `${refused.stderr || ''}\n${refused.stdout || ''}`;
    if (refused.status === 0) fail('driver-refuses-production-home', 'driver accepted production Home');
    else if (!/isolated Home|refusing production Home/i.test(text)) fail('driver-refuses-production-home', text.slice(0, 400));
    else pass('driver-refuses-production-home');
  } catch (error) {
    fail('driver-refuses-production-home', error);
  }

  report.checks = checks;
  report.status = checks.every(row => row.ok) ? 'pass' : 'fail';
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'self-check.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'pass') {
    const first = checks.find(row => !row.ok);
    throw new Error(`self-check failed: ${first?.name}: ${first?.error}`);
  }
  return report;
}

function resolvePrior(requestedHome) {
  const priorPath = join(NETWORK_SOURCE, 'results.json');
  if (!existsSync(priorPath)) {
    throw new Error(`missing ${priorPath}; reuse phases.runtime.home from a passing maintenance-network-acceptance run`);
  }
  const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
  const runtime = prior.phases?.runtime;
  if (!runtime?.home) throw new Error('results.json missing phases.runtime.home');
  if (runtime.status !== 'pass' && prior.status !== 'pass') {
    throw new Error(`maintenance-network-acceptance runtime status is ${runtime.status}, not pass`);
  }
  const home = resolve(requestedHome || runtime.home);
  if (!allowedHome(home)) {
    throw new Error(`home must stay under ${NETWORK_SOURCE} or ${DEFAULT_OUTPUT}`);
  }
  if (requestedHome && insideDir(NETWORK_SOURCE, home) && resolve(home) !== resolve(runtime.home)) {
    throw new Error('Home under the network-acceptance sandbox must be the verified phases.runtime.home');
  }
  refuseRealHome(home);
  if (!prior.artifacts?.plugin?.path || !existsSync(prior.artifacts.plugin.path)) {
    throw new Error('packed plugin artifact from network-acceptance results is missing');
  }
  if (!prior.artifacts?.bridge?.path || !existsSync(prior.artifacts.bridge.path)) {
    throw new Error('packed view-bridge artifact from network-acceptance results is missing');
  }
  return { home, prior, runtimeHome: resolve(runtime.home), priorPath };
}

function packArtifact(name, packDir, env) {
  const npm = resolveNpmCli(node);
  const result = run(node, [npm, 'pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: root,
    env,
    timeoutMs: PACK_MS,
    label: `pack ${name}`,
  });
  const rows = JSON.parse(result);
  const file = join(packDir, rows[0].filename);
  assert.ok(existsSync(file), `packed ${name} missing`);
  return file;
}

function playwrightIndex() {
  const candidates = [
    process.env.DSH_TEST_PLAYWRIGHT,
    process.env.DSH_TEST_PLAYWRIGHT_MODULE
      ? join(process.env.DSH_TEST_PLAYWRIGHT_MODULE, 'index.mjs')
      : '',
    DEFAULT_PLAYWRIGHT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = resolve(candidate);
    if (existsSync(file)) return file;
  }
  throw new Error('Playwright missing; set DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE');
}

async function loadChromium() {
  const file = playwrightIndex();
  const mod = await import(pathToFileURL(file).href);
  if (!mod.chromium) throw new Error(`Playwright at ${file} has no chromium export`);
  return mod.chromium;
}

async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}${last ? ` last=${redact(JSON.stringify(last).slice(0, 400))}` : ''}`);
}

function supervisorExit(session) {
  const child = session?.supervisor;
  if (!child) return { exitCode: null, signal: 'missing' };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode, pid: child.pid };
  }
  return null;
}

function isTransportError(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
  if (/workbench\//i.test(text)) return false;
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|AbortError|TimeoutError|Timeout \d+ms exceeded|network|ECONN/i.test(text);
}

function transportSummary(error) {
  return redact(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240);
}

function nextBackoff(attempt) {
  return Math.min(2000, 250 * 2 ** Math.min(attempt, 3));
}

function cookieFromSetCookie(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const joined = raw.map(value => value.split(';')[0]).filter(Boolean).join('; ');
  assert.ok(joined, 'bootstrap did not set an auth cookie');
  return joined;
}

function startEntryHeartbeat(session) {
  let stopped = false;
  let lastOk = Date.now();
  let maxMs = 0;
  let maxGapMs = 0;
  const failures = [];
  const tick = async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const response = await fetch(`${session.origin}/`, {
          headers: { cookie: session.cookie },
          redirect: 'manual',
          signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        });
        const ms = Date.now() - started;
        maxMs = Math.max(maxMs, ms);
        await response.arrayBuffer();
        if (!stopped && response.status === 200) lastOk = Date.now();
        else if (!stopped) {
          failures.push({ at: new Date().toISOString(), summary: `GET / ${response.status}`, ms });
          maxGapMs = Math.max(maxGapMs, Date.now() - lastOk);
        }
      } catch (error) {
        const ms = Date.now() - started;
        maxMs = Math.max(maxMs, ms);
        if (!stopped) {
          failures.push({ at: new Date().toISOString(), summary: transportSummary(error), ms });
          maxGapMs = Math.max(maxGapMs, Date.now() - lastOk);
        }
      }
      const wait = Math.max(0, HEARTBEAT_MS - (Date.now() - started));
      if (stopped) break;
      await delay(wait);
    }
  };
  void tick();
  return {
    stop() {
      stopped = true;
      maxGapMs = Math.max(maxGapMs, Date.now() - lastOk);
      return {
        maxMs,
        maxGapMs,
        failures: failures.slice(0, 20),
        outageFail: maxGapMs >= HEARTBEAT_TIMEOUT_MS,
      };
    },
  };
}

function makeApi(origin, cookie) {
  return async (method, payload = {}, timeout = 30000) => {
    const result = await fetch(`${origin}/api/workbench/${method}`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await result.json();
    if (!body.ok) throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
    return body.value;
  };
}

async function readJobOnce(session, id) {
  try {
    const result = await fetch(`${session.origin}/api/workbench/job`, {
      method: 'POST',
      headers: { origin: session.origin, cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(JOB_QUERY_MS),
    });
    const body = await result.json();
    if (!body.ok) throw new Error(`job: ${body.error?.code} ${body.error?.message}`);
    return { ok: true, value: body.value };
  } catch (error) {
    return { ok: false, error };
  }
}

async function waitExactJob(session, jobId, options = {}) {
  const timeout = options.timeout ?? DEFAULT_JOB_MS;
  const label = options.label || jobId;
  const expect = options.expect || 'succeeded';
  const heartbeat = startEntryHeartbeat(session);
  const transport = [];
  let latest;
  let runError;
  try {
    const deadline = Date.now() + timeout;
    let attempt = 0;
    while (Date.now() < deadline) {
      const death = supervisorExit(session);
      if (death) throw new Error(`${label}: supervisor exited during job query exitCode=${death.exitCode} signal=${death.signal}`);
      const read = await readJobOnce(session, jobId);
      if (read.ok) {
        latest = read.value;
        if (latest.id !== jobId) throw new Error(`${label}: job endpoint returned ${latest.id}, expected exact ${jobId}`);
        attempt = 0;
        if (!['queued', 'running'].includes(latest.status)) break;
        await delay(250);
        continue;
      }
      if (!isTransportError(read.error)) throw read.error;
      transport.push({ at: new Date().toISOString(), summary: transportSummary(read.error) });
      await delay(nextBackoff(attempt));
      attempt += 1;
    }
  } catch (error) {
    runError = error;
  }
  const heartbeatStats = heartbeat.stop();
  session.observations ??= { jobs: [] };
  session.observations.jobs.push({
    label,
    jobId,
    status: latest?.status,
    phase: latest?.phase,
    transport,
    heartbeat: heartbeatStats,
    expect,
  });
  const pending = !latest || ['queued', 'running'].includes(latest.status);
  if (pending && runError && !isTransportError(runError)) throw runError;
  if (pending) {
    throw new Error(`${label}: timed out without a terminal job; last=${latest?.status ?? 'none'} ${latest?.phase ?? ''} transport=${transport.length}`);
  }
  if (heartbeatStats.outageFail) {
    throw new Error(
      `${label}: stable entry unavailable for ${heartbeatStats.maxGapMs}ms (limit ${HEARTBEAT_TIMEOUT_MS}ms); ` +
      `job reached ${latest.status}/${latest.phase}; maxGetMs=${heartbeatStats.maxMs} failures=${heartbeatStats.failures.length}`,
    );
  }
  if (expect === 'failed') {
    assert.equal(latest.status, 'failed', `${label}: expected failed, got ${latest.status} ${JSON.stringify(latest.error)}`);
  } else {
    assert.equal(latest.status, 'succeeded', `${label}: ${JSON.stringify(latest.error)}`);
  }
  if (runError) throw runError;
  return latest;
}

async function submitJob(session, command, options = {}) {
  const requestId = options.requestId || randomUUID();
  const first = await session.api('submit', { command, requestId });
  assert.equal(first.id, requestId, `job id must equal requestId; got ${first.id}`);
  const latest = await waitExactJob(session, first.id, { ...options, label: options.label || command.kind });
  return latest;
}

async function assertStableEntry(session) {
  const response = await fetch(`${session.origin}/`, {
    headers: { cookie: session.cookie },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.length > 0, 'stable entry returned an empty document');
  return html;
}

async function acquireController(session) {
  const before = await session.api('state');
  assertPublicDto(before, 'state before acquire');
  if (before.writable) return before;
  if (session.page) {
    const acquire = session.page.locator('#acquire');
    const visible = await acquire.isVisible().catch(() => false);
    const disabled = visible ? await acquire.isDisabled().catch(() => true) : true;
    if (visible && !disabled) await acquire.click();
    await delay(500);
    const afterClick = await session.api('state').catch(() => null);
    if (afterClick?.writable) return afterClick;
  }
  const job = await session.api('submit', { command: { kind: 'controller.acquire' }, requestId: randomUUID() });
  assert.equal(job.status, 'succeeded', 'explicit reclaim of a proven-dead test controller failed');
  const after = await session.api('state');
  assert.equal(after.writable, true, 'cold start requires controller.acquire; tryOwn must not be assumed');
  return after;
}

async function authorize(session, httpOnly) {
  const bootstrapUrl = session.bootstrapUrl;
  if (httpOnly) {
    const response = await fetch(bootstrapUrl, { redirect: 'manual' });
    await response.body?.cancel();
    assert.equal(response.status, 303, 'bootstrap cookie exchange is 303 to /');
    session.cookie = cookieFromSetCookie(response.headers);
    session.api = makeApi(session.origin, session.cookie);
    return;
  }
  const chromium = await loadChromium();
  session.browser = await chromium.launch({ headless: true });
  session.context = await session.browser.newContext({ viewport: { width: 1440, height: 900 } });
  session.page = await session.context.newPage();
  session.browserErrors = [];
  session.page.on('pageerror', error => {
    session.browserErrors.push(redact(error.message));
  });
  session.page.on('console', message => {
    if (message.type() === 'error') session.browserErrors.push(redact(message.text()));
  });
  await session.page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await until(() => session.page.url() === `${session.origin}/`, 'clean stable entry URL');
  const cookies = await session.context.cookies();
  session.cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
  assert.ok(session.cookie, 'Playwright session cookie missing');
  session.api = makeApi(session.origin, session.cookie);
}

function spawnSupervisor(kind, args, env, phaseDir) {
  const spawnEnv = { ...env };
  delete spawnEnv.NODE_OPTIONS;
  const child = spawn(node, args, {
    cwd: root,
    env: spawnEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launchOutput = '';
  let stderr = '';
  child.stdout.on('data', chunk => { launchOutput = (launchOutput + chunk.toString()).slice(-32768); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });
  persist(phaseDir, 'run.log', `spawn ${kind} pid=${child.pid}`);
  return {
    kind,
    supervisor: child,
    launchOutput: () => launchOutput,
    stderr: () => stderr,
    observations: { jobs: [] },
  };
}

async function waitBootstrap(session, label) {
  await until(() => {
    if (session.supervisor.exitCode !== null) {
      throw new Error(`${label} exited ${session.supervisor.exitCode}: ${redact(session.stderr())}`);
    }
    return /bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(session.launchOutput());
  }, `${label} initialization`, SUPERVISOR_MS);
  const bootstrapUrl = session.launchOutput().match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1];
  session.bootstrapUrl = bootstrapUrl;
  session.origin = new URL(bootstrapUrl).origin;
}

async function launchPackedSupervisor(ctx) {
  const { home, artifacts, env, phaseDir, toolchain } = ctx;
  const args = [
    PACKED_SUPERVISOR,
    '--home', home,
    '--bin', toolchain.bin,
    '--node', toolchain.nodeExe,
    '--port', '0',
    '--plugin-artifact', artifacts.plugin.path,
    '--view-bridge-artifact', artifacts.bridge.path,
    '--snapshot-worker', PACKED_WORKER,
    '--control-tool-root', toolchain.toolchainRoot,
    '--snapshot-root', toolchain.snapshotRoot,
  ];
  const session = spawnSupervisor('packed-supervisor', args, env, phaseDir);
  Object.assign(session, { home, phaseDir, toolchain, packed: true });
  await waitBootstrap(session, 'packed supervisor');
  await authorize(session, ctx.httpOnly);
  return session;
}

async function launchFaultDriver(ctx) {
  const { home, artifacts, env, phaseDir, toolchain, markerDir } = ctx;
  const args = [
    '--import', 'tsx', DRIVER,
    '--home', home,
    '--bin', toolchain.bin,
    '--node', toolchain.nodeExe,
    '--port', '0',
    '--plugin-artifact', artifacts.plugin.path,
    '--view-bridge-artifact', artifacts.bridge.path,
    '--snapshot-worker', PACKED_WORKER,
    '--control-tool-root', toolchain.toolchainRoot,
    '--snapshot-root', toolchain.snapshotRoot,
    '--runtime-root', toolchain.runtimeRoot,
    '--marker-dir', markerDir,
    '--fault-digest-bridge-add',
  ];
  const session = spawnSupervisor('package-driver', args, env, phaseDir);
  Object.assign(session, { home, phaseDir, toolchain, packed: false, markerDir, injectSeam: 'source-test-seam' });
  await waitBootstrap(session, 'package driver');
  await authorize(session, ctx.httpOnly);
  return session;
}

async function shutdownOwned(session, label) {
  if (!session) return;
  try {
    if (session.api && !supervisorExit(session)) {
      const plan = await session.api('preview', { request: { kind: 'controller.shutdown' } });
      await session.api('submit', { command: { kind: 'plan.execute', planId: plan.id }, requestId: randomUUID() });
      await until(() => session.supervisor.exitCode !== null, `${label} supervisor clean shutdown`, 15_000);
    }
  } catch {
    /* Owned tree cleanup below. Never other Home processes. */
  }
  await session.browser?.close().catch(() => {});
  if (session.supervisor && session.supervisor.exitCode === null) await stopOwned(session.supervisor);
  if (session.phaseDir) {
    writeFileSync(
      join(session.phaseDir, `${label}-supervisor.log`),
      redact(`${session.launchOutput?.() ?? ''}\n${session.stderr?.() ?? ''}`),
    );
  }
}

async function screenshot(session, name) {
  if (!session.page) return null;
  const dir = join(session.phaseDir, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  await session.page.screenshot({ path, fullPage: true });
  return path;
}

async function dismissDshGuide(rootLocator) {
  for (const name of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
    const button = rootLocator.getByRole('button', { name }).first();
    await button.waitFor({ state: 'visible', timeout: GUIDE_MS }).catch(() => {});
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
  }
}

async function managerFrame(session) {
  const state = await session.api('state');
  assert.ok(state.managerId, 'managerId missing');
  const view = await session.api('view', { spaceId: state.managerId });
  await until(
    () => session.page.frames().some(frame => frame.url().startsWith(`${view.origin}/`)),
    'manager iframe',
    60_000,
  );
  const frame = session.page.frames().find(item => item.url().startsWith(`${view.origin}/`));
  await frame.locator('.dsh-wb-rail').waitFor({ state: 'visible', timeout: 60_000 });
  await dismissDshGuide(frame);
  return frame;
}

async function openRuntimePackageUi(session) {
  const hub = await managerFrame(session);
  const homeBtn = hub.getByRole('button', { name: /^(首页|Home)$/ }).first();
  if (await homeBtn.count()) await homeBtn.click();
  const runtimeTab = hub.getByRole('tab', { name: /^(运行时|Runtime)$/ }).first();
  await runtimeTab.waitFor({ state: 'visible', timeout: 30_000 });
  await runtimeTab.click();
  const section = hub.locator('[data-workbench-package="true"]');
  await section.waitFor({ state: 'visible', timeout: 30_000 });
  const content = hub.locator('[data-content-update="true"]');
  await content.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  return { hub, section };
}

async function uiPreviewAndConfirm(session) {
  const { hub } = await openRuntimePackageUi(session);
  const shotPackage = await screenshot(session, 'runtime-package.png');
  const preview = hub.locator('[data-workbench-upgrade="true"]');
  await preview.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await preview.isDisabled(), false, 'workbench upgrade preview is disabled');
  const beforeIds = new Set((await session.api('state')).jobs.map(item => item.id));
  await preview.click();
  const dialog = hub.locator('#dsh-wb-plan-title');
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  const shotPlan = await screenshot(session, 'upgrade-plan.png');
  const confirm = hub.locator('.dsh-wb-dialog button.primary[data-plan-id]');
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  const planId = await confirm.getAttribute('data-plan-id');
  await confirm.click();
  const appeared = await until(async () => {
    const jobs = (await session.api('state')).jobs;
    return jobs.find(item => !beforeIds.has(item.id) && item.kind === 'plan.execute') || null;
  }, 'plan.execute appeared in state.jobs', 30_000);
  return { jobId: appeared.id, planId, screenshots: [shotPackage, shotPlan] };
}

async function requireCandidate(session) {
  const release = await session.api('workbenchPackage', {});
  assertPublicDto(release, 'workbenchPackage');
  if (release == null) {
    const error = new Error('POST /api/workbench/workbenchPackage returned null; no candidate');
    error.uncovered = true;
    throw error;
  }
  if (release.id !== 'bundled-workbench') throw new Error(`unexpected catalog id ${release.id}`);
  if (!release.updateAvailable) {
    const error = new Error('no same-version content candidate; refusing to simulate');
    error.uncovered = true;
    throw error;
  }
  if (release.installedVersion !== release.version) {
    persist(session.phaseDir, 'run.log', `note installedVersion=${release.installedVersion} candidate=${release.version}; still a content or version update`);
  }
  return release;
}

async function ensureOrdinarySpace(session, jobMs) {
  let state = await session.api('state');
  let ordinary = state.spaces.find(space => space.id !== state.managerId);
  if (!ordinary) {
    await submitJob(session, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, {
      timeout: jobMs,
      label: 'space.create',
    });
    state = await session.api('state');
    ordinary = state.spaces.find(space => space.id === SPACE);
  }
  assert.ok(ordinary, 'ordinary space missing');
  if (ordinary.status !== 'running') {
    await submitJob(session, { kind: 'space.start', spaceId: ordinary.id }, { timeout: jobMs, label: 'space.start' });
  }
  writeMarkers(session.home, `package-acceptance-${ordinary.id}\n`);
  const running = (await session.api('state')).spaces.find(space => space.id === ordinary.id);
  assert.equal(running?.status, 'running');
  return ordinary.id;
}

function copyEvidence(home, dest) {
  mkdirSync(dest, { recursive: true });
  const files = {
    upgradeMarker: join(controlDir(home), 'workbench-upgrade.json'),
    toolchain: join(controlDir(home), 'toolchain.json'),
    manager: join(controlDir(home), 'manager.json'),
    spaces: join(home, 'hub', 'spaces.json'),
  };
  const copied = {};
  for (const [name, path] of Object.entries(files)) {
    if (!existsSync(path)) {
      copied[name] = null;
      continue;
    }
    writeFileSync(join(dest, `${name}.json`), readFileSync(path));
    copied[name] = { sha256: sha256File(path) };
  }
  const receiptsDir = join(controlDir(home), 'workbench-upgrade-receipts');
  const receipts = [];
  if (existsSync(receiptsDir)) {
    mkdirSync(join(dest, 'receipts'), { recursive: true });
    for (const name of readdirSync(receiptsDir).filter(item => item.endsWith('.json'))) {
      const path = join(receiptsDir, name);
      writeFileSync(join(dest, 'receipts', name), readFileSync(path));
      receipts.push({ id: name.replace(/\.json$/, ''), sha256: sha256File(path), body: readJsonIfPresent(path) });
    }
  }
  const jobsDir = join(controlDir(home), 'jobs');
  const jobs = [];
  if (existsSync(jobsDir)) {
    mkdirSync(join(dest, 'jobs'), { recursive: true });
    for (const name of readdirSync(jobsDir).filter(item => item.endsWith('.json'))) {
      const path = join(jobsDir, name);
      writeFileSync(join(dest, 'jobs', name), readFileSync(path));
      jobs.push({ id: name.replace(/\.json$/, ''), sha256: sha256File(path), body: readJsonIfPresent(path) });
    }
  }
  return { copied, receipts, jobs };
}

async function runSuccess(ctx, row, pass, uncovered, jobMs, httpOnly) {
  row.kind = 'same-version content upgrade via packed supervisor + real dsh plugin add';
  row.restoreEntry = 'packed supervisor';
  const session = await launchPackedSupervisor(ctx);
  row.origin = session.origin;
  try {
    let state = await acquireController(session);
    assert.equal(state.role, 'manager', JSON.stringify(state.reasons));
    const ordinaryId = await ensureOrdinarySpace(session, jobMs);
    const toolchain = readToolchain(session.home);
    assert.equal(resolve(toolchain.toolchainRoot), resolve(ctx.toolchain.toolchainRoot));
    assert.equal(resolve(toolchain.snapshotRoot), resolve(ctx.toolchain.snapshotRoot));
    assert.equal(resolve(toolchain.runtimeRoot), resolve(ctx.toolchain.runtimeRoot));
    const before = snapshotState(session.home, toolchain.runtimeRoot, 'before-success');
    row.before = before;
    const release = await requireCandidate(session);
    row.release = {
      id: release.id,
      version: release.version,
      installedVersion: release.installedVersion,
      digest: release.digest,
      updateAvailable: release.updateAvailable,
    };
    assert.equal(release.version, ctx.packedVersion);
    let jobId;
    let planId;
    const screenshots = [];
    if (!httpOnly && session.page) {
      await followLiveManager(session);
      const ui = await uiPreviewAndConfirm(session);
      jobId = ui.jobId;
      planId = ui.planId;
      screenshots.push(...ui.screenshots.filter(Boolean));
      const planJob = await waitExactJob(session, jobId, { timeout: jobMs, label: 'workbench.upgrade ui', expect: 'succeeded' });
      row.job = { id: planJob.id, status: planJob.status, phase: planJob.phase, result: planJob.result };
      row.plan = { id: planId, kind: 'workbench.upgrade' };
      row.ui = { jobId, planId, screenshots };
    } else {
      uncovered.push('success browser workbench package UI not exercised (--http-only)');
      const plan = await session.api('preview', {
        request: { kind: 'workbench.upgrade', catalogId: 'bundled-workbench', version: release.version },
      });
      assertPublicDto(plan, 'preview workbench.upgrade');
      assert.equal(plan.kind, 'workbench.upgrade');
      planId = plan.id;
      const job = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, {
        timeout: jobMs,
        label: 'workbench.upgrade',
        expect: 'succeeded',
      });
      jobId = job.id;
      row.job = { id: job.id, status: job.status, phase: job.phase, result: job.result };
      row.plan = { id: plan.id, kind: plan.kind, title: plan.title };
    }
    const afterState = await session.api('state');
    const persisted = jobByExactId(afterState.jobs, jobId, 'success state.jobs');
    assert.equal(persisted.status, 'succeeded');
    assert.equal(typeof persisted.result?.snapshotId, 'string');
    const after = snapshotState(session.home, toolchain.runtimeRoot, 'after-success');
    row.after = after;
    const pluginChanged = supervisorPayloadKeys().some(key => after.files[key]?.sha256 !== before.files[key]?.sha256)
      || after.files['plugin:lib/index.js']?.sha256 !== before.files['plugin:lib/index.js']?.sha256;
    assert.ok(pluginChanged, 'installed plugin/supervisor payload hashes did not change');
    assert.equal(after.markers.hub, before.markers.hub, 'user marker changed after successful package upgrade');
    assert.equal(after.runtime.sha256, before.runtime.sha256, 'current runtime pointer changed after package upgrade');
    const manager = afterState.spaces.find(space => space.id === afterState.managerId);
    const ordinary = afterState.spaces.find(space => space.id === ordinaryId);
    assert.equal(manager?.status, 'running', 'manager must return after package upgrade');
    assert.equal(ordinary?.status, 'stopped', 'ordinary spaces must stay stopped');
    await assertStableEntry(session);
    const receipts = copyEvidence(session.home, join(ctx.phaseDir, 'evidence-after')).receipts;
    const receipt = receipts.find(item =>
      item.body?.outcome === 'succeeded'
      && item.body?.snapshotId === persisted.result.snapshotId
      && (!planId || item.body?.planId === planId || item.id === planId),
    );
    assert.ok(receipt, 'succeeded receipt missing');
    row.receipt = receipt?.body;
    row.observations = session.observations;
    row.screenshots = screenshots;
    pass('success: same-version content installed via real plugin add; hashes/readback; whole-home snapshot; entry ≤3s; manager up; ordinary stopped; job persisted');
    if (httpOnly) row.partial = true;
  } finally {
    await shutdownOwned(session, 'success');
  }
}

async function followLiveManager(session) {
  await until(async () => {
    const state = await session.api('state');
    const manager = state.spaces.find(space => space.id === state.managerId);
    return manager?.status === 'running' && !state.recoveryRequired;
  }, 'manager running for UI', 120_000);
}

async function runRollback(ctx, row, pass, uncovered, jobMs, httpOnly) {
  row.kind = 'source-seam digest-named view-bridge pluginAdd throw; production whole-Home snapshot rollback';
  row.restoreEntry = 'source-test-seam driver (not packed product inject)';
  row.injectSeam = 'source-test-seam';
  const markerDir = join(ctx.phaseDir, 'markers');
  mkdirSync(markerDir, { recursive: true });
  const session = await launchFaultDriver({ ...ctx, markerDir });
  row.origin = session.origin;
  try {
    await acquireController(session);
    const ordinaryId = await ensureOrdinarySpace(session, jobMs);
    const toolchain = readToolchain(session.home);
    const before = snapshotState(session.home, toolchain.runtimeRoot, 'before-rollback');
    row.before = before;
    const release = await requireCandidate(session);
    row.release = {
      id: release.id,
      version: release.version,
      installedVersion: release.installedVersion,
      digest: release.digest,
      updateAvailable: release.updateAvailable,
    };
    if (!httpOnly && session.page) {
      await followLiveManager(session);
      await openRuntimePackageUi(session).catch(() => {
        uncovered.push('rollback UI package section not asserted; HTTP inject path continues');
      });
      await screenshot(session, 'rollback-runtime.png');
    } else {
      uncovered.push('rollback browser UI not exercised (--http-only)');
    }
    const plan = await session.api('preview', {
      request: { kind: 'workbench.upgrade', catalogId: 'bundled-workbench', version: release.version },
    });
    assertPublicDto(plan, 'rollback preview');
    const job = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, {
      timeout: jobMs,
      label: 'workbench.upgrade digest-bridge throw',
      expect: 'failed',
    });
    row.job = { id: job.id, status: job.status, phase: job.phase, error: job.error };
    row.plan = { id: plan.id, kind: plan.kind };
    const marker = readJsonIfPresent(join(markerDir, 'fault-marker.json'));
    assert.equal(marker?.kind, 'pluginAdd');
    assert.equal(marker?.seam, 'source-test-seam');
    assert.equal(marker?.notPackedProduct, true);
    assert.equal(marker?.digestBridge, true);
    assert.equal(marker?.firstPackageInstalled, true);
    assert.equal(marker?.pid, session.supervisor.pid);
    row.marker = marker;
    const after = snapshotState(session.home, toolchain.runtimeRoot, 'after-rollback');
    row.after = after;
    const keys = [
      ...PLUGIN_FILES.map(rel => `plugin:${rel}`),
      ...BRIDGE_FILES.map(rel => `bridge:${rel}`),
      'manager:package.json',
    ];
    fileMapEqual(before.files, after.files, keys);
    assert.equal(after.markers.hub, before.markers.hub, 'user marker changed after rollback');
    assert.equal(after.runtime.sha256, before.runtime.sha256, 'current runtime pointer changed after rollback');
    const afterState = await session.api('state');
    const persisted = jobByExactId(afterState.jobs, job.id, 'rollback state.jobs');
    assert.equal(persisted.status, 'failed', `original job must be failed, got ${persisted.status}`);
    const manager = afterState.spaces.find(space => space.id === afterState.managerId);
    const ordinary = afterState.spaces.find(space => space.id === ordinaryId);
    assert.equal(manager?.status, 'running', 'manager must reappear after rollback');
    assert.equal(ordinary?.status, 'stopped', 'ordinary spaces must stay stopped after rollback');
    await assertStableEntry(session);
    const receipts = copyEvidence(session.home, join(ctx.phaseDir, 'evidence-after')).receipts;
    const receipt = receipts.find(item => item.id === plan.id || item.body?.planId === plan.id);
    assert.equal(receipt?.body?.outcome, 'rolled-back');
    row.receipt = receipt?.body;
    row.observations = session.observations;
    pass('rollback: digest-named view-bridge pluginAdd threw after first package installed; production snapshot restored hashes/marker/runtime; job failed; entry up; manager running');
    if (httpOnly) row.partial = true;
  } finally {
    await shutdownOwned(session, 'rollback');
  }
}

function prepareTooling(output, priorOutput) {
  const fromPrior = ['shim', 'pnpmHome', 'store', 'cache'].every(key => existsSync(join(priorOutput, key)));
  const base = fromPrior ? priorOutput : output;
  const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(base, key)]));
  Object.values(tooling).forEach(path => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, node, resolvePnpmCjs());
  return tooling;
}

async function createFreshHome(homeRoot, phaseDir, tooling, oldArtifacts) {
  mkdirSync(homeRoot, { recursive: true });
  const home = mkdtempSync(join(homeRoot, 'home-'));
  refuseRealHome(home);
  if (!allowedHome(home)) throw new Error('fresh Home escaped workbench-package-acceptance');
  const tools = join(homeRoot, 'tools', basename(home));
  const snapshots = join(homeRoot, 'snapshots', basename(home));
  mkdirSync(tools, { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  const bin = process.env.DSH_TEST_BIN || DEFAULT_BIN;
  runDsh(node, bin, home, tooling, ['--profile', 'web', '--dump-config'], SEED_MS, 'seed web', join(phaseDir, 'seed.log'));
  const toolchain = {
    version: 1,
    bin: resolve(bin),
    nodeExe: node,
    dshVersion: cliVersion(bin),
    toolchainRoot: tools,
    runtimeRoot: tools,
    snapshotRoot: snapshots,
  };
  const session = await launchPackedSupervisor({
    home,
    artifacts: oldArtifacts,
    env: stripSecrets(isolatedEnv(home, toolchain.nodeExe, tooling)),
    phaseDir,
    toolchain,
    httpOnly: true,
  });
  try {
    await acquireController(session);
    await ensureOrdinarySpace(session, DEFAULT_JOB_MS);
  } finally {
    await shutdownOwned(session, 'fresh-bootstrap');
  }
  return { home, toolchain: readToolchain(home) };
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  mkdirSync(flags.output, { recursive: true });
  if (flags.selfCheck) {
    const report = await runSelfCheck(flags.output);
    console.log(`PASS self-check ${report.checks.length} checks`);
    return;
  }
  await runAcceptance(flags);
}

async function runAcceptance(flags) {
  const output = flags.output;
  mkdirSync(output, { recursive: true });
  if (!insideDir(root, output) && resolve(output) !== DEFAULT_OUTPUT) {
    /* allow DSH_TEST_OUTPUT; still refuse production Home later */
  }
  const proved = [];
  const uncovered = [];
  const phaseResults = {};
  const report = {
    status: 'running',
    proved,
    uncovered,
    phases: phaseResults,
    realDsh: true,
    packed: true,
    modelCalls: false,
    injectSeam: 'source-test-seam for rollback only',
    heartbeatLimitMs: HEARTBEAT_TIMEOUT_MS,
    jobMs: flags.jobMs,
    notADistributionProof: true,
  };
  const pass = text => {
    proved.push(text);
    console.log(`PASS ${text}`);
    persist(output, 'run.log', `PASS ${text}`);
  };
  const save = () => {
    writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  };
  report.output = output;
  report.startedAt = new Date().toISOString();
  report.httpOnly = flags.httpOnly;
  save();

  assert.ok(existsSync(PACKED_SUPERVISOR), 'packages/supervisor/lib/index.js missing; rebuild before the real run');
  assert.ok(existsSync(PACKED_WORKER), 'packages/supervisor/lib/snapshot-worker.mjs missing; rebuild before the real run');

  const prior = resolvePrior(flags.home && insideDir(NETWORK_SOURCE, flags.home) ? flags.home : '');
  report.prior = { results: prior.priorPath, runtimeHome: prior.runtimeHome, status: prior.prior.status };
  const tooling = prepareTooling(output, NETWORK_SOURCE);
  const packHome = mkdtempSync(join(output, 'pack-home-'));
  refuseRealHome(packHome);
  const packEnv = stripSecrets(isolatedEnv(packHome, node, tooling));
  const packDir = join(output, 'packed');
  mkdirSync(packDir, { recursive: true });
  const plugin = packArtifact('plugin', packDir, packEnv);
  const bridge = packArtifact('view-bridge', packDir, packEnv);
  const packedVersion = JSON.parse(readFileSync(join(root, 'packages/plugin/package.json'), 'utf8')).version;
  const artifacts = {
    plugin: { path: plugin, sha256: sha256File(plugin) },
    bridge: { path: bridge, sha256: sha256File(bridge) },
  };
  report.artifacts = artifacts;
  report.packedVersion = packedVersion;
  const oldArtifacts = {
    plugin: { path: prior.prior.artifacts.plugin.path, sha256: prior.prior.artifacts.plugin.sha256 || sha256File(prior.prior.artifacts.plugin.path) },
    bridge: { path: prior.prior.artifacts.bridge.path, sha256: prior.prior.artifacts.bridge.sha256 || sha256File(prior.prior.artifacts.bridge.path) },
  };
  report.oldArtifacts = oldArtifacts;
  if (artifacts.plugin.sha256 === oldArtifacts.plugin.sha256 && artifacts.bridge.sha256 === oldArtifacts.bridge.sha256) {
    uncovered.push('packed plugin/view-bridge identical to previously installed artifacts; no same-version content candidate; refusing to simulate');
    report.status = 'fail';
    report.error = 'no same-version content candidate; refusing to simulate';
    report.finishedAt = new Date().toISOString();
    save();
    process.exitCode = 1;
    return;
  }
  pass('plugin and view-bridge packed into the new output; content differs from the Home already-installed archives');
  save();

  const selected = flags.phase === 'all' ? PHASES : [flags.phase];
  const failures = [];
  let successUsedRuntimeHome = false;
  for (const phase of selected) {
    const phaseDir = join(output, phase);
    mkdirSync(phaseDir, { recursive: true });
    const row = { status: 'running', startedAt: new Date().toISOString() };
    phaseResults[phase] = row;
    save();
    try {
      if (phase === 'success') {
        const home = flags.home && allowedHome(flags.home) && existsSync(flags.home)
          ? flags.home
          : prior.runtimeHome;
        if (!existsSync(home)) throw new Error(`isolated home missing: ${home}`);
        refuseRealHome(home);
        if (insideDir(NETWORK_SOURCE, home) && realpathSync(home) !== realpathSync(prior.runtimeHome)) {
          throw new Error('success Home must be the verified phases.runtime.home');
        }
        const toolchain = readToolchain(home);
        row.home = home;
        row.toolchain = {
          bin: toolchain.bin,
          nodeExe: toolchain.nodeExe,
          toolchainRoot: toolchain.toolchainRoot,
          runtimeRoot: toolchain.runtimeRoot,
          snapshotRoot: toolchain.snapshotRoot,
          dshVersion: toolchain.dshVersion,
        };
        const env = stripSecrets(isolatedEnv(home, toolchain.nodeExe, tooling));
        await runSuccess({
          home, artifacts, oldArtifacts, env, phaseDir, toolchain, httpOnly: flags.httpOnly, packedVersion, jobMs: flags.jobMs,
        }, row, pass, uncovered, flags.jobMs, flags.httpOnly);
        successUsedRuntimeHome = resolve(home) === resolve(prior.runtimeHome);
        if (row.partial) report.partial = true;
      } else if (phase === 'rollback') {
        let home;
        let toolchain;
        const reuse = !successUsedRuntimeHome && existsSync(prior.runtimeHome);
        if (reuse) {
          home = flags.home && insideDir(DEFAULT_OUTPUT, flags.home) && existsSync(flags.home)
            ? flags.home
            : prior.runtimeHome;
          refuseRealHome(home);
          toolchain = readToolchain(home);
        } else {
          const fresh = await createFreshHome(DEFAULT_OUTPUT, phaseDir, tooling, oldArtifacts);
          home = fresh.home;
          toolchain = fresh.toolchain;
        }
        row.home = home;
        row.toolchain = {
          bin: toolchain.bin,
          nodeExe: toolchain.nodeExe,
          toolchainRoot: toolchain.toolchainRoot,
          runtimeRoot: toolchain.runtimeRoot,
          snapshotRoot: toolchain.snapshotRoot,
          dshVersion: toolchain.dshVersion,
        };
        const env = stripSecrets(isolatedEnv(home, toolchain.nodeExe, tooling));
        await runRollback({
          home, artifacts, oldArtifacts, env, phaseDir, toolchain, httpOnly: flags.httpOnly, packedVersion, jobMs: flags.jobMs,
        }, row, pass, uncovered, flags.jobMs, flags.httpOnly);
        if (row.partial) report.partial = true;
      }
      row.status = row.partial ? 'partial' : 'pass';
      row.finishedAt = new Date().toISOString();
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : error);
      row.status = error?.uncovered ? 'uncovered' : 'fail';
      row.error = redact(error instanceof Error ? error.stack : error);
      row.finishedAt = new Date().toISOString();
      if (error?.uncovered) uncovered.push(message);
      failures.push({ phase, error: message, uncovered: Boolean(error?.uncovered) });
      console.error(`${row.status === 'uncovered' ? 'UNCOVERED' : 'FAIL'} ${phase}: ${message}`);
      persist(output, 'run.log', `FAIL ${phase}: ${redact(error instanceof Error ? error.stack : error)}`);
    }
    save();
  }
  if (failures.length) {
    report.status = failures.every(item => item.uncovered) && proved.length === 0 ? 'fail' : 'fail';
    report.error = failures.map(item => `${item.phase}: ${item.error}`).join('\n');
    report.finishedAt = new Date().toISOString();
    save();
    process.exitCode = 1;
    return;
  }
  const anyPartial = Object.values(phaseResults).some(row => row.status === 'partial') || report.partial;
  report.status = anyPartial ? 'partial' : 'pass';
  report.finishedAt = new Date().toISOString();
  save();
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(error => {
    console.error(`FAIL ${redact(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}
