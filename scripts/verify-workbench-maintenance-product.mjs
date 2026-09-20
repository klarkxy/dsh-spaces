#!/usr/bin/env node
/**
 * Independent maintenance product acceptance against a packed supervisor and a
 * disposable Home. Real DSH + pnpm. No model calls. Does not import or modify
 * scripts/verify-workbench-product.mjs.
 *
 *   node scripts/verify-workbench-maintenance-product.mjs [--phase plugins|snapshot|runtime|all]
 *     [--http-only] [--output DIR] [--home DIR]
 *
 * Env: DSH_TEST_BIN, DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE,
 * DSH_TEST_OUTPUT, DSH_TEST_HOME, DSH_TEST_PNPM_CJS.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
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
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(process.env.DSH_TEST_PACKAGE_ROOT || join(root, 'packages'));
const node = process.execPath;
const COMPATIBLE = process.env.DSH_TEST_EXPECTED_VERSION || '0.1.5-rc.1';
const UPGRADE_TARGET = process.env.DSH_TEST_UPGRADE_VERSION || COMPATIBLE;
const REFUSED_VERSION = process.env.DSH_TEST_REFUSED_VERSION || '0.1.5-rc.2';
const THEME_PACKAGE = '@eternalnight/dsh-theme';
const THEME_VERSION = '0.5.1';
const SPACE = 'coding';
const SPACE_NAME = '编程';
const PHASES = ['plugins', 'snapshot', 'runtime'];
const DEFAULT_PLAYWRIGHT =
  'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const JOB_MS = 600_000;
const RUNTIME_MS = 900_000;
const SUPERVISOR_MS = 240_000;
const SEED_MS = 180_000;
const HEARTBEAT_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 3_000;
const JOB_QUERY_MS = 5_000;
const CORE_LIB = join(packageRoot, 'core/lib/index.js');

const flags = parseFlags(process.argv.slice(2));
const output = flags.output;
const bin = process.env.DSH_TEST_BIN || DEFAULT_BIN;
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
  compatibleCli: COMPATIBLE,
  theme: { packageName: THEME_PACKAGE, version: THEME_VERSION },
};
const redact = value =>
  String(value)
    .replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/\/bootstrap\/[^\s"'<>]+/g, '/bootstrap/[redacted]')
    .replace(/(dsh-auth-[^=\s]+)=([^;\s"']+)/g, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer [redacted]');
const pass = text => {
  proved.push(text);
  console.log(`PASS ${text}`);
};
const save = () => {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
};
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
let isolationApi;

async function loadIsolation() {
  if (!isolationApi) {
    assert.ok(existsSync(CORE_LIB), 'packages/core/lib/index.js missing');
    isolationApi = await import(pathToFileURL(CORE_LIB).href);
    assert.equal(typeof isolationApi.applyIsolationPatch, 'function');
  }
  return isolationApi;
}

function isTransportError(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
  if (/workbench\//i.test(text)) return false;
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|AbortError|TimeoutError|Timeout \d+ms exceeded|network|ECONN/i.test(text);
}

function transportSummary(error) {
  return redact(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240);
}

function supervisorExit(session) {
  const child = session?.supervisor;
  if (!child) return { exitCode: null, signal: 'missing' };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return null;
}

function nextBackoff(attempt) {
  return Math.min(2000, 250 * 2 ** Math.min(attempt, 3));
}

function writeEventLoopProbe(phaseDir) {
  const path = join(phaseDir, 'event-loop-probe.cjs');
  writeFileSync(path, `'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');
const hist = monitorEventLoopDelay({ resolution: 20 });
hist.enable();
// Test-only call timing. Do not log arguments, paths, environment, or secrets.
for (const [module, names] of [
  [require('node:fs'), ['existsSync','readFileSync','writeFileSync','readdirSync','statSync','lstatSync','realpathSync','renameSync','mkdirSync','rmSync','unlinkSync','copyFileSync']],
  [require('node:child_process'), ['spawn','spawnSync','execSync','execFileSync']],
]) {
  for (const name of names) {
    const original = module[name];
    module[name] = function(...args) {
      const started = performance.now();
      try { return Reflect.apply(original, this, args); }
      finally {
        const elapsed = performance.now() - started;
        if (elapsed > 200) process.stderr.write('[slow-sync] ' + name + ' ms=' + elapsed.toFixed(1) + ' ' + new Error().stack.split('\\n').slice(2,6).join(' | ') + '\\n');
      }
    };
    Object.assign(module[name], original);
  }
}
require('node:module').syncBuiltinESMExports();
const THRESHOLD_MS = 100;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const intervalLag = now - last - 1000;
  last = now;
  const maxMs = hist.max / 1e6;
  const meanMs = hist.mean / 1e6;
  const p99Ms = hist.percentile(99) / 1e6;
  hist.reset();
  if (maxMs >= THRESHOLD_MS || intervalLag >= THRESHOLD_MS) {
    process.stderr.write(
      '[event-loop-probe] pid=' + process.pid +
      ' maxMs=' + maxMs.toFixed(1) +
      ' meanMs=' + meanMs.toFixed(1) +
      ' p99Ms=' + p99Ms.toFixed(1) +
      ' intervalLagMs=' + Math.max(0, intervalLag).toFixed(1) +
      String.fromCharCode(10),
    );
  }
}, 1000).unref();
`);
  return path;
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

function markerPaths(home) {
  return {
    hub: join(home, 'hub', SPACE, 'sessions', 'maintenance-marker.txt'),
    home: join(home, 'sessions', SPACE, 'maintenance-marker.txt'),
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

function parseFlags(argv) {
  let phase = 'all';
  let httpOnly = false;
  let out = process.env.DSH_TEST_OUTPUT || join(root, '.sandbox', 'workbench-maintenance-product');
  let home = process.env.DSH_TEST_HOME || '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--http-only') {
      httpOnly = true;
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
  if (!['plugins', 'snapshot', 'runtime', 'all'].includes(phase)) {
    throw new Error(`unknown --phase ${phase}; expected plugins|snapshot|runtime|all`);
  }
  return { phase, httpOnly, output: resolve(out), home: home.trim() ? resolve(home.trim()) : '' };
}

async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function stripSecrets(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) {
      delete next[key];
    }
  }
  return next;
}

function packArtifact(name, packDir, env) {
  const npm = resolveNpmCli(node);
  const result = run(node, [npm, 'pack', join(packageRoot, name), '--json', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: root,
    env,
    timeoutMs: 60000,
    label: `pack ${name}`,
  });
  const rows = JSON.parse(result);
  const file = join(packDir, rows[0].filename);
  assert.ok(existsSync(file), `packed ${name} missing`);
  return file;
}

function cookieFromSetCookie(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const joined = raw.map(value => value.split(';')[0]).filter(Boolean).join('; ');
  assert.ok(joined, 'bootstrap did not set an auth cookie');
  return joined;
}

async function loadChromium() {
  const candidates = [
    process.env.DSH_TEST_PLAYWRIGHT,
    process.env.DSH_TEST_PLAYWRIGHT_MODULE,
    DEFAULT_PLAYWRIGHT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = existsSync(candidate) && candidate.endsWith('.mjs')
      ? resolve(candidate)
      : join(resolve(candidate), 'index.mjs');
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    if (!mod.chromium) throw new Error(`Playwright at ${file} has no chromium export`);
    return mod.chromium;
  }
  throw new Error('Playwright missing; set DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE');
}

function makeApi(origin, cookie, context) {
  return async (method, payload = {}, timeout = 30000) => {
    let body;
    if (context) {
      const response = await context.request.post(`${origin}/api/workbench/${method}`, {
        headers: { origin },
        data: payload,
        timeout,
      });
      body = await response.json();
    } else {
      const result = await fetch(`${origin}/api/workbench/${method}`, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
      body = await result.json();
    }
    if (!body.ok) {
      throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
    }
    return body.value;
  };
}

function pluginDisk(home, spaceId, packageName) {
  const profile = join(home, 'profiles', spaceId);
  const manifestPath = join(profile, 'package.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { dependencies: {} };
  const declared = manifest.dependencies?.[packageName];
  const lockPath = ['pnpm-lock.yaml', 'pnpm-lock.yml'].map(name => join(profile, name)).find(path => existsSync(path));
  const installedPath = join(profile, 'node_modules', ...packageName.split('/'), 'package.json');
  const installed = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, 'utf8')) : null;
  let lockEntry;
  if (lockPath) {
    const lock = parseYaml(readFileSync(lockPath, 'utf8'));
    lockEntry = lock?.importers?.['.']?.dependencies?.[packageName];
  }
  return { manifestPath, declared, lockPath, lockEntry, installedPath, installed };
}

function assertInstalled(home, spaceId, packageName, version) {
  const disk = pluginDisk(home, spaceId, packageName);
  const fromOwnedArchive = typeof disk.declared === 'string' && disk.declared.startsWith('file:');
  assert.ok(disk.declared, `${packageName} missing from ${disk.manifestPath}`);
  if (!fromOwnedArchive) assert.equal(disk.declared, version, `${packageName} manifest version`);
  assert.ok(disk.installed, `${packageName} missing node_modules package.json`);
  assert.equal(disk.installed.name, packageName);
  assert.equal(disk.installed.version, version);
  assert.ok(disk.lockPath, `${spaceId} pnpm lock missing`);
  assert.ok(disk.lockEntry, `${packageName} missing from pnpm lock importers`);
  assert.equal(disk.lockEntry.specifier, disk.declared);
  assert.equal(typeof disk.lockEntry.version, 'string');
  assert.ok(disk.lockEntry.version);
  return disk;
}

function assertRemoved(home, spaceId, packageName) {
  const disk = pluginDisk(home, spaceId, packageName);
  assert.equal(disk.declared, undefined, `${packageName} still in package.json`);
  assert.equal(disk.lockEntry, undefined, `${packageName} still in pnpm lock`);
  assert.equal(disk.installed, null, `${packageName} still in node_modules`);
  return disk;
}

function spaceMetaName(home, spaceId) {
  const path = join(home, 'hub', 'spaces.json');
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  return file.meta?.[spaceId]?.displayName;
}

function patchPath(home, spaceId) {
  return join(home, 'profiles', spaceId, 'cordis.patch.yml');
}

function readPatch(home, spaceId) {
  const path = patchPath(home, spaceId);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
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

async function submitJob(session, command, options = {}) {
  const requestId = options.requestId || randomUUID();
  const timeout = options.timeout ?? JOB_MS;
  const label = options.label || command.kind;
  const heartbeat = startEntryHeartbeat(session);
  const transport = [];
  let latest;
  let runError;
  try {
    const first = await session.api('submit', { command, requestId });
    latest = first;
    if (options.resume) {
      if (session.page) {
        await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await until(() => session.page.url().startsWith(`${session.origin}/`), 'stable entry after reload', 30000);
      }
      const again = await session.api('submit', { command, requestId });
      assert.equal(again.id, first.id, 'same requestId must not open a second job');
      assert.equal(again.requestId, first.requestId);
      assert.equal(again.kind, first.kind);
    }
    const deadline = Date.now() + timeout;
    let attempt = 0;
    while (Date.now() < deadline) {
      const death = supervisorExit(session);
      if (death) {
        throw new Error(`${label}: supervisor exited during job query exitCode=${death.exitCode} signal=${death.signal}`);
      }
      const read = await readJobOnce(session, first.id);
      if (read.ok) {
        latest = read.value;
        attempt = 0;
        if (!['queued', 'running'].includes(latest.status)) break;
        await delay(250);
        continue;
      }
      if (!isTransportError(read.error)) throw read.error;
      transport.push({ at: new Date().toISOString(), summary: transportSummary(read.error) });
      const deathAfter = supervisorExit(session);
      if (deathAfter) {
        throw new Error(`${label}: supervisor exited after transport error exitCode=${deathAfter.exitCode} signal=${deathAfter.signal}`);
      }
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
    requestId,
    jobId: latest?.id,
    status: latest?.status,
    phase: latest?.phase,
    transport,
    heartbeat: heartbeatStats,
  });
  const death = supervisorExit(session);
  const pending = !latest || ['queued', 'running'].includes(latest.status);
  if (death && pending) {
    throw new Error(`${label}: supervisor exited exitCode=${death.exitCode} signal=${death.signal}; lastJob=${latest?.status ?? 'none'} ${latest?.phase ?? ''}`);
  }
  if (pending && runError && !isTransportError(runError)) throw runError;
  if (pending) {
    throw new Error(`${label}: timed out without a terminal job; last=${latest?.status ?? 'none'} ${latest?.phase ?? ''} transport=${transport.length}`);
  }
  assert.equal(latest.status, 'succeeded', `${label}: ${JSON.stringify(latest.error)}`);
  if (heartbeatStats.outageFail) {
    throw new Error(
      `${label}: stable entry unavailable for ${heartbeatStats.maxGapMs}ms (limit ${HEARTBEAT_TIMEOUT_MS}ms); ` +
      `job reached ${latest.status}/${latest.phase}; maxGetMs=${heartbeatStats.maxMs} failures=${heartbeatStats.failures.length}`,
    );
  }
  if (runError) throw runError;
  return latest;
}

async function executePlan(session, request, options = {}) {
  const plan = await session.api('preview', { request });
  const job = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, options);
  return { plan, job };
}

async function assertViewEntry(session, spaceId) {
  const view = await session.api('view', { spaceId });
  const entry = await fetch(`${view.entryOrigin}${view.entryPath}`, {
    headers: { cookie: session.cookie, origin: session.origin },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(entry.status, 200, `/view must return 200 with a replace document, not a 303; got ${entry.status}`);
  const html = await entry.text();
  assert.ok(
    html.includes(`location.replace(${JSON.stringify(`${view.origin}/`)})`),
    'view document must location.replace the child origin',
  );
  return view;
}

async function assertStableEntry(session) {
  const response = await fetch(`${session.origin}/`, {
    headers: { cookie: session.cookie },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.length > 0, 'stable entry returned an empty document');
  return html;
}

async function closeBrowserKeepService(session, label) {
  if (!session.browser) return;
  await session.browser.close();
  session.browser = undefined;
  session.context = undefined;
  session.page = undefined;
  session.api = makeApi(session.origin, session.cookie);
  assert.equal(session.supervisor.exitCode, null, 'closing the browser must not end the supervisor');
  const state = await session.api('state');
  assert.ok(state, 'state API must remain after the browser closes');
  await assertStableEntry(session);
  pass(`${label}: browser close left the supervisor and stable entry available`);
}

async function launchPhase(phase, home, artifacts, env) {
  const phaseDir = join(output, phase);
  mkdirSync(phaseDir, { recursive: true });
  refuseRealHome(home);
  const tools = join(phaseDir, 'tools', basename(home));
  const snapshots = join(phaseDir, 'snapshots', basename(home));
  mkdirSync(tools, { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  mkdirSync(join(phaseDir, 'screenshots'), { recursive: true });
  runDsh(node, bin, home, {
    shim: join(output, 'shim'),
    pnpmHome: join(output, 'pnpmHome'),
    store: join(output, 'store'),
    cache: join(output, 'cache'),
  }, ['--profile', 'web', '--dump-config'], SEED_MS, `${phase} seed web`, join(phaseDir, 'seed.log'));
  const probePath = writeEventLoopProbe(phaseDir);
  const spawnEnv = { ...env };
  delete spawnEnv.NODE_OPTIONS;
  const supervisor = spawn(node, [
    '--require', probePath,
    join(packageRoot, 'supervisor/lib/index.js'),
    '--home', home, '--bin', bin, '--node', node, '--port', '0',
    '--plugin-artifact', artifacts.plugin.path,
    '--view-bridge-artifact', artifacts.bridge.path,
    '--snapshot-worker', join(packageRoot, 'supervisor/lib/snapshot-worker.mjs'),
    '--control-tool-root', tools,
    '--snapshot-root', snapshots,
  ], { cwd: root, env: spawnEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchOutput = '';
  let stderr = '';
  supervisor.stdout.on('data', chunk => { launchOutput = (launchOutput + chunk.toString()).slice(-32768); });
  supervisor.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });
  const session = {
    phase,
    home,
    phaseDir,
    tools,
    snapshots,
    probePath,
    supervisor,
    observations: { jobs: [] },
    launchOutput: () => launchOutput,
    stderr: () => stderr,
    origin: '',
    cookie: '',
    api: undefined,
    browser: undefined,
    context: undefined,
    page: undefined,
  };
  try {
    await until(() => {
      if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${redact(stderr)}`);
      return /bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(launchOutput);
    }, `${phase} packaged supervisor initialization`, SUPERVISOR_MS);
    const bootstrapUrl = launchOutput.match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1];
    session.origin = new URL(bootstrapUrl).origin;
    if (flags.httpOnly) {
      const response = await fetch(bootstrapUrl, { redirect: 'manual' });
      await response.body?.cancel();
      assert.equal(response.status, 303, 'bootstrap cookie exchange is 303 to /');
      session.cookie = cookieFromSetCookie(response.headers);
      session.api = makeApi(session.origin, session.cookie);
    } else {
      const chromium = await loadChromium();
      session.browser = await chromium.launch({ headless: true });
      session.context = await session.browser.newContext({ viewport: { width: 1440, height: 900 } });
      session.page = await session.context.newPage();
      session.page.on('pageerror', error => console.log(`BROWSER ${redact(error.message)}`));
      await session.page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await until(() => session.page.url() === `${session.origin}/`, 'clean stable entry URL');
      const cookies = await session.context.cookies();
      session.cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
      assert.ok(session.cookie, 'Playwright session cookie missing');
      session.api = makeApi(session.origin, session.cookie, session.context);
    }
    const state = await session.api('state');
    assert.equal(state.role, 'manager', JSON.stringify(state.reasons));
    assert.equal(state.writable, true);
    assert.ok(state.managerId);
    assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, 'running');
    pass(`${phase}: packaged supervisor started a real dedicated manager`);
    return session;
  } catch (error) {
    await session.page?.screenshot({ path: join(phaseDir, 'screenshots', 'failure.png') }).catch(() => {});
    throw error;
  }
}

async function shutdownOwned(session) {
  if (!session) return;
  try {
    if (session.api) {
      const plan = await session.api('preview', { request: { kind: 'controller.shutdown' } });
      await session.api('submit', { command: { kind: 'plan.execute', planId: plan.id }, requestId: randomUUID() });
      await until(() => session.supervisor.exitCode !== null, `${session.phase} supervisor clean shutdown`, 15000);
    }
  } catch {
    /* Owned tree cleanup below. Never other Home processes. */
  }
  await session.browser?.close().catch(() => {});
  if (session.supervisor.exitCode === null) await stopOwned(session.supervisor);
  writeFileSync(
    join(session.phaseDir, 'supervisor.log'),
    redact(`${session.launchOutput()}\n${session.stderr()}`),
  );
}

async function phasePlugins(session) {
  const { home, api, phaseDir } = session;
  await submitJob(session, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, { timeout: JOB_MS, label: 'space.create' });
  const created = JSON.parse(readFileSync(join(home, 'profiles', SPACE, 'package.json'), 'utf8'));
  assert.equal(Boolean(created.dependencies?.['@dsh-spaces/plugin']), false);
  assert.ok(created.dependencies?.['@dsh-spaces/view-bridge']);
  pass('ordinary space created without the full Spaces plugin');

  const backupsBefore = await api('backups', { spaceId: SPACE });
  assert.ok(Array.isArray(backupsBefore) && backupsBefore.length > 0, 'space.create should leave a configuration backup from PatchWriter');
  const backup = backupsBefore[0];
  const backupFile = join(home, 'profiles', SPACE, backup.id);
  assert.ok(existsSync(backupFile), `backup ${backup.id} missing on disk`);
  const backupBody = readFileSync(backupFile, 'utf8');
  pass(`configuration backup listed and readable: ${backup.id}`);

  await submitJob(session, { kind: 'space.start', spaceId: SPACE }, { timeout: JOB_MS, label: 'space.start' });
  await assertViewEntry(session, SPACE);
  pass('ordinary space /view returned 200 Cookie + location.replace, not 303');

  const found = await api('plugins', { query: THEME_PACKAGE });
  const plugin = found.find(row => row.packageName === THEME_PACKAGE || row.id === THEME_PACKAGE);
  assert.ok(plugin, `public catalog query did not return ${THEME_PACKAGE}: ${JSON.stringify(found)}`);
  pass(`public catalog query returned ${plugin.packageName} id=${plugin.id}`);

  const catalogId = plugin.id;
  let installPlan;
  try {
    installPlan = await api('preview', {
      request: { kind: 'plugin.install', spaceIds: [SPACE], catalogId, version: THEME_VERSION },
    });
  } catch (error) {
    throw new Error(`plugin.install preview rejected catalogId=${catalogId} version=${THEME_VERSION}: ${redact(error instanceof Error ? error.message : error)}`);
  }
  const installJob = await submitJob(
    session,
    { kind: 'plan.execute', planId: installPlan.id },
    { resume: true, timeout: JOB_MS, label: 'plugin.install' },
  );
  assert.equal(installJob.status, 'succeeded');
  pass('plugin.install job resumed by id after refresh/resubmit without a second job');

  assertInstalled(home, SPACE, THEME_PACKAGE, THEME_VERSION);
  const afterInstall = await api('plugins', { query: THEME_PACKAGE });
  const installedRow = afterInstall.find(row => row.packageName === THEME_PACKAGE);
  assert.ok(installedRow?.installedIn?.includes(SPACE), 'plugins() did not list the theme as installed in the ordinary space');
  if (session.page) {
    await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'plugin-installed.png') });
  }
  pass(`${THEME_PACKAGE}@${THEME_VERSION} manifest + node_modules + pnpm lock read back`);

  const patchAfterInstall = readPatch(home, SPACE);
  assert.equal((await api('state')).spaces.find(space => space.id === SPACE)?.status, 'running');
  await executePlan(session, { kind: 'config.restore', spaceId: SPACE, backupId: backup.id }, { timeout: JOB_MS, label: 'config.restore' });
  const restoredPatch = readPatch(home, SPACE);
  const livePath = patchPath(home, SPACE);
  assert.ok(existsSync(livePath), 'live cordis.patch.yml missing after config.restore');
  assert.ok(existsSync(backupFile) && readFileSync(backupFile, 'utf8') === backupBody, 'listed backup bytes were rewritten');
  const { applyIsolationPatch, patchTextLooksIsolated } = await loadIsolation();
  const expectedLive = applyIsolationPatch(backupBody, SPACE, livePath);
  assert.equal(restoredPatch, expectedLive, 'live patch must equal source backup after PatchWriter isolation transform');
  assert.ok(patchTextLooksIsolated(restoredPatch, SPACE), 'restored patch must keep hub/coding sessions and storages isolation');
  const backupsAfter = await api('backups', { spaceId: SPACE });
  assert.ok(backupsAfter.some(row => row.id === backup.id), 'restored backup id disappeared from backups()');
  assert.ok(backupsAfter.length > backupsBefore.length, 'config.restore should keep the source backup and write a new bak of the replaced live patch');
  assert.equal((await api('state')).spaces.find(space => space.id === SPACE)?.status, 'stopped', 'config.restore must stop the target space');
  if (patchAfterInstall.includes(THEME_PACKAGE)) {
    assert.equal(restoredPatch.includes(THEME_PACKAGE), false, 'restored patch still mentions the installed theme');
  }
  pass('config.restore read back: live patch equals isolated(sourceBackup); source bytes intact');

  let removePlan;
  try {
    removePlan = await api('preview', {
      request: { kind: 'plugin.remove', spaceId: SPACE, packageName: THEME_PACKAGE },
    });
  } catch (error) {
    throw new Error(`plugin.remove preview rejected packageName=${THEME_PACKAGE}: ${redact(error instanceof Error ? error.message : error)}`);
  }
  await submitJob(session, { kind: 'plan.execute', planId: removePlan.id }, { timeout: JOB_MS, label: 'plugin.remove' });
  assertRemoved(home, SPACE, THEME_PACKAGE);
  const afterRemove = await api('plugins', { query: THEME_PACKAGE });
  const removedRow = afterRemove.find(row => row.packageName === THEME_PACKAGE);
  assert.equal(Boolean(removedRow?.installedIn?.includes(SPACE)), false, 'plugins() still lists the theme as installed');
  pass(`${THEME_PACKAGE} uninstalled; manifest, lock and node_modules read back empty`);

  if (flags.httpOnly) uncovered.push('plugins: browser close does not stop supervisor (http-only)');
  else await closeBrowserKeepService(session, 'plugins');
}

async function phaseSnapshot(session) {
  const { home, api, phaseDir } = session;
  await submitJob(session, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, { timeout: JOB_MS });
  await submitJob(session, { kind: 'space.start', spaceId: SPACE }, { timeout: JOB_MS });
  writeMarkers(home, 'before-snapshot\n');
  const beforeName = spaceMetaName(home, SPACE) || SPACE_NAME;
  const beforeRuntime = (await api('runtimes')).find(row => row.current);
  assert.ok(beforeRuntime, 'current runtime missing before snapshot');
  assert.equal(beforeRuntime.version, COMPATIBLE);
  assert.equal(beforeRuntime.compatible, true);

  const created = await executePlan(session, { kind: 'snapshot.create' }, {
    resume: true,
    timeout: JOB_MS,
    label: 'snapshot.create',
  });
  const snapshotId = created.job.result?.snapshotId;
  assert.equal(typeof snapshotId, 'string');
  const listed = await api('snapshots');
  assert.ok(listed.some(row => row.id === snapshotId));
  const one = await api('snapshot', { id: snapshotId });
  assert.equal(one.restorable, true);
  assert.equal(one.runtimeVersion, COMPATIBLE);
  pass(`whole-home snapshot ${snapshotId} listed and restorable at ${COMPATIBLE}`);

  await submitJob(session, { kind: 'space.update', spaceId: SPACE, displayName: '已改名' });
  assert.equal(spaceMetaName(home, SPACE), '已改名');
  writeMarkers(home, 'after-snapshot-changed\n');
  await submitJob(session, { kind: 'space.start', spaceId: SPACE }, { timeout: JOB_MS });
  assert.equal((await api('state')).spaces.find(space => space.id === SPACE)?.status, 'running');

  await executePlan(session, { kind: 'snapshot.restore', snapshotId }, { timeout: JOB_MS, label: 'snapshot.restore' });
  const state = await api('state');
  const ordinary = state.spaces.find(space => space.id === SPACE);
  const manager = state.spaces.find(space => space.id === state.managerId);
  assert.ok(ordinary, 'ordinary space missing after restore');
  assert.equal(ordinary.status, 'stopped', 'manager reinitialize must not auto-start ordinary spaces');
  assert.equal(ordinary.displayName, beforeName);
  assert.equal(spaceMetaName(home, SPACE), beforeName);
  const restoredMarkers = readMarkers(home);
  assert.equal(restoredMarkers.hub, 'before-snapshot\n', 'hub/coding/sessions marker was not restored');
  assert.equal(restoredMarkers.home, 'before-snapshot\n', 'sessions/coding marker was not restored');
  assert.equal(manager?.status, 'running', 'manager should be running after restore reinitialize');
  const afterRuntime = (await api('runtimes')).find(row => row.current);
  assert.equal(afterRuntime?.version, beforeRuntime.version);
  assert.equal(afterRuntime?.compatible, true);
  await assertStableEntry(session);
  if (session.page) {
    await until(() => session.page.url().startsWith(`${session.origin}/`), 'stable entry still in the browser', 15000);
    await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'snapshot-restored.png') });
  }
  pass('snapshot restore read back display name, hub/coding/sessions marker, Home sessions marker, runtime; ordinary stayed stopped; entry queryable');

  if (flags.httpOnly) uncovered.push('snapshot: browser close does not stop supervisor (http-only)');
  else await closeBrowserKeepService(session, 'snapshot');
}

async function phaseRuntime(session) {
  const { api, tools, phaseDir } = session;
  const before = await api('runtimes');
  const current = before.find(row => row.current);
  assert.ok(current, 'runtimes() has no current row');
  assert.equal(current.version, COMPATIBLE, `current runtime is ${current.version}, not baseline ${COMPATIBLE}`);
  assert.equal(current.compatible, true);
  pass(`runtimes() current is exact ${COMPATIBLE} and compatible`);

  const installed = await executePlan(session, { kind: 'runtime.install', version: UPGRADE_TARGET }, {
    resume: true,
    timeout: RUNTIME_MS,
    label: 'runtime.install',
  });
  assert.equal(installed.job.result?.runtimeVersion, UPGRADE_TARGET);
  const storeBin = join(tools, 'versions', UPGRADE_TARGET, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  assert.ok(existsSync(storeBin), `runtime.install did not write ${storeBin}`);
  const storePkg = JSON.parse(readFileSync(join(tools, 'versions', UPGRADE_TARGET, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  assert.equal(storePkg.version, UPGRADE_TARGET);
  const afterInstall = (await api('runtimes')).find(row => row.version === UPGRADE_TARGET);
  assert.equal(afterInstall?.installed, true);
  pass(`runtime.install ${UPGRADE_TARGET} wrote a real store tree; selection remains unchanged`);

  const upgraded = await executePlan(session, { kind: 'runtime.upgrade', version: UPGRADE_TARGET }, {
    timeout: RUNTIME_MS,
    label: 'runtime.upgrade',
  });
  assert.equal(upgraded.job.result?.runtimeVersion, UPGRADE_TARGET);
  const pointerPath = join(tools, 'current.json');
  assert.ok(existsSync(pointerPath), 'upgrade did not write runtime current.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  assert.equal(pointer.version, UPGRADE_TARGET);
  const afterUpgrade = (await api('runtimes')).find(row => row.current);
  assert.equal(afterUpgrade?.version, UPGRADE_TARGET);
  assert.equal(afterUpgrade?.compatible, true);
  const state = await api('state');
  assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, 'running');
  if (session.page) {
    await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'runtime-upgraded.png') });
  }
  pass(`runtime.upgrade ${COMPATIBLE} -> ${UPGRADE_TARGET} committed; manager runs with the new pointer`);

  await assert.rejects(
    () => api('preview', { request: { kind: 'runtime.upgrade', version: REFUSED_VERSION } }),
    error => /unsupported/i.test(String(error)),
  );
  pass(`runtime.upgrade ${REFUSED_VERSION} refused by the selected build's gate`);

  if (flags.httpOnly) uncovered.push('runtime: browser close does not stop supervisor (http-only)');
  else await closeBrowserKeepService(session, 'runtime');
}

async function runPhase(phase, artifacts, tooling, explicitHome) {
  const phaseDir = join(output, phase);
  mkdirSync(phaseDir, { recursive: true });
  const home = explicitHome || mkdtempSync(join(phaseDir, 'home-'));
  refuseRealHome(home);
  const env = stripSecrets(isolatedEnv(home, node, tooling));
  const started = new Date().toISOString();
  const row = { status: 'running', home, startedAt: started };
  phaseResults[phase] = row;
  save();
  let session;
  try {
    session = await launchPhase(phase, home, artifacts, env);
    row.origin = session.origin;
    row.probe = session.probePath;
    if (phase === 'plugins') await phasePlugins(session);
    else if (phase === 'snapshot') await phaseSnapshot(session);
    else if (phase === 'runtime') await phaseRuntime(session);
    else throw new Error(`unknown phase ${phase}`);
    row.status = 'pass';
    row.finishedAt = new Date().toISOString();
  } catch (error) {
    row.status = 'fail';
    row.error = redact(error instanceof Error ? error.stack : error);
    row.finishedAt = new Date().toISOString();
    if (session?.page) {
      await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (session?.observations) row.observations = session.observations;
    const death = session ? supervisorExit(session) : null;
    if (death) row.supervisorExit = death;
    await shutdownOwned(session);
    save();
  }
}

async function main() {
  mkdirSync(output, { recursive: true });
  report.output = output;
  report.startedAt = new Date().toISOString();
  report.httpOnly = flags.httpOnly;
  if (flags.httpOnly) {
    uncovered.push('Playwright page.reload job resume (http-only still resubmits the same requestId over HTTP)');
  }
  if (!existsSync(bin)) throw new Error(`DSH CLI missing at ${bin}; set DSH_TEST_BIN`);
  const version = cliVersion(bin);
  if (version !== COMPATIBLE) {
    throw new Error(`bound CLI is ${version}; maintenance product only accepts ${COMPATIBLE}`);
  }
  const supervisorJs = join(packageRoot, 'supervisor/lib/index.js');
  const workerJs = join(packageRoot, 'supervisor/lib/snapshot-worker.mjs');
  assert.ok(existsSync(supervisorJs), 'packages/supervisor/lib/index.js missing');
  assert.ok(existsSync(workerJs), 'packages/supervisor/lib/snapshot-worker.mjs missing');
  await loadIsolation();

  const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(output, key)]));
  Object.values(tooling).forEach(path => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, node, resolvePnpmCjs());
  const packHome = mkdtempSync(join(output, 'pack-home-'));
  refuseRealHome(packHome);
  const packEnv = stripSecrets(isolatedEnv(packHome, node, tooling));
  const packDir = join(output, 'packed');
  mkdirSync(packDir, { recursive: true });
  const plugin = packArtifact('plugin', packDir, packEnv);
  const bridge = packArtifact('view-bridge', packDir, packEnv);
  report.artifacts = { plugin: { path: plugin, sha256: hash(plugin) }, bridge: { path: bridge, sha256: hash(bridge) } };
  pass('plugin and view-bridge packed for the packaged supervisor');

  const selected = flags.phase === 'all' ? PHASES : [flags.phase];
  const failures = [];
  for (const phase of selected) {
    const home = flags.home
      ? (flags.phase === 'all' ? join(flags.home, phase) : flags.home)
      : '';
    if (home) {
      mkdirSync(home, { recursive: true });
      refuseRealHome(home);
    }
    try {
      await runPhase(phase, report.artifacts, tooling, home || undefined);
    } catch (error) {
      failures.push({ phase, error: redact(error instanceof Error ? error.message : error) });
      console.error(`FAIL ${phase}: ${redact(error instanceof Error ? error.message : error)}`);
    }
  }
  if (failures.length) {
    report.status = 'fail';
    report.error = failures.map(item => `${item.phase}: ${item.error}`).join('\n');
    report.finishedAt = new Date().toISOString();
    save();
    process.exitCode = 1;
    return;
  }
  report.status = 'pass';
  report.finishedAt = new Date().toISOString();
  save();
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(error => {
    report.status = 'fail';
    report.error ||= redact(error instanceof Error ? error.stack : error);
    mkdirSync(output, { recursive: true });
    save();
    console.error(`FAIL ${redact(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}
