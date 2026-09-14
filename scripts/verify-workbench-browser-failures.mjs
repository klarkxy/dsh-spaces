#!/usr/bin/env node
/**
 * Browser exception-switch and session/scroll persistence acceptance.
 * Reuses the latest passing isolated theme Home. Packed supervisor from
 * packages/supervisor/lib. No model calls. Does not import verify-workbench-product.mjs
 * or verify-workbench-interactions.mjs (both execute at load).
 *
 *   node scripts/verify-workbench-browser-failures.mjs [--self-check]
 *     [--phase session|cookie|crash|timeout|all] [--output DIR] [--home DIR]
 *
 * Env: DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE, DSH_TEST_OUTPUT,
 * DSH_TEST_HOME, DSH_TEST_PNPM_CJS.
 *
 * This leaf writes the script and fixtures only. Root runs the real DSH/Chromium
 * pass serially after other live services stop.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  isolatedEnv,
  refuseRealHome,
  resolveNpmCli,
  resolvePnpmCjs,
  run,
  runDsh,
  stopOwned,
  writePnpmShim,
  rpc,
  assertRpcOk,
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const COMPATIBLE = '0.1.5-rc.1';
const THEMES_SOURCE = join(root, '.sandbox', 'workbench-product-themes');
const DEFAULT_OUTPUT = join(root, '.sandbox', 'workbench-browser-failures');
const PACKED_SUPERVISOR = join(root, 'packages', 'supervisor', 'lib', 'index.js');
const PACKED_WORKER = join(root, 'packages', 'supervisor', 'lib', 'snapshot-worker.mjs');
const HANG_PLUGIN_DIR = join(root, 'tests', 'fixtures', 'workbench-failures', 'hang-plugin');
const HANG_CLI = join(root, 'tests', 'fixtures', 'workbench-failures', 'hang-cli.mjs');
const PRODUCT_SCRIPT = join(root, 'scripts', 'verify-workbench-product.mjs');
const INTERACTIONS_SCRIPT = join(root, 'scripts', 'verify-workbench-interactions.mjs');
const STORE_TS = join(root, 'packages', 'plugin', 'src', 'workbench', 'store.ts');
const PROCESS_TS = join(root, 'src', 'main', 'process-manager.ts');
const DEFAULT_PLAYWRIGHT =
  'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const UI_START_TIMEOUT_MS = 90_000;
const UI_HANDSHAKE_TIMEOUT_MS = 45_000;
const PROCESS_READY_TIMEOUT_MS = 60_000;
const SUPERVISOR_MS = 240_000;
const JOB_MS = 240_000;
const PHASES = ['session', 'cookie', 'crash', 'timeout'];
const HANG_SPACE = 'hang-timeout';
const HANG_NAME = '启动超时夹具';
const CRASH_SPACE = 'crash-probe';
const CRASH_NAME = '崩溃夹具';
const SESSION_LABEL = 'overflow-keep';
const SESSION_DRAFT = 'unsent overflow draft keep-scroll';
const SESSION_COUNT = 24;
const HARDCODED_HOME_HINT = 'home-C4wR8E';

const CHROME_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

function redact(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/\/bootstrap\/[^\s"'<>]+/g, '/bootstrap/[redacted]')
    .replace(/(dsh-auth-[^=\s;]+)=([^;\s"']+)/g, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer [redacted]')
    .replace(/"nonce"\s*:\s*"[^"]+"/g, '"nonce":"[redacted]"');
}

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function parseFlags(argv) {
  let phase = 'all';
  let selfCheck = false;
  let out = process.env.DSH_TEST_OUTPUT || DEFAULT_OUTPUT;
  let home = process.env.DSH_TEST_HOME || '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--self-check') {
      selfCheck = true;
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
    else throw new Error(`unknown flag: ${token}`);
  }
  if (!['all', 'self-check', ...PHASES].includes(phase)) {
    throw new Error(`unknown --phase ${phase}; expected ${PHASES.join('|')}|all`);
  }
  return {
    phase,
    selfCheck: selfCheck || phase === 'self-check',
    output: resolve(out),
    home: home.trim() ? resolve(home.trim()) : '',
  };
}

function insideDir(parent, child) {
  const a = resolve(parent);
  const b = resolve(child);
  const prefix = a.endsWith(sep) ? a : a + sep;
  if (process.platform === 'win32') {
    return b.toLowerCase() === a.toLowerCase() || b.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return b === a || b.startsWith(prefix);
}

function isProductionHome(home) {
  const resolved = resolve(home);
  const real = resolve(join(homedir(), '.dsh'));
  const prefix = real.endsWith(sep) ? real : real + sep;
  const lower = process.platform === 'win32';
  const a = lower ? resolved.toLowerCase() : resolved;
  const b = lower ? real.toLowerCase() : real;
  const p = lower ? prefix.toLowerCase() : prefix;
  return a === b || a.startsWith(p);
}

function wantedPhases(phase) {
  return phase === 'all' ? [...PHASES] : [phase];
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

function controlDir(home) {
  return join(home, '.dsh-spaces-control');
}

function instancePath(home, spaceId) {
  return join(controlDir(home), 'instances', `${spaceId}.json`);
}

function readInstanceRecord(home, spaceId) {
  const path = instancePath(home, spaceId);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record?.version !== 1 || record.spaceId !== spaceId) return null;
    if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
    if (typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) return null;
    return record;
  } catch {
    return null;
  }
}

function inspectWindowsPid(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'invalid process id');
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { [PSCustomObject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CreationDate = $_.CreationDate.ToUniversalTime().ToString('o'); Name = $_.Name } } | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.status !== 0) {
    throw new Error(`pid inspect failed: ${redact(result.stderr || result.stdout || `exit ${result.status}`)}`);
  }
  const text = String(result.stdout || '').trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  return {
    pid: Number(parsed.ProcessId),
    parentPid: Number(parsed.ParentProcessId),
    name: String(parsed.Name || ''),
    creationDate: String(parsed.CreationDate || ''),
  };
}

function sameProcessIdentity(expected, live) {
  return !!live && expected.pid === live.pid && expected.parentPid === live.parentPid
    && expected.creationDate === live.creationDate && expected.name === live.name
    && Number.isFinite(Date.parse(expected.creationDate));
}

function verifyOwnedChild(record, supervisorPid, supervisorStartedAt) {
  if (!record?.pid) throw new Error('instance record has no pid');
  if (record.pid === process.pid) throw new Error('refusing to operate on this script pid');
  if (record.pid === supervisorPid) throw new Error('refusing to operate on the supervisor pid');
  if (process.platform !== 'win32') {
    throw new Error(`pid parent/creation verification is implemented for Windows; got ${process.platform}`);
  }
  const live = inspectWindowsPid(record.pid);
  if (!live || live.pid !== record.pid) throw new Error(`instance pid ${record.pid} is not a live Win32 process`);
  if (live.parentPid !== supervisorPid) {
    throw new Error(`instance pid parent ${live.parentPid} is not this supervisor ${supervisorPid}`);
  }
  const created = Date.parse(live.creationDate);
  const recorded = Date.parse(record.startedAt);
  const supervisorStart = Date.parse(supervisorStartedAt);
  if (!Number.isFinite(created) || !Number.isFinite(recorded)) {
    throw new Error('instance creation time could not be compared');
  }
  if (Math.abs(created - recorded) > 30_000) {
    throw new Error('instance creation time does not match the supervisor record');
  }
  if (Number.isFinite(supervisorStart) && created + 2000 < supervisorStart) {
    throw new Error('instance predates this supervisor; refusing to adopt an old process');
  }
  return live;
}

function killOwnedPid(identity) {
  // Revalidate immediately before signalling; a saved PID alone is not ownership.
  const live = inspectWindowsPid(identity.pid);
  if (!live) return Promise.resolve();
  if (!sameProcessIdentity(identity, live)) {
    return Promise.reject(new Error(`process identity changed for pid ${identity.pid}; refusing termination`));
  }
  return new Promise((resolveKill, rejectKill) => {
    const killer = spawn('taskkill', ['/PID', String(identity.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => rejectKill(new Error('owned child termination timed out')), 8000);
    const done = (code) => {
      clearTimeout(timer);
      if (code === 0) resolveKill();
      else rejectKill(new Error(`owned child termination failed: exit ${code}`));
    };
    killer.once('exit', done);
    killer.once('error', error => { clearTimeout(timer); rejectKill(error); });
  });
}

function resolvePriorHome(requested) {
  // Home comes from theme results.json or --home. must not hardcode a disposable folder name.
  const source = THEMES_SOURCE;
  const priorPath = join(source, 'results.json');
  if (!existsSync(priorPath)) {
    throw new Error(`missing ${priorPath}; reuse the latest passing theme Home`);
  }
  const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
  if (prior.status !== 'pass') {
    throw new Error(`theme results status is ${prior.status}, not pass`);
  }
  const home = resolve(requested || prior.home);
  if (!insideDir(source, home)) {
    throw new Error(`home must stay under ${source}`);
  }
  if (isProductionHome(home)) throw new Error('refusing production ~/.dsh');
  refuseRealHome(home);
  if (!existsSync(home)) throw new Error(`isolated home missing: ${home}`);
  const physicalHome = realpathSync(home);
  if (!insideDir(realpathSync(source), physicalHome) || physicalHome !== realpathSync(prior.home)) {
    throw new Error('Home must be the verified theme Home, including its resolved filesystem target');
  }
  const bindingPath = join(controlDir(home), 'toolchain.json');
  if (!existsSync(bindingPath)) throw new Error('Home private toolchain.json is missing');
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  if (!binding.bin || !existsSync(binding.bin)) throw new Error('toolchain.bin missing');
  if (!binding.toolchainRoot || !binding.snapshotRoot) {
    throw new Error('toolchain.json missing toolchainRoot/snapshotRoot');
  }
  if (!prior.artifacts?.plugin?.path || !existsSync(prior.artifacts.plugin.path)) {
    throw new Error('packed plugin artifact from theme results is missing');
  }
  if (!prior.artifacts?.bridge?.path || !existsSync(prior.artifacts.bridge.path)) {
    throw new Error('packed view-bridge artifact from theme results is missing');
  }
  return { home, prior, binding };
}

function productTimeoutsFromSource() {
  const store = readFileSync(STORE_TS, 'utf8');
  const processSource = readFileSync(PROCESS_TS, 'utf8');
  const start = Number(/startTimeoutMs:\s*(\d[\d_]*)/.exec(store)?.[1]?.replaceAll('_', ''));
  const handshake = Number(/handshakeTimeoutMs:\s*(\d[\d_]*)/.exec(store)?.[1]?.replaceAll('_', ''));
  const ready = Number(/readyTimeoutMs:\s*(\d[\d_]*)/.exec(processSource)?.[1]?.replaceAll('_', ''));
  return { start, handshake, ready };
}

function scriptImportsUnsafe(source) {
  return {
    product: /from\s+['"]\.\/verify-workbench-product\.mjs['"]/.test(source),
    interactions: /from\s+['"]\.\/verify-workbench-interactions\.mjs['"]/.test(source),
    desktop: /from\s+['"]\.\/verify-spaces-desktop\.mjs['"]/.test(source),
    maintenance: /from\s+['"]\.\/verify-workbench-maintenance-product\.mjs['"]/.test(source),
    fulfill: /route\.fulfill\s*\(/.test(source),
  };
}

export async function runSelfCheck(outputDir = DEFAULT_OUTPUT) {
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  const report = {
    status: 'running',
    mode: 'self-check',
    realDsh: false,
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

  try {
    const identity = { pid: 123, parentPid: 100, name: 'node.exe', creationDate: '2026-09-13T01:02:03.1234567Z' };
    assert.equal(sameProcessIdentity(identity, { ...identity }), true);
    assert.equal(sameProcessIdentity(identity, null), false);
    assert.equal(sameProcessIdentity(identity, { ...identity, creationDate: '2026-09-13T01:02:04.1234567Z' }), false);
    assert.equal(sameProcessIdentity(identity, { ...identity, parentPid: 101 }), false);
    assert.equal(sameProcessIdentity({ ...identity, creationDate: '' }, { ...identity, creationDate: '' }), false);
    pass('pid-reuse-identity-rejected');
  } catch (error) {
    fail('pid-reuse-identity-rejected', error);
  }

  const script = join(root, 'scripts', 'verify-workbench-browser-failures.mjs');
  const syntax = spawnSync(node, ['--check', script], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (syntax.status !== 0) fail('syntax', syntax.stderr || syntax.stdout);
  else pass('syntax');

  try {
    const source = readFileSync(script, 'utf8');
    const unsafe = scriptImportsUnsafe(source);
    if (unsafe.product || unsafe.interactions || unsafe.desktop || unsafe.maintenance) {
      fail('no-unsafe-imports', unsafe);
    } else pass('no-unsafe-imports');
    if (unsafe.fulfill) fail('no-route-fulfill', 'script contains route.fulfill');
    else pass('no-route-fulfill');
    if (!source.includes('import.meta.url === pathToFileURL(process.argv[1]).href')) {
      fail('import-guard', 'missing invoked guard');
    } else pass('import-guard');
    if (source.includes(HARDCODED_HOME_HINT) && !source.includes('must not hardcode')) {
      fail('no-hardcoded-home', `script mentions ${HARDCODED_HOME_HINT}`);
    } else pass('no-hardcoded-home');
    if (!source.includes('.sandbox/workbench-browser-failures') && !source.includes('workbench-browser-failures')) {
      fail('independent-output', 'default output is not workbench-browser-failures');
    } else pass('independent-output');
  } catch (error) {
    fail('source-policy', error);
  }

  try {
    const imported = await import(pathToFileURL(script).href);
    assert.equal(typeof imported.runSelfCheck, 'function');
    const probe = spawnSync(node, ['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(script).href)}; console.log('import-ok')`], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, DSH_TEST_HOME: '' },
    });
    const probeOut = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    if (probe.status !== 0 || !probeOut.includes('import-ok')) fail('import-does-not-launch', probeOut.slice(0, 400));
    else if (/bootstrap=|PASS |supervisor launched/i.test(probeOut)) fail('import-does-not-launch', 'import started a live run');
    else pass('import-does-not-launch');
  } catch (error) {
    fail('import-does-not-launch', error);
  }

  try {
    const dist = await import(pathToFileURL(join(root, 'scripts', 'verify-spaces-distribution.mjs')).href);
    assert.equal(typeof dist.refuseRealHome, 'function');
    assert.equal(typeof dist.stopOwned, 'function');
    pass('distribution-helpers-safe-import');
  } catch (error) {
    fail('distribution-helpers-safe-import', error);
  }

  try {
    const product = readFileSync(PRODUCT_SCRIPT, 'utf8');
    const interactions = readFileSync(INTERACTIONS_SCRIPT, 'utf8');
    const productGuarded = /const invoked = process\.argv\[1\]/.test(product);
    const interactionsGuarded = /const invoked = process\.argv\[1\]/.test(interactions);
    if (productGuarded && interactionsGuarded) {
      fail('unsafe-siblings-still-unguarded', 'product/interactions now look import-safe; re-evaluate sharing helpers');
    } else pass('unsafe-siblings-not-imported', { productGuarded, interactionsGuarded });
  } catch (error) {
    fail('unsafe-siblings-not-imported', error);
  }

  try {
    const timeouts = productTimeoutsFromSource();
    if (timeouts.start !== UI_START_TIMEOUT_MS || timeouts.handshake !== UI_HANDSHAKE_TIMEOUT_MS || timeouts.ready !== PROCESS_READY_TIMEOUT_MS) {
      fail('product-timeouts', timeouts);
    } else pass('product-timeouts', timeouts);
  } catch (error) {
    fail('product-timeouts', error);
  }

  try {
    if (!existsSync(PACKED_SUPERVISOR) || !existsSync(PACKED_WORKER)) {
      fail('packed-supervisor', 'packages/supervisor/lib is missing');
    } else pass('packed-supervisor', { supervisor: PACKED_SUPERVISOR, worker: PACKED_WORKER });
  } catch (error) {
    fail('packed-supervisor', error);
  }

  try {
    const pkg = JSON.parse(readFileSync(join(HANG_PLUGIN_DIR, 'package.json'), 'utf8'));
    const host = readFileSync(join(HANG_PLUGIN_DIR, 'index.js'), 'utf8');
    const client = readFileSync(join(HANG_PLUGIN_DIR, 'client.js'), 'utf8');
    const patch = readFileSync(join(HANG_PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
    if (pkg.name !== '@dsh-spaces/hang-fixture') fail('hang-plugin-manifest', pkg.name);
    else if (!host.includes('dsh-spaces:stop') || !host.includes('SIGTERM') || !host.includes('new Promise(() => {})')) {
      fail('hang-plugin-host', 'host apply must hang and register cooperative stop');
    } else if (!client.includes('data-dsh-boot') || !patch.includes('dsh-spaces-hang-fixture')) {
      fail('hang-plugin-client', 'client must keep data-dsh-boot');
    } else pass('hang-plugin-fixture');
  } catch (error) {
    fail('hang-plugin-fixture', error);
  }

  try {
    const hangCheck = spawnSync(node, ['--check', HANG_CLI], { cwd: root, windowsHide: true, encoding: 'utf8' });
    const hangRun = spawnSync(node, [HANG_CLI, '--self-check'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000,
    });
    if (hangCheck.status !== 0) fail('hang-cli-syntax', hangCheck.stderr || hangCheck.stdout);
    else if (hangRun.status !== 0 || !String(hangRun.stdout).includes('hang-cli-self-check=ok')) {
      fail('hang-cli-self-check', hangRun.stderr || hangRun.stdout);
    } else pass('hang-cli-self-check');
  } catch (error) {
    fail('hang-cli-self-check', error);
  }

  try {
    refuseRealHome(join(homedir(), '.dsh-not-used-probe'));
    let refused = false;
    try {
      refuseRealHome(join(homedir(), '.dsh'));
    } catch {
      refused = true;
    }
    if (!refused) fail('refuse-real-home', 'refuseRealHome accepted ~/.dsh');
    else pass('refuse-real-home');
  } catch (error) {
    fail('refuse-real-home', error);
  }

  try {
    const priorPath = join(THEMES_SOURCE, 'results.json');
    if (!existsSync(priorPath)) {
      pass('prior-home-resolver', { present: false, note: 'theme results missing; real run will fail until they exist' });
    } else {
      const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
      const home = resolve(prior.home);
      if (prior.status === 'pass' && insideDir(THEMES_SOURCE, home) && !isProductionHome(home)) {
        pass('prior-home-resolver', { present: true, homeDir: basename(home), resolvedFromResults: true });
      } else fail('prior-home-resolver', { status: prior.status, inside: insideDir(THEMES_SOURCE, home) });
    }
  } catch (error) {
    fail('prior-home-resolver', error);
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

async function dismissOfficialOverlays(frame) {
  for (const name of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
    const button = frame.getByRole('button', { name }).first();
    await button.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    if (await button.isVisible().catch(() => false)) await button.click();
  }
}

async function childFrame(page, origin) {
  await until(() => page.frames().some(frame => frame.url().startsWith(`${origin}/`)), `iframe ${origin}`, 60000);
  return page.frames().find(frame => frame.url().startsWith(`${origin}/`));
}

async function currentRail(hub) {
  const handle = hub.locator('.dsh-wb-rail button[aria-current="true"]').first();
  if (!(await handle.count())) return null;
  return handle.innerText();
}

async function fetchAuthEvidence(origin, cookieHeader) {
  const headers = { origin, connection: 'close' };
  if (cookieHeader) headers.cookie = cookieHeader;
  const document = await fetch(`${origin}/`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  await document.body?.cancel();
  const list = await fetch(`${origin}/api/session/list`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'session/list',
      payload: { args: { _request: {} } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await list.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  const text = redact(raw.slice(0, 240));
  return {
    documentStatus: document.status,
    documentLocation: document.headers.get('location') || null,
    sessionListStatus: list.status,
    sessionListOk: body?.result?.ok === true,
    sessionListExcerpt: text,
  };
}

function cookieHeader(cookies) {
  return cookies.map(row => `${row.name}=${row.value}`).join('; ');
}

function cookieNames(cookies) {
  return cookies.map(row => row.name);
}

async function runAcceptance(flags) {
  const output = flags.output;
  mkdirSync(join(output, 'screenshots'), { recursive: true });
  const { home, prior, binding } = resolvePriorHome(flags.home);
  const phases = wantedPhases(flags.phase);
  const proved = [];
  const uncovered = [];
  const skipped = [];
  const ownedProcesses = new Map();
  const report = {
    status: 'running',
    proved,
    uncovered,
    skipped,
    phases: {},
    realDsh: true,
    packed: true,
    modelCalls: false,
    compatibleCli: COMPATIBLE,
    home,
    coverageComplete: false,
    reusedThemeHome: true,
    lastClickWins: 'reused from verify-workbench-interactions; not repeated here',
  };
  const pass = text => {
    proved.push(text);
    console.log(`PASS ${redact(text)}`);
  };
  const markUncovered = (id, reason) => {
    uncovered.push({ id, reason: redact(reason) });
    console.log(`UNCOVERED ${id}: ${redact(reason)}`);
  };
  const save = () => {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  };

  skipped.push({
    id: 'last-click-wins',
    reason: 'already exercised by scripts/verify-workbench-interactions.mjs; this script does not repeat the full lifecycle',
  });

  let supervisor;
  let launch = '';
  let errors = '';
  let browser;
  let page;
  let context;
  let api;
  let hub;
  const writeLogs = () => {
    writeFileSync(join(output, 'supervisor.log'), redact(`${launch}\n${errors}`));
  };

  try {
    const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(THEMES_SOURCE, key)]));
    Object.values(tooling).forEach(path => mkdirSync(path, { recursive: true }));
    writePnpmShim(tooling.shim, node, resolvePnpmCjs());
    const env = isolatedEnv(home, binding.nodeExe || node, tooling);
    for (const key of Object.keys(env)) {
      if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) {
        delete env[key];
      }
    }
    env.DSH_TEST_REAL_BIN = binding.bin;

    if (!existsSync(PACKED_SUPERVISOR) || !existsSync(PACKED_WORKER)) {
      throw new Error('packages/supervisor/lib official artifacts are missing');
    }

    const supervisorStartedAt = new Date().toISOString();
    supervisor = spawn(node, [
      PACKED_SUPERVISOR,
      '--home', home, '--bin', binding.bin, '--node', binding.nodeExe || node, '--port', '0',
      '--plugin-artifact', prior.artifacts.plugin.path,
      '--view-bridge-artifact', prior.artifacts.bridge.path,
      '--control-tool-root', binding.toolchainRoot,
      '--snapshot-root', binding.snapshotRoot,
      '--snapshot-worker', PACKED_WORKER,
    ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    supervisor.stdout.on('data', chunk => { launch = (launch + chunk.toString()).slice(-32768); });
    supervisor.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-32768); });

    await until(() => {
      if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${redact(errors)}`);
      return /bootstrap=(\S+)/.test(launch);
    }, 'supervisor', SUPERVISOR_MS);
    const bootstrap = launch.match(/bootstrap=(\S+)/)[1];
    const origin = new URL(bootstrap).origin;
    report.origin = origin;
    const { chromium } = await import(pathToFileURL(playwrightIndex()).href);
    browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', error => console.log(`BROWSER ${redact(error.message)}`));
    await page.goto(bootstrap, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await until(() => page.url() === `${origin}/`, 'clean stable entry URL');

    api = async (method, data = {}, timeout = 30000) => {
      const response = await context.request.post(`${origin}/api/workbench/${method}`, {
        headers: { origin }, data, timeout,
      });
      const body = await response.json();
      if (!body?.ok) throw new Error(`${method}: ${body?.error?.code} ${body?.error?.message}`);
      return body.value;
    };
    const job = async command => {
      let latest = await api('submit', { command, requestId: randomUUID() });
      await until(async () => {
        latest = await api('job', { id: latest.id });
        return !['queued', 'running'].includes(latest.status);
      }, command.kind, JOB_MS);
      assert.equal(latest.status, 'succeeded', redact(JSON.stringify(latest.error)));
      return latest;
    };

    let state = await api('state');
    if (state.recoveryRequired) {
      throw new Error(`recovery-required on reused home: ${redact(JSON.stringify(state.reasons))}`);
    }
    assert.equal(state.writable, true);
    const managerView = await api('view', { spaceId: state.managerId });
    const manager = async () => {
      await until(() => page.frames().some(frame => frame.url().startsWith(`${managerView.origin}/`)), 'manager frame');
      const frame = page.frames().find(frame => frame.url().startsWith(`${managerView.origin}/`));
      await frame.locator('.dsh-wb-rail').waitFor({ timeout: 60000 });
      return frame;
    };
    hub = await manager();
    const select = async label => {
      hub = await manager();
      await hub.getByRole('button', { name: label, exact: true }).first().click();
      await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: label }).waitFor({ timeout: 65000 });
    };

    const ensureSpace = async (id, displayName) => {
      state = await api('state');
      if (state.spaces.some(row => row.id === id)) return;
      await job({ kind: 'space.create', input: { name: id, displayName } });
    };

    const childCookies = async viewOrigin => (await context.cookies(viewOrigin)).filter(row => /^dsh-auth-/.test(row.name));

    if (phases.includes('session')) {
      try {
        await select('竹青');
        const zhuqingView = await api('view', { spaceId: 'zhuqing' });
        const zhuqing = await childFrame(page, zhuqingView.origin);
        await dismissOfficialOverlays(zhuqing);
        const cookies = await childCookies(zhuqingView.origin);
        assert.ok(cookies.length, 'zhuqing has no DSH session cookie');
        const header = cookieHeader(cookies);
        const port = Number(new URL(zhuqingView.origin).port);
        const workspacePath = join(output, 'overflow-workspace-zhuqing');
        mkdirSync(workspacePath, { recursive: true });
        const createdWs = assertRpcOk(
          await rpc(port, header, 'workspace/create', { request: { path: workspacePath } }),
          'workspace/create overflow',
        );
        const workspaceId = createdWs?.workspace?.workspaceId ?? createdWs?.workspaceId;
        assert.ok(workspaceId, 'workspace/create returned no workspaceId');
        const titles = [];
        for (let i = 0; i < SESSION_COUNT; i += 1) {
          const title = `${SESSION_LABEL}-${String(i).padStart(2, '0')}`;
          const created = assertRpcOk(
            await rpc(port, header, 'session/create', { request: { workspaceId } }),
            `session/create ${title}`,
          );
          const sessionId = created?.sessionId;
          assert.ok(sessionId, 'session/create returned no sessionId');
          assertRpcOk(
            await rpc(port, header, 'session/rename', { request: { sessionId, title } }),
            `session/rename ${title}`,
          );
          titles.push(title);
        }
        const keepTitle = titles[titles.length - 3];
        const workspaceLabel = basename(workspacePath);
        const workspaceRow = zhuqing.getByText(workspaceLabel, { exact: true }).first();
        if (await workspaceRow.isVisible().catch(() => false)) await workspaceRow.click();
        await until(async () => (await zhuqing.getByText(keepTitle, { exact: true }).count()) > 0, 'overflow session row', 30000);
        const keepRow = zhuqing.getByText(keepTitle, { exact: true }).first();
        await keepRow.scrollIntoViewIfNeeded();
        await keepRow.click();
        const overflow = await zhuqing.evaluate(label => {
          const row = [...document.querySelectorAll('button, [role="button"], a, li, div')].find(el => (el.textContent || '').includes(label));
          if (!row) return null;
          let node = row;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 8) {
              return {
                scrollTop: node.scrollTop,
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
              };
            }
            node = node.parentElement;
          }
          return null;
        }, keepTitle);
        if (!overflow || overflow.scrollHeight <= overflow.clientHeight + 8) {
          throw new Error('official sidebar did not overflow after creating empty sessions; refusing to fake scrollTop');
        }
        const editor = zhuqing.locator('[contenteditable="true"]').first();
        await editor.waitFor({ timeout: 30000 });
        await editor.fill(SESSION_DRAFT);
        assert.ok((await editor.innerText()).includes(SESSION_DRAFT));
        const before = {
          title: keepTitle,
          scrollTop: overflow.scrollTop,
          draft: SESSION_DRAFT,
        };
        await select('EternalNight');
        await select('竹青');
        const zhuqingAgain = await childFrame(page, zhuqingView.origin);
        const afterDraft = await zhuqingAgain.locator('[contenteditable="true"]').first().innerText();
        const afterOverflow = await zhuqingAgain.evaluate(label => {
          const row = [...document.querySelectorAll('button, [role="button"], a, li, div')].find(el => (el.textContent || '').includes(label));
          if (!row) return { found: false };
          let node = row;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 8) {
              return { found: true, scrollTop: node.scrollTop, selected: true };
            }
            node = node.parentElement;
          }
          return { found: true, scrollTop: null };
        }, keepTitle);
        assert.equal(afterOverflow.found, true, 'selected overflow session row missing after switch');
        assert.ok((afterDraft || '').includes(SESSION_DRAFT), 'contenteditable draft lost after switch');
        if (typeof afterOverflow.scrollTop === 'number') {
          assert.ok(Math.abs(afterOverflow.scrollTop - before.scrollTop) <= 16, `scrollTop ${afterOverflow.scrollTop} != ${before.scrollTop}`);
        } else {
          throw new Error('overflow container missing after switch');
        }
        await page.screenshot({ path: join(output, 'screenshots', 'session-persist.png') });
        report.phases.session = { status: 'pass', keepTitle, scrollTop: before.scrollTop };
        pass('selected session, overflow scrollTop, and unsent draft survived 竹青/EternalNight round-trip');
      } catch (error) {
        report.phases.session = { status: 'fail', error: redact(errorText(error)) };
        throw error;
      }
    }

    if (phases.includes('cookie')) {
      try {
        await select('竹青');
        const zhuqingView = await api('view', { spaceId: 'zhuqing' });
        const cookies = await childCookies(zhuqingView.origin);
        const names = cookieNames(cookies);
        assert.ok(names.length, 'no child DSH cookie to invalidate');
        const valid = await fetchAuthEvidence(zhuqingView.origin, cookieHeader(cookies));
        const missing = await fetchAuthEvidence(zhuqingView.origin, '');
        const garbage = await fetchAuthEvidence(zhuqingView.origin, names.map(name => `${name}=invalid-session`).join('; '));
        assert.equal(valid.sessionListStatus, 200, 'valid cookie request must succeed before testing invalidation');
        assert.equal(valid.sessionListOk, true, 'valid cookie RPC must succeed before testing invalidation');
        const rejected = (probe) => [401, 403].includes(probe.sessionListStatus);
        const evidence = {
          cookieNames: names,
          validDocumentStatus: valid.documentStatus,
          missing: { documentStatus: missing.documentStatus, sessionListStatus: missing.sessionListStatus, sessionListOk: missing.sessionListOk },
          garbage: { documentStatus: garbage.documentStatus, sessionListStatus: garbage.sessionListStatus, sessionListOk: garbage.sessionListOk },
        };
        report.phases.cookie = { status: 'running', evidence };
        if (!rejected(missing) && !rejected(garbage)) {
          markUncovered('cookie-invalid', 'real DSH did not reject missing/garbage session cookies; no route.fulfill fallback');
          report.phases.cookie = { status: 'uncovered', evidence };
        } else {
          const selectedBefore = await currentRail(hub);
          for (const name of names) await context.clearCookies({ name });
          const zhuqing = await childFrame(page, zhuqingView.origin);
          const iframeProbe = await zhuqing.evaluate(async () => {
            try {
              const response = await fetch('/api/session/list', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  type: 'client-request',
                  rpcId: crypto.randomUUID(),
                  method: 'session/list',
                  payload: { args: { _request: {} } },
                }),
              });
              return { status: response.status, ok: (await response.json())?.result?.ok === true };
            } catch (error) {
              return { status: 0, ok: false, error: String(error).slice(0, 160) };
            }
          });
          const iframeRejected = [401, 403].includes(iframeProbe.status);
          const selectedAfter = await currentRail(hub);
          await hub.locator('.dsh-wb-rail').waitFor();
          await hub.getByRole('button', { name: 'EternalNight', exact: true }).first().click();
          await delay(500);
          const outerStillWorks = (await hub.getByRole('button', { name: '竹青', exact: true }).count()) > 0;
          await select('竹青');
          if (!iframeRejected) {
            markUncovered('cookie-invalid-ui', `HTTP rejected cookies but the child iframe still authorized session/list status=${iframeProbe.status}`);
            report.phases.cookie = { status: 'uncovered', evidence, iframeProbe, selectedBefore, selectedAfter };
          } else if (!outerStillWorks) {
            throw new Error('outer rail became unusable after child cookie invalidation');
          } else if (selectedAfter && selectedBefore && selectedAfter !== selectedBefore && /EternalNight|启动超时|崩溃/.test(selectedAfter)) {
            throw new Error(`selection incorrectly committed after auth failure: ${selectedAfter}`);
          } else {
            report.phases.cookie = { status: 'pass', evidence, iframeProbe, selectedBefore, selectedAfter };
            pass('real DSH rejected invalid child cookies; outer rail stayed usable and did not steal selection');
          }
        }
      } catch (error) {
        report.phases.cookie = { ...(report.phases.cookie || {}), status: 'fail', error: redact(errorText(error)) };
        throw error;
      }
    }

    if (phases.includes('crash')) {
      try {
        await select('竹青');
        await ensureSpace(CRASH_SPACE, CRASH_NAME);
        hub = await manager();
        const original = await currentRail(hub);
        await hub.getByRole('button', { name: CRASH_NAME, exact: true }).first().click();
        const record = await until(() => {
          const row = readInstanceRecord(home, CRASH_SPACE);
          return row?.pid ? row : null;
        }, 'crash-probe instance pid', 60000);
        const live = verifyOwnedChild(record, supervisor.pid, supervisorStartedAt);
        ownedProcesses.set(live.pid, live);
        const statusBeforeKill = (await api('state')).spaces.find(space => space.id === CRASH_SPACE)?.status;
        const unreadySelected = await currentRail(hub);
        const alreadyReady = statusBeforeKill === 'running' && unreadySelected === CRASH_NAME;
        await killOwnedPid(live);
        await until(async () => {
          const row = (await api('state')).spaces.find(space => space.id === CRASH_SPACE);
          return row && (row.status === 'crashed' || row.status === 'stopped');
        }, 'unready crash status', 30000);
        hub = await manager();
        const afterUnready = await currentRail(hub);
        if (alreadyReady) {
          markUncovered('crash-unready', 'crash-probe became running/selected before kill; unready path not proven this run');
        } else if (afterUnready === CRASH_NAME) {
          throw new Error('unready crash-probe stole rail focus');
        } else if (original && afterUnready && afterUnready !== original && unreadySelected === CRASH_NAME) {
          throw new Error('unready target committed before it was ready');
        }
        await select(CRASH_NAME);
        await until(async () => (await api('state')).spaces.find(space => space.id === CRASH_SPACE)?.status === 'running', 'restart crash-probe', 120000);
        const selectedRecord = await until(() => {
          const row = readInstanceRecord(home, CRASH_SPACE);
          return row?.pid && row.pid !== record.pid ? row : null;
        }, 'selected crash-probe pid', 60000);
        const selectedLive = verifyOwnedChild(selectedRecord, supervisor.pid, supervisorStartedAt);
        ownedProcesses.set(selectedLive.pid, selectedLive);
        await killOwnedPid(selectedLive);
        await until(async () => (await api('state')).spaces.find(space => space.id === CRASH_SPACE)?.status === 'crashed', 'selected crash status', 30000);
        hub = await manager();
        await hub.locator('.dsh-wb-idle, .dsh-wb-banner[role="alert"]').first().waitFor({ timeout: 20000 }).catch(() => {});
        const crashedCopy = await hub.getByText(/意外停止|Crashed|已崩溃/i).count();
        await select('竹青');
        const otherAvailable = (await currentRail(hub))?.includes('竹青');
        if (!otherAvailable) throw new Error('竹青 was not selectable after selected-space crash');
        await page.screenshot({ path: join(output, 'screenshots', 'crash-idle.png') });
        report.phases.crash = {
          status: 'pass',
          unreadyParent: live.parentPid,
          selectedCrashedCopy: crashedCopy > 0,
        };
        pass('owned child crash: unready target did not steal focus; selected crash showed error and other spaces stayed available');
      } catch (error) {
        report.phases.crash = { status: 'fail', error: redact(errorText(error)) };
        throw error;
      }
    }

    if (phases.includes('timeout')) {
      try {
        await select('竹青');
        await ensureSpace(HANG_SPACE, HANG_NAME);
        const packDir = join(output, 'packed');
        mkdirSync(packDir, { recursive: true });
        const npm = resolveNpmCli(node);
        const packed = run(node, [npm, 'pack', HANG_PLUGIN_DIR, '--json', '--ignore-scripts', '--pack-destination', packDir], {
          cwd: root, env, timeoutMs: 60000, label: 'pack hang-plugin',
        });
        const rows = JSON.parse(packed);
        const tgz = join(packDir, rows[0].filename);
        const pluginDest = join(home, 'hub', 'plugins', basename(tgz));
        mkdirSync(dirname(pluginDest), { recursive: true });
        copyFileSync(tgz, pluginDest);
        const rel = `file:../../hub/plugins/${basename(tgz)}`;
        try {
          runDsh(node, binding.bin, home, tooling, ['plugin', '--profile', HANG_SPACE, 'add', rel], 180000, 'install hang-plugin', join(output, 'hang-plugin.log'));
        } catch (error) {
          markUncovered('start-timeout', `hang-plugin install failed: ${redact(errorText(error))}`);
          report.phases.timeout = { status: 'uncovered', reason: 'plugin add failed' };
          throw new UncoveredSkip();
        }
        hub = await manager();
        const original = await currentRail(hub);
        const started = Date.now();
        await hub.getByRole('button', { name: HANG_NAME, exact: true }).first().click();
        const waitMs = Math.max(UI_START_TIMEOUT_MS, PROCESS_READY_TIMEOUT_MS) + 20_000;
        let outcome = 'pending';
        const hangRecord = await until(() => readInstanceRecord(home, HANG_SPACE), 'hang-timeout instance record', 30000).catch(() => null);
        if (hangRecord?.pid) {
          try {
            const hangLive = verifyOwnedChild(hangRecord, supervisor.pid, supervisorStartedAt);
            ownedProcesses.set(hangLive.pid, hangLive);
          } catch (error) {
            markUncovered('start-timeout-pid', redact(errorText(error)));
          }
        }
        await until(async () => {
          hub = await manager();
          const selected = await currentRail(hub);
          const row = (await api('state')).spaces.find(space => space.id === HANG_SPACE);
          const failedBanner = await hub.locator('.dsh-wb-banner[role="alert"]').count();
          const idle = await hub.locator('.dsh-wb-idle').count();
          if (selected === HANG_NAME && row?.status === 'running' && failedBanner === 0) {
            outcome = 'became-ready';
            return true;
          }
          if (selected && selected !== HANG_NAME && (row?.status === 'crashed' || row?.status === 'stopped' || failedBanner > 0 || idle > 0 || Date.now() - started > UI_START_TIMEOUT_MS)) {
            outcome = 'timeout-held';
            return row?.status === 'crashed' || row?.status === 'stopped' || failedBanner > 0 || Date.now() - started > UI_START_TIMEOUT_MS + 5000;
          }
          return false;
        }, 'product start timeout', waitMs);
        const elapsed = Date.now() - started;
        const selected = await currentRail(hub);
        const timeoutCopy = await hub.locator('.dsh-wb-banner[role="alert"], .dsh-wb-idle').allTextContents();
        const timeoutConfirmed = timeoutCopy.some(text => /超时|未就绪|timed?\s*out|timeout|not ready within/i.test(text));
        if (outcome === 'became-ready' || selected === HANG_NAME) {
          markUncovered('start-timeout', 'hang-plugin did not prevent the space from becoming the committed selection; not faking a timeout');
          report.phases.timeout = { status: 'uncovered', elapsedMs: elapsed, selected };
        } else if (elapsed + 5000 < Math.min(UI_HANDSHAKE_TIMEOUT_MS, PROCESS_READY_TIMEOUT_MS) || !timeoutConfirmed) {
          markUncovered('start-timeout', 'target failed without evidence of the product timeout; early or unrelated failure is not timeout coverage');
          report.phases.timeout = { status: 'uncovered', elapsedMs: elapsed, selected, original, timeoutCopy };
        } else {
          assert.equal(selected, original, 'timeout changed the committed space');
          report.phases.timeout = { status: 'pass', elapsedMs: elapsed, selected, original, waitedAtLeastMs: Math.min(UI_HANDSHAKE_TIMEOUT_MS, PROCESS_READY_TIMEOUT_MS) };
          pass('real product start/handshake timeout kept 竹青 selected; hang process is owned for cleanup');
        }
      } catch (error) {
        if (error instanceof UncoveredSkip) {
          /* already recorded */
        } else {
          report.phases.timeout = { status: 'fail', error: redact(errorText(error)) };
          throw error;
        }
      }
    }

    const failedPhase = Object.values(report.phases).some(row => row?.status === 'fail');
    report.coverageComplete = uncovered.length === 0 && !failedPhase && phases.every(name => report.phases[name]?.status === 'pass');
    report.status = failedPhase ? 'fail' : report.coverageComplete ? 'pass' : 'partial';
    report.scope = 'Exception switch + session/scroll persistence on the reused theme Home. Last-click-wins is not re-run.';
  } catch (error) {
    report.status = 'fail';
    report.error = redact(errorText(error));
    if (page) await page.screenshot({ path: join(output, 'screenshots', 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (api) {
      try {
        const plan = await api('preview', { request: { kind: 'controller.shutdown' } });
        await api('submit', { command: { kind: 'plan.execute', planId: plan.id }, requestId: randomUUID() });
        await until(() => supervisor.exitCode !== null, 'supervisor clean shutdown', 15000).catch(() => {});
      } catch {
        /* owned cleanup below */
      }
    }
    await browser?.close().catch(() => {});
    for (const identity of ownedProcesses.values()) {
      try {
        await killOwnedPid(identity);
      } catch (error) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push(redact(errorText(error)));
        report.status = 'fail';
        report.coverageComplete = false;
      }
    }
    if (supervisor?.exitCode === null) await stopOwned(supervisor);
    writeLogs();
    report.finishedAt = new Date().toISOString();
    if (report.status === 'running') report.status = 'fail';
    save();
  }
}

class UncoveredSkip extends Error {
  constructor() {
    super('uncovered');
    this.name = 'UncoveredSkip';
  }
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
  const results = JSON.parse(readFileSync(join(flags.output, 'results.json'), 'utf8'));
  if (results.status === 'fail') process.exitCode = 1;
  else if (results.status === 'partial') {
    console.log(`PARTIAL coverageComplete=false uncovered=${results.uncovered.length}`);
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(error => {
    const message = redact(error instanceof Error ? error.message : error);
    console.error(`FAIL ${message}`);
    try {
      const output = resolve(process.env.DSH_TEST_OUTPUT || DEFAULT_OUTPUT);
      mkdirSync(output, { recursive: true });
      const path = join(output, 'results.json');
      const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { status: 'fail' };
      if (existing.status === 'running' || !existing.error) {
        existing.status = 'fail';
        existing.error = existing.error || message;
        existing.finishedAt = new Date().toISOString();
        writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
      }
    } catch {
      /* best-effort fail record */
    }
    process.exitCode = 1;
  });
}
