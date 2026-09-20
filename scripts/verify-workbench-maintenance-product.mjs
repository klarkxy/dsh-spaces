#!/usr/bin/env node
/**
 * B3/B5 maintenance product acceptance against a compiled same-group Supervisor.
 * Disposable Home. Official DSH CLI from DSH_TEST_BIN (exact version on disk).
 * No model calls. Does not import verify-workbench-product.mjs.
 *
 *   node scripts/verify-workbench-maintenance-product.mjs --syntax
 *   node scripts/verify-workbench-maintenance-product.mjs --http-only [--phase plugins|snapshot|runtime|all]
 *   node scripts/verify-workbench-maintenance-product.mjs [--phase plugins|snapshot|runtime|all]
 *
 * Env: DSH_TEST_BIN (required for real run), DSH_TEST_UPGRADE_VERSION (default: same
 * exact CLI version), DSH_TEST_PLAYWRIGHT / DSH_TEST_PLAYWRIGHT_MODULE (override;
 * default repo node_modules/playwright), DSH_TEST_OUTPUT, DSH_TEST_HOME,
 * DSH_TEST_PNPM_CJS, DSH_TEST_PACKAGE_ROOT.
 *
 * --syntax: static only, no pack/build/web/supervisor/Playwright.
 * --http-only: public HTTP, no Playwright (Primary after UI is covered elsewhere).
 * runPhase publishes the launch session before bootstrap so a rejected
 * launchPhase still force-cleans. Setup failures keep a stage prefix.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
import {
  HOST,
  PORT_MS,
  isolatedEnv,
  refuseRealHome,
  resolveNpmCli,
  resolvePnpmCjs,
  run,
  runDsh,
  stopOwned,
  waitPortClosed,
  writePnpmShim,
  cliVersion,
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THIS_FILE = fileURLToPath(import.meta.url);
const packageRoot = resolve(process.env.DSH_TEST_PACKAGE_ROOT || join(root, 'packages'));
const node = process.execPath;
const HEX64 = /^[a-f0-9]{64}$/;
const EXACT_CLI = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const THEME_PACKAGE = '@eternalnight/dsh-theme';
const THEME_VERSION = '0.5.1';
const SPACE = 'coding';
const SPACE_NAME = '编程';
const WEB_PROFILE = 'web';
const PHASES = ['plugins', 'snapshot', 'runtime'];
const WEB_PROTECTED = ['sessions', 'storages', '.credentials.yaml', '.anonymous-user-id'];
const JOB_MS = 600_000;
const RUNTIME_MS = 900_000;
const SUPERVISOR_MS = 240_000;
const SEED_MS = 180_000;
const JOB_QUERY_MS = 5_000;
const CONTROL_DIR = '.dsh-spaces-control';
const ENDPOINT_FILE = 'endpoint.json';
const OWNER_FILE = join('run', 'owner.json');
const INVALID_RUNTIME = 'latest';
const PAYLOAD_LIB = join(packageRoot, 'plugin', 'lib');
const SUPERVISOR_ENTRY = join(PAYLOAD_LIB, 'supervisor', 'index.js');
const SNAPSHOT_WORKER = join(PAYLOAD_LIB, 'supervisor', 'snapshot-worker.mjs');
const REPO_PLAYWRIGHT = join(root, 'node_modules', 'playwright');

const flags = parseFlags(process.argv.slice(2));
const output = flags.output;
const bin = (process.env.DSH_TEST_BIN || '').trim();
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

function parseFlags(argv) {
  let phase = 'all';
  let httpOnly = false;
  let syntax = false;
  let out = process.env.DSH_TEST_OUTPUT || join(root, '.sandbox', 'workbench-maintenance-product');
  let home = process.env.DSH_TEST_HOME || '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--http-only') {
      httpOnly = true;
      continue;
    }
    if (token === '--syntax') {
      syntax = true;
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
  return { phase, httpOnly, syntax, output: resolve(out), home: home.trim() ? resolve(home.trim()) : '' };
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
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function isExactVersion(version) {
  return typeof version === 'string' && EXACT_CLI.test(version) && version !== 'latest' && version !== 'next';
}

function contextOf(state) {
  if (!HEX64.test(state?.serviceEpoch || '') || !HEX64.test(state?.revision || '')) {
    throw new Error('workbench mutation context requires 64-hex serviceEpoch and revision');
  }
  return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
}

function assertV2State(state, label) {
  if (!state || state.protocolVersion !== 2) {
    throw new Error(`${label}: workbench state is not protocol v2`);
  }
  if (Object.prototype.hasOwnProperty.call(state, 'recoveryRequired')) {
    throw new Error(`${label}: stale recoveryRequired field on v2 state`);
  }
  contextOf(state);
}

async function captureContext(session) {
  const state = await session.api('state');
  assertV2State(state, session.phase);
  return { state, context: contextOf(state) };
}

function namesIfPresent(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return existsSync(path) ? ['<present>'] : null;
  }
}

function webProtectedFingerprint(home) {
  const webRoot = join(home, 'profiles', WEB_PROFILE);
  const out = { webProfile: existsSync(join(webRoot, 'package.json')) };
  for (const name of WEB_PROTECTED) {
    const path = name.startsWith('.') ? join(home, name) : join(webRoot, name);
    out[name] = name.startsWith('.') ? existsSync(path) : namesIfPresent(path);
  }
  return out;
}

function assertWebPathsProtected(home, before, label) {
  const after = webProtectedFingerprint(home);
  assert.equal(after.webProfile, true, `${label}: ordinary web profile is missing`);
  for (const name of WEB_PROTECTED) {
    assert.deepEqual(after[name], before[name], `${label}: protected ${name} changed`);
  }
  return after;
}

function loopbackOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== HOST || url.username || url.password) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1) return null;
    return { origin: `${url.protocol}//${url.hostname}:${port}`, port };
  } catch {
    return null;
  }
}

function readV2Endpoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version === 1) return null;
  if (raw.version !== 2 || raw.protocolVersion !== 2) return null;
  const parsed = typeof raw.origin === 'string' ? loopbackOrigin(raw.origin) : null;
  if (!parsed || typeof raw.bearer !== 'string' || !raw.bearer) return null;
  if (typeof raw.homeId !== 'string' || !HEX64.test(raw.homeId)) return null;
  if (typeof raw.serviceEpoch !== 'string' || !HEX64.test(raw.serviceEpoch)) return null;
  return {
    origin: parsed.origin,
    port: parsed.port,
    bearer: raw.bearer,
    homeId: raw.homeId,
    serviceEpoch: raw.serviceEpoch,
    protocolVersion: 2,
  };
}

function ownerPid(owner) {
  if (!owner || typeof owner !== 'object') return null;
  const pid = Number(owner.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ownerStartedAt(owner) {
  return typeof owner?.startedAt === 'string' ? owner.startedAt : '';
}

function pidLiveness(pid, startedAt) {
  if (!pid) return 'missing';
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'dead';
    return 'ambiguous';
  }
  if (startedAt && !Number.isFinite(Date.parse(startedAt))) return 'ambiguous';
  return 'alive';
}

function readHomeIdentity(home) {
  const control = join(home, CONTROL_DIR);
  let endpoint = null;
  const endpointPath = join(control, ENDPOINT_FILE);
  if (existsSync(endpointPath)) {
    try {
      endpoint = readV2Endpoint(JSON.parse(readFileSync(endpointPath, 'utf8')));
    } catch {
      endpoint = null;
    }
  }
  let owner = null;
  const ownerPath = join(control, OWNER_FILE);
  if (existsSync(ownerPath)) {
    try {
      owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    } catch {
      owner = null;
    }
  }
  return { endpoint, owner };
}

function durableJobPath(home, requestId) {
  return join(home, CONTROL_DIR, 'jobs', `${requestId}.json`);
}

function readDurableJob(home, requestId) {
  const path = durableJobPath(home, requestId);
  if (!existsSync(path)) return null;
  try {
    const row = JSON.parse(readFileSync(path, 'utf8'));
    if (row.requestId !== requestId && row.id !== requestId) return null;
    return row;
  } catch {
    return null;
  }
}

function listStoreVersions(tools) {
  const dir = join(tools, 'versions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => isExactVersion(name)).sort();
}

function readPointer(tools) {
  const path = join(tools, 'current.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
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
    REPO_PLAYWRIGHT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = existsSync(candidate) && (candidate.endsWith('.mjs') || candidate.endsWith('.js'))
      ? resolve(candidate)
      : join(resolve(candidate), 'index.mjs');
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    if (!mod.chromium) throw new Error(`Playwright at ${file} has no chromium export`);
    return mod.chromium;
  }
  throw new Error('Playwright missing; install repo node_modules/playwright or set DSH_TEST_PLAYWRIGHT');
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
      const error = new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
      error.code = body.error?.code;
      throw error;
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
  assert.ok(typeof disk.lockEntry.version === 'string' && disk.lockEntry.version);
  return disk;
}

function assertRemoved(home, spaceId, packageName) {
  const disk = pluginDisk(home, spaceId, packageName);
  assert.equal(disk.declared, undefined, `${packageName} still in package.json`);
  assert.equal(disk.lockEntry, undefined, `${packageName} still in pnpm lock`);
  assert.equal(disk.installed, null, `${packageName} still in node_modules`);
  return disk;
}

function writeEventLoopProbe(phaseDir) {
  const path = join(phaseDir, 'event-loop-probe.cjs');
  writeFileSync(path, `'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');
const hist = monitorEventLoopDelay({ resolution: 20 });
hist.enable();
const THRESHOLD_MS = 100;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const intervalLag = now - last - 1000;
  last = now;
  const maxMs = hist.max / 1e6;
  hist.reset();
  if (maxMs >= THRESHOLD_MS || intervalLag >= THRESHOLD_MS) {
    process.stderr.write('[event-loop-probe] pid=' + process.pid + ' maxMs=' + maxMs.toFixed(1) + ' intervalLagMs=' + Math.max(0, intervalLag).toFixed(1) + String.fromCharCode(10));
  }
}, 1000).unref();
`);
  return path;
}

function supervisorExit(session) {
  const child = session?.supervisor;
  if (!child) return { exitCode: null, signal: 'missing' };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return null;
}

function isTransportError(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
  if (/workbench\//i.test(text)) return false;
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|AbortError|TimeoutError|Timeout \d+ms exceeded/i.test(text);
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
  const context = options.context || (await captureContext(session)).context;
  const transport = [];
  const first = await session.api('submit', { command, requestId, context });
  let latest = first;
  if (options.idempotent) {
    const read = await session.api('job', { id: first.id });
    assert.equal(read.id, first.id, `${label}: job read id drifted`);
    assert.equal(read.requestId, requestId);
    const again = await session.api('submit', { command, requestId, context });
    assert.equal(again.id, first.id, `${label}: same requestId opened a second job`);
    assert.equal(again.requestId, first.requestId);
    const other = { kind: 'space.verify', spaceId: SPACE };
    await assert.rejects(
      () => session.api('submit', { command: other, requestId, context }),
      error => /conflict/i.test(String(error.code || error.message)),
    );
    pass(`${label}: same requestId reread; different command with that id was conflict`);
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const death = supervisorExit(session);
    if (death) {
      throw new Error(`${label}: supervisor exited during job query exitCode=${death.exitCode} signal=${death.signal}`);
    }
    const read = await readJobOnce(session, first.id);
    if (read.ok) {
      latest = read.value;
      if (!['queued', 'running'].includes(latest.status)) break;
      await delay(250);
      continue;
    }
    if (!isTransportError(read.error)) throw read.error;
    transport.push({ at: new Date().toISOString(), summary: redact(read.error instanceof Error ? read.error.message : read.error).slice(0, 240) });
    await delay(250);
  }
  session.observations ??= { jobs: [] };
  session.observations.jobs.push({
    label,
    requestId,
    jobId: latest?.id,
    status: latest?.status,
    phase: latest?.phase,
    transport,
  });
  if (!latest || ['queued', 'running'].includes(latest.status)) {
    throw new Error(`${label}: timed out without a terminal job; last=${latest?.status ?? 'none'} ${latest?.phase ?? ''} transport=${transport.length}`);
  }
  if (latest.status !== 'succeeded') {
    throw new Error(`${label}: ${latest.status}: ${redact(JSON.stringify(latest.error || latest))}`);
  }
  return latest;
}

async function executePlan(session, request, options = {}) {
  const captured = options.context ? { context: options.context } : await captureContext(session);
  const plan = await session.api('preview', { request, context: captured.context });
  const job = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, { ...options, context: captured.context });
  return { plan, job };
}

async function assertViewEntry(session, spaceId) {
  const view = await session.api('view', { spaceId });
  if (!HEX64.test(view.serviceEpoch || '')) throw new Error('view DTO missing serviceEpoch');
  const path = new URL(view.entryPath, view.entryOrigin).pathname;
  const href = `${view.entryOrigin}${path}?epoch=${encodeURIComponent(view.serviceEpoch)}`;
  const entry = await fetch(href, {
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
  assertV2State(state, label);
  await assertStableEntry(session);
  pass(`${label}: browser close left the supervisor and stable entry available`);
}

function withSetupStage(phase, stage, error) {
  const message = redact(error instanceof Error ? error.message : String(error));
  const prefix = `${phase} ${stage}: `;
  if (message.startsWith(prefix)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`${prefix}${message}`);
}

async function launchPhase(phase, home, artifacts, env, onSession) {
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
  }, ['--profile', WEB_PROFILE, '--dump-config'], SEED_MS, `${phase} seed web`, join(phaseDir, 'seed.log'));
  assert.ok(existsSync(SUPERVISOR_ENTRY), `compiled supervisor missing: ${SUPERVISOR_ENTRY}`);
  assert.ok(existsSync(SNAPSHOT_WORKER), `same-group snapshot worker missing: ${SNAPSHOT_WORKER}`);
  const probePath = writeEventLoopProbe(phaseDir);
  const spawnEnv = { ...env };
  delete spawnEnv.NODE_OPTIONS;
  const supervisor = spawn(node, [
    '--require', probePath,
    SUPERVISOR_ENTRY,
    '--home', home,
    '--bin', bin,
    '--node', node,
    '--port', '0',
    '--plugin-artifact', artifacts.plugin.path,
    '--view-bridge-artifact', artifacts.bridge.path,
    '--llm-bridge-artifact', artifacts.llm.path,
    '--control-tool-root', tools,
    '--snapshot-worker', SNAPSHOT_WORKER,
    '--component-payload', PAYLOAD_LIB,
    '--snapshot-root', snapshots,
  ], { cwd: root, env: spawnEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!supervisor.pid) {
    throw new Error(`${phase} failed to spawn supervisor`);
  }
  let launchOutput = '';
  let stderr = '';
  let published = false;
  try {
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
      shutdown: null,
      forceCleaned: false,
    };
    published = true;
    onSession?.(session);
    try {
      let bootstrapUrl;
      try {
        await until(() => {
          if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${redact(stderr)}`);
          return /bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(launchOutput);
        }, `${phase} packaged supervisor initialization`, SUPERVISOR_MS);
        bootstrapUrl = launchOutput.match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1];
        session.origin = new URL(bootstrapUrl).origin;
      } catch (error) {
        throw withSetupStage(phase, 'bootstrap announce', error);
      }
      try {
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
      } catch (error) {
        throw withSetupStage(phase, 'bootstrap token exchange', error);
      }
      try {
        const state = await session.api('state');
        assertV2State(state, phase);
        assert.equal(state.role, 'manager', JSON.stringify(state.reasons));
        assert.equal(state.writable, true);
        assert.ok(state.managerId);
        assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, 'running');
        session.serviceEpoch = state.serviceEpoch;
      } catch (error) {
        throw withSetupStage(phase, 'state', error);
      }
      pass(`${phase}: compiled supervisor started a real dedicated manager (protocol v2)`);
      return session;
    } catch (error) {
      await session.page?.screenshot({ path: join(phaseDir, 'screenshots', 'failure.png') }).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (!published) {
      await stopOwned(supervisor).catch(() => {});
      throw withSetupStage(phase, 'spawn', error);
    }
    throw error;
  }
}

async function verifyServiceShutdown(session) {
  const identity = readHomeIdentity(session.home);
  const beforePid = ownerPid(identity.owner) || session.supervisor?.pid;
  const beforeStarted = ownerStartedAt(identity.owner);
  if (!beforePid) throw new Error('service.shutdown: owner pid missing before shutdown');
  const origin = loopbackOrigin(session.origin);
  if (!origin) throw new Error('service.shutdown: supervisor origin is not loopback');
  const { context } = await captureContext(session);
  const requestId = randomUUID();
  const plan = await session.api('preview', { request: { kind: 'service.shutdown' }, context });
  if (!plan?.id || plan.kind !== 'service.shutdown') {
    throw new Error(`service.shutdown preview rejected: ${redact(JSON.stringify(plan))}`);
  }
  let publicAccepted = false;
  let httpClosedBeforePoll = false;
  try {
    const submitted = await session.api('submit', {
      command: { kind: 'plan.execute', planId: plan.id },
      requestId,
      context,
    });
    publicAccepted = Boolean(submitted?.id);
    if (submitted && submitted.requestId && submitted.requestId !== requestId) {
      throw new Error(`service.shutdown public job id drifted from requestId ${requestId}`);
    }
  } catch (error) {
    if (!isTransportError(error)) throw error;
    httpClosedBeforePoll = true;
    publicAccepted = existsSync(durableJobPath(session.home, requestId));
    if (!publicAccepted) throw error;
  }
  const durable = await until(() => {
    const row = readDurableJob(session.home, requestId);
    if (!row) return false;
    return ['queued', 'running'].includes(row.status) ? false : row;
  }, `durable job ${requestId}`, 120000);
  if (durable.status !== 'succeeded') {
    throw new Error(`service.shutdown durable job ${durable.status}: ${redact(JSON.stringify(durable.error || durable))}`);
  }
  await waitPortClosed(origin.port, PORT_MS);
  await until(
    () => pidLiveness(beforePid, beforeStarted) === 'dead',
    `owner pid ${beforePid} dead after service.shutdown`,
    30000,
  );
  const after = readHomeIdentity(session.home);
  if (after.endpoint) throw new Error('service.shutdown: endpoint.json still valid');
  session.shutdown = {
    publicRequest: { requestId, accepted: publicAccepted, httpClosedBeforePoll },
    durableCompletion: { requestId, status: durable.status, path: durableJobPath(session.home, requestId) },
  };
  pass(`${session.phase}: service.shutdown public request ${requestId}; durable completion succeeded`);
  return session.shutdown;
}

async function forceCleanOwned(session) {
  if (!session) return { forced: false };
  let forced = false;
  await session.browser?.close().catch(() => {});
  const identity = existsSync(session.home) ? readHomeIdentity(session.home) : { endpoint: null, owner: null };
  const pid = ownerPid(identity.owner) || session.supervisor?.pid;
  const started = ownerStartedAt(identity.owner);
  const live = pid ? pidLiveness(pid, started) === 'alive' : false;
  if (live) {
    forced = true;
    await stopOwned(session.supervisor);
  } else if (session.supervisor) {
    await stopOwned(session.supervisor);
  }
  const origin = session.origin ? loopbackOrigin(session.origin) : null;
  if (origin) {
    try {
      await waitPortClosed(origin.port, PORT_MS);
    } catch {
      /* leftover recorded by caller */
    }
  }
  writeFileSync(
    join(session.phaseDir, 'supervisor.log'),
    redact(`${session.launchOutput()}\n${session.stderr()}`),
  );
  return { forced };
}

async function phasePlugins(session) {
  const { home, api, phaseDir } = session;
  const webBefore = webProtectedFingerprint(home);
  await submitJob(session, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, { timeout: JOB_MS, label: 'space.create' });
  const created = JSON.parse(readFileSync(join(home, 'profiles', SPACE, 'package.json'), 'utf8'));
  assert.equal(Boolean(created.dependencies?.['@dsh-spaces/plugin']), false);
  assert.ok(created.dependencies?.['@dsh-spaces/view-bridge']);
  pass('ordinary space created without the full Spaces plugin');
  assertWebPathsProtected(home, webBefore, 'after space.create');

  await submitJob(session, { kind: 'space.start', spaceId: SPACE }, { timeout: JOB_MS, label: 'space.start' });
  await assertViewEntry(session, SPACE);
  pass('ordinary space /view returned 200 Cookie + epoch replace document, not 303');

  const found = await api('plugins', { query: THEME_PACKAGE });
  const plugin = found.find(row => row.packageName === THEME_PACKAGE || row.id === THEME_PACKAGE);
  assert.ok(plugin, `public catalog query did not return ${THEME_PACKAGE}: ${JSON.stringify(found)}`);
  pass(`public catalog query returned ${plugin.packageName} id=${plugin.id}`);

  const catalogId = plugin.id;
  const captured = await captureContext(session);
  let installPlan;
  try {
    installPlan = await api('preview', {
      request: { kind: 'plugin.install', spaceIds: [SPACE], catalogId, version: THEME_VERSION },
      context: captured.context,
    });
  } catch (error) {
    throw new Error(`plugin.install preview rejected catalogId=${catalogId} version=${THEME_VERSION}: ${redact(error instanceof Error ? error.message : error)}`);
  }
  const installJob = await submitJob(
    session,
    { kind: 'plan.execute', planId: installPlan.id },
    { idempotent: true, timeout: JOB_MS, label: 'plugin.install', context: captured.context },
  );
  assert.equal(installJob.status, 'succeeded');
  assertInstalled(home, SPACE, THEME_PACKAGE, THEME_VERSION);
  assert.equal(pluginDisk(home, WEB_PROFILE, THEME_PACKAGE).declared, undefined, 'theme installed onto ordinary web');
  const afterInstall = await api('plugins', { query: THEME_PACKAGE });
  const installedRow = afterInstall.find(row => row.packageName === THEME_PACKAGE);
  assert.ok(installedRow?.installedIn?.includes(SPACE), 'plugins() did not list the theme as installed in the ordinary space');
  assert.equal(Boolean(installedRow?.installedIn?.includes(WEB_PROFILE)), false, 'plugins() listed the theme on web');
  if (session.page) {
    await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'plugin-installed.png') });
  }
  assertWebPathsProtected(home, webBefore, 'after plugin.install');
  pass(`${THEME_PACKAGE}@${THEME_VERSION} installed on ${SPACE} only; web paths unchanged`);

  const removeCaptured = await captureContext(session);
  const removePlan = await api('preview', {
    request: { kind: 'plugin.remove', spaceId: SPACE, packageName: THEME_PACKAGE },
    context: removeCaptured.context,
  });
  await submitJob(session, { kind: 'plan.execute', planId: removePlan.id }, { timeout: JOB_MS, label: 'plugin.remove', context: removeCaptured.context });
  assertRemoved(home, SPACE, THEME_PACKAGE);
  const afterRemove = await api('plugins', { query: THEME_PACKAGE });
  const removedRow = afterRemove.find(row => row.packageName === THEME_PACKAGE);
  assert.equal(Boolean(removedRow?.installedIn?.includes(SPACE)), false, 'plugins() still lists the theme as installed');
  assertWebPathsProtected(home, webBefore, 'after plugin.remove');
  pass(`${THEME_PACKAGE} uninstalled; manifest, lock and node_modules read back empty`);

  const restoreCtx = (await captureContext(session)).context;
  await assert.rejects(
    () => api('preview', { request: { kind: 'config.restore', spaceId: SPACE, backupId: 'bak-1' }, context: restoreCtx }),
    error => /unsupported/i.test(String(error.code || error.message)),
  );
  pass('config.restore is unsupported (not executed)');

  if (flags.httpOnly) uncovered.push('plugins: browser close does not stop supervisor (http-only)');
  else await closeBrowserKeepService(session, 'plugins');
}

async function phaseSnapshot(session) {
  const { api, phaseDir } = session;
  await submitJob(session, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, { timeout: JOB_MS, label: 'space.create' });
  await submitJob(session, { kind: 'space.start', spaceId: SPACE }, { timeout: JOB_MS, label: 'space.start' });
  const epochBefore = (await captureContext(session)).state.serviceEpoch;

  const created = await executePlan(session, { kind: 'snapshot.create' }, {
    idempotent: true,
    timeout: JOB_MS,
    label: 'snapshot.create',
  });
  const snapshotId = created.job.result?.snapshotId;
  assert.equal(typeof snapshotId, 'string');
  const listed = await api('snapshots');
  assert.ok(listed.some(row => row.id === snapshotId));
  const one = await api('snapshot', { id: snapshotId });
  assert.equal(one.id, snapshotId);
  assert.equal(typeof one.runtimeVersion, 'string');
  assert.ok(isExactVersion(one.runtimeVersion), `snapshot runtimeVersion is not exact: ${one.runtimeVersion}`);
  const afterCreate = await captureContext(session);
  assert.equal(afterCreate.state.serviceEpoch, epochBefore, 'snapshot.create must keep the same Supervisor epoch');
  assert.equal(afterCreate.state.spaces.find(space => space.id === afterCreate.state.managerId)?.status, 'running');
  pass(`whole-home snapshot ${snapshotId} created and listed; manager restart only after success; epoch unchanged`);

  await assert.rejects(
    () => api('preview', { request: { kind: 'snapshot.restore', snapshotId }, context: afterCreate.context }),
    error => /unsupported/i.test(String(error.code || error.message)),
  );
  pass('snapshot.restore is unsupported (not executed)');

  await executePlan(session, { kind: 'snapshot.delete', snapshotId }, { timeout: JOB_MS, label: 'snapshot.delete' });
  const afterDelete = await api('snapshots');
  assert.equal(afterDelete.some(row => row.id === snapshotId), false, 'deleted snapshot still listed');
  await assert.rejects(
    () => api('snapshot', { id: snapshotId }),
    error => /not-found|unavailable/i.test(String(error.code || error.message)),
  );
  if (session.page) {
    await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'snapshot-deleted.png') });
  }
  pass(`snapshot ${snapshotId} deleted; list/read no longer return it`);

  if (flags.httpOnly) uncovered.push('snapshot: browser close does not stop supervisor (http-only)');
  else await closeBrowserKeepService(session, 'snapshot');
}

async function phaseRuntime(session) {
  const { api, tools, phaseDir } = session;
  const target = report.upgradeTarget;
  const before = await api('runtimes');
  const current = before.find(row => row.current);
  assert.ok(current, 'runtimes() has no current row');
  assert.ok(isExactVersion(current.version), `current runtime is not exact: ${current.version}`);
  assert.equal(current.compatible, true);
  const epochBefore = (await captureContext(session)).state.serviceEpoch;
  const pointerBefore = readPointer(tools);
  const versionsBefore = listStoreVersions(tools);
  pass(`runtimes() current is exact ${current.version} from disk`);

  const captured = await captureContext(session);
  await assert.rejects(
    () => api('preview', { request: { kind: 'runtime.upgrade', version: INVALID_RUNTIME }, context: captured.context }),
    error => /invalid-input|unsupported/i.test(String(error.code || error.message)),
  );
  assert.deepEqual(listStoreVersions(tools), versionsBefore, 'invalid runtime.upgrade wrote a store tree');
  assert.deepEqual(readPointer(tools), pointerBefore, 'invalid runtime.upgrade changed current.json');
  const afterReject = await captureContext(session);
  assert.equal(afterReject.state.serviceEpoch, epochBefore);
  assert.equal(afterReject.state.spaces.find(space => space.id === afterReject.state.managerId)?.status, 'running');
  pass(`non-exact runtime version ${INVALID_RUNTIME} rejected before writes; manager not restarted`);

  const installed = await executePlan(session, { kind: 'runtime.install', version: target }, {
    idempotent: true,
    timeout: RUNTIME_MS,
    label: 'runtime.install',
  });
  assert.equal(installed.job.result?.runtimeVersion, target);
  const storeBin = join(tools, 'versions', target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  assert.ok(existsSync(storeBin), `runtime.install did not write ${storeBin}`);
  const storePkg = JSON.parse(readFileSync(join(tools, 'versions', target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  assert.equal(storePkg.version, target);
  const afterInstall = (await api('runtimes')).find(row => row.version === target);
  assert.equal(afterInstall?.installed, true);
  const pointerAfterInstall = readPointer(tools);
  if (pointerBefore?.version) {
    assert.equal(pointerAfterInstall?.version, pointerBefore.version, 'runtime.install changed selection');
  }
  const afterInstallState = await captureContext(session);
  assert.equal(afterInstallState.state.serviceEpoch, epochBefore, 'runtime.install must keep the same Supervisor epoch');
  pass(`runtime.install ${target} wrote a real outside-Home store tree; selection unchanged`);

  const upgraded = await executePlan(session, { kind: 'runtime.upgrade', version: target }, {
    timeout: RUNTIME_MS,
    label: 'runtime.upgrade',
  });
  assert.equal(upgraded.job.result?.runtimeVersion, target);
  const pointerPath = join(tools, 'current.json');
  assert.ok(existsSync(pointerPath), 'upgrade did not write runtime current.json');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  assert.equal(pointer.version, target);
  const afterUpgrade = (await api('runtimes')).find(row => row.current);
  assert.equal(afterUpgrade?.version, target);
  assert.equal(afterUpgrade?.compatible, true);
  const state = await api('state');
  assertV2State(state, 'runtime.upgrade');
  assert.equal(state.serviceEpoch, epochBefore, 'runtime.upgrade must keep the same Supervisor epoch');
  assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, 'running', 'manager restart is allowed only after successful upgrade');
  if (session.page) {
    await session.page.screenshot({ path: join(phaseDir, 'screenshots', 'runtime-upgraded.png') });
  }
  pass(`runtime.upgrade selected ${target} in the store tree; Supervisor epoch unchanged; manager running after success`);

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
  let phasePassed = false;
  try {
    session = await launchPhase(phase, home, artifacts, env, owned => {
      session = owned;
    });
    row.origin = session.origin;
    row.probe = session.probePath;
    if (phase === 'plugins') await phasePlugins(session);
    else if (phase === 'snapshot') await phaseSnapshot(session);
    else if (phase === 'runtime') await phaseRuntime(session);
    else throw new Error(`unknown phase ${phase}`);
    row.shutdown = await verifyServiceShutdown(session);
    phasePassed = true;
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
    if (session?.origin) row.origin = session.origin;
    if (session?.probePath) row.probe = session.probePath;
    if (session?.observations) row.observations = session.observations;
    const death = session ? supervisorExit(session) : null;
    if (death) row.supervisorExit = death;
    const cleaned = await forceCleanOwned(session).catch(error => ({
      forced: true,
      error: redact(error instanceof Error ? error.message : error),
    }));
    row.forceCleaned = Boolean(cleaned.forced);
    if (cleaned.error) row.cleanupError = cleaned.error;
    if (phasePassed && row.forceCleaned) {
      row.status = 'fail';
      row.error = 'force-clean killed a still-alive supervisor; service.shutdown is not PASS';
    }
    save();
  }
  if (phasePassed && row.forceCleaned) {
    throw new Error(`${phase}: force-clean killed a still-alive supervisor; service.shutdown is not PASS`);
  }
}

function assertVerifierV2Contract() {
  const staleKind = ['controller', 'shutdown'].join('.');
  const liveKind = ['service', 'shutdown'].join('.');
  const text = readFileSync(THIS_FILE, 'utf8').replace(/function assertVerifierV2Contract[\s\S]*?\n\}\n/, '');
  if (text.includes(`kind: '${staleKind}'`) || text.includes(`kind: "${staleKind}"`)) {
    throw new Error('verifier still previews controller.shutdown');
  }
  if (!text.includes(`kind: '${liveKind}'`) && !text.includes(`kind: "${liveKind}"`)) {
    throw new Error('verifier does not preview service.shutdown');
  }
  if (!text.includes('serviceEpoch') || !text.includes('expectedRevision')) {
    throw new Error('verifier does not send v2 mutation context');
  }
  if (!text.includes('--component-payload')) {
    throw new Error('verifier does not pass --component-payload');
  }
  if (!text.includes('--llm-bridge-artifact')) {
    throw new Error('verifier does not pack/pass the same-group llm-bridge artifact');
  }
  if (!text.includes('snapshot.delete')) {
    throw new Error('verifier does not cover snapshot.delete');
  }
  const adminNeedle = ['Users', 'admin'].join('/');
  if (text.includes(adminNeedle) || text.includes('C:/Users/admin')) {
    throw new Error('verifier hardcodes an operator Playwright/CLI path');
  }
  const staleFlag = ['recoveryRequired', 'false'].join(', ');
  if (text.includes(staleFlag)) {
    throw new Error('verifier still requires stale recoveryRequired');
  }
  if (!text.includes('onSession')) {
    throw new Error('verifier does not publish launch session to runPhase before bootstrap');
  }
  if (!text.includes('bootstrap token exchange')) {
    throw new Error('verifier does not label bootstrap token-exchange setup failures');
  }
}

async function syntaxOnly() {
  const syntax = spawnSync(node, ['--check', THIS_FILE], { encoding: 'utf8', windowsHide: true });
  if (syntax.status !== 0) {
    throw new Error(`node --check failed: ${syntax.stderr || syntax.stdout || syntax.status}`);
  }
  pass('node --check passed');
  assertVerifierV2Contract();
  pass('source uses service.shutdown, v2 context, --component-payload, same-group artifacts');
  const epoch = 'aa'.repeat(32);
  const revision = 'bb'.repeat(32);
  assert.deepEqual(contextOf({ serviceEpoch: epoch, revision }), { serviceEpoch: epoch, expectedRevision: revision });
  assert.equal(readV2Endpoint({ version: 1, origin: `http://${HOST}:9`, bearer: 'tok' }), null);
  const parsed = readV2Endpoint({
    version: 2,
    protocolVersion: 2,
    origin: `http://${HOST}:9`,
    bearer: 'tok',
    homeId: epoch,
    serviceEpoch: revision,
  });
  assert.equal(parsed?.port, 9);
  const probeHome = mkdtempSync(join(output, 'syntax-home-'));
  try {
    refuseRealHome(probeHome);
  } finally {
    /* directory stays under output */
  }
  pass('v2 parsers reject v1 endpoint; disposable Home is required');
  assert.equal(
    withSetupStage('snapshot', 'bootstrap token exchange', new TypeError('fetch failed')).message,
    'snapshot bootstrap token exchange: fetch failed',
  );
  assert.equal(
    withSetupStage('snapshot', 'state', new TypeError('fetch failed')).message,
    'snapshot state: fetch failed',
  );
  pass('setup failures keep bootstrap token exchange vs state prefixes; no raw body');
  report.status = 'syntax';
  report.scope = 'syntax/static only: no pack, build, DSH web, supervisor, or Playwright';
  report.packed = false;
  report.realDsh = false;
}

async function main() {
  mkdirSync(output, { recursive: true });
  report.output = output;
  report.startedAt = new Date().toISOString();
  report.httpOnly = flags.httpOnly;
  if (flags.syntax) {
    await syntaxOnly();
    save();
    console.log('\nMAINTENANCE PRODUCT SYNTAX: PASS');
    return;
  }
  if (flags.httpOnly) {
    uncovered.push('Playwright UI (http-only; Primary covers desktop UI separately after build)');
  }
  if (!bin || !existsSync(bin)) {
    throw new Error('Official DSH CLI missing. Set DSH_TEST_BIN to that package\'s lib/bin.js. This script does not guess a machine-local path.');
  }
  const version = cliVersion(bin);
  if (!isExactVersion(version)) {
    throw new Error(`DSH_TEST_BIN did not report an exact version (${version || 'empty'})`);
  }
  const upgradeTarget = (process.env.DSH_TEST_UPGRADE_VERSION || version).trim();
  if (!isExactVersion(upgradeTarget)) {
    throw new Error(`DSH_TEST_UPGRADE_VERSION is not an exact version (${upgradeTarget})`);
  }
  report.cli = { bin, version };
  report.upgradeTarget = upgradeTarget;
  pass(`using official CLI ${version} from disk; runtime target ${upgradeTarget}`);

  assert.ok(existsSync(SUPERVISOR_ENTRY), `compiled supervisor missing: ${SUPERVISOR_ENTRY} (Primary build:spaces)`);
  assert.ok(existsSync(SNAPSHOT_WORKER), `same-group snapshot worker missing: ${SNAPSHOT_WORKER}`);
  assert.ok(existsSync(join(PAYLOAD_LIB, 'supervisor', 'manifest.json')), 'component payload manifest missing under packages/plugin/lib');

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
  const llm = packArtifact('llm-bridge', packDir, packEnv);
  report.artifacts = {
    plugin: { path: plugin, sha256: hash(plugin) },
    bridge: { path: bridge, sha256: hash(bridge) },
    llm: { path: llm, sha256: hash(llm) },
    payload: PAYLOAD_LIB,
    worker: SNAPSHOT_WORKER,
    supervisor: SUPERVISOR_ENTRY,
  };
  pass('same-group plugin, view-bridge, and llm-bridge packed; supervisor+worker from packages/plugin/lib');

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
  console.log('\nMAINTENANCE PRODUCT ACCEPTANCE: PASS');
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
