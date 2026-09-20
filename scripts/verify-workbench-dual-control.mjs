#!/usr/bin/env node
/**
 * Desktop/Web dual-end run-rights handoff against one isolated Home.
 * Packed supervisor first; Electron second. Real IPC. No model calls.
 * Does not import scripts/verify-spaces-desktop.mjs or verify-workbench-product.mjs
 * (both execute at load). Safe to import this file; main is guarded.
 *
 *   node scripts/verify-workbench-dual-control.mjs [--output DIR] [--home DIR]
 *
 * Env: DSH_TEST_PACKAGED_EXE (preferred distribution exe), DSH_TEST_BIN,
 * DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE, DSH_TEST_OUTPUT,
 * DSH_TEST_HOME, DSH_TEST_PNPM_CJS.
 *
 * Without DSH_TEST_PACKAGED_EXE the current out/main unpackaged Electron is
 * used and the report marks it as not a distribution build.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  portClosed,
  sha256File,
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const COMPATIBLE = '0.1.5-rc.1';
const SPACE = 'coding';
const SPACE_NAME = '编程';
const DESKTOP_NAME = 'Dual Desk';
const WEB_RECOVERED_NAME = 'Web Recovered';
const ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DEFAULT_PLAYWRIGHT =
  'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const JOB_MS = 600_000;
const SUPERVISOR_MS = 240_000;
const SEED_MS = 180_000;
const ELECTRON_MS = 120_000;
const CHROME_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

const proved = [];
const uncovered = [];
const gaps = [];
const report = {
  status: 'running',
  proved,
  uncovered,
  gaps,
  realDsh: true,
  modelCalls: false,
  compatibleCli: COMPATIBLE,
};
let output = process.env.DSH_TEST_OUTPUT
  ? resolve(process.env.DSH_TEST_OUTPUT)
  : join(root, '.sandbox', 'workbench-dual-control');

const pass = text => {
  proved.push(text);
  console.log(`PASS ${redact(text)}`);
};
const save = () => {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
};

function redact(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/\/bootstrap\/[^\s"'<>]+/g, '/bootstrap/[redacted]')
    .replace(/(dsh-auth-[^=\s;]+)=([^;\s"']+)/g, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer [redacted]')
    .replace(/"nonce"\s*:\s*"[^"]+"/g, '"nonce":"[redacted]"')
    .replace(/"pid"\s*:\s*\d+/g, '"pid":"[redacted]"')
    .replace(/host\.bearer/gi, 'host.[redacted]');
}

function errorText(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function parseFlags(argv) {
  let out = output;
  let home = process.env.DSH_TEST_HOME || '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
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
    if (name === '--output') out = take();
    else if (name === '--home') home = take();
    else throw new Error(`unknown flag: ${token}`);
  }
  return { output: resolve(out), home: home.trim() ? resolve(home.trim()) : '' };
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

function packArtifact(name, packDir, env) {
  const npm = resolveNpmCli(node);
  const result = run(node, [npm, 'pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', packDir], {
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

function loadElectronLauncher() {
  const index = playwrightIndex();
  const moduleDir = dirname(index);
  const require = createRequire(import.meta.url);
  let pw;
  try {
    pw = require(moduleDir);
  } catch (error) {
    throw new Error(`Playwright _electron is not loadable from ${moduleDir}: ${redact(errorText(error))}`);
  }
  if (!pw?._electron) {
    throw new Error('Playwright has no _electron export; cannot mockWindowAPI and cannot launch Electron');
  }
  return { electron: pw._electron, require };
}

function resolveElectronLaunch(require) {
  const packaged = process.env.DSH_TEST_PACKAGED_EXE?.trim() || '';
  if (packaged) {
    const exe = resolve(packaged);
    if (!existsSync(exe)) {
      throw new Error(`DSH_TEST_PACKAGED_EXE missing: ${exe}`);
    }
    const asar = join(dirname(exe), 'resources', 'app.asar');
    if (!existsSync(asar)) {
      throw new Error(
        `${exe} has no sibling resources/app.asar; pass the unpacked/installed app exe, not the NSIS Setup installer`,
      );
    }
    return { mode: 'packaged-exe', exe, packaged: true, distribution: true };
  }
  const mainJs = join(root, 'out', 'main', 'index.js');
  if (!existsSync(mainJs)) {
    throw new Error(
      'out/main/index.js missing and DSH_TEST_PACKAGED_EXE unset; this is not a distribution run and unpackaged Electron is not built',
    );
  }
  let exe;
  try {
    exe = require('electron');
  } catch (error) {
    throw new Error(`electron package not resolvable for unpackaged launch: ${redact(errorText(error))}`);
  }
  if (!exe || !existsSync(String(exe))) {
    throw new Error(`electron binary missing for unpackaged out/main launch: ${exe}`);
  }
  return { mode: 'unpackaged-out-main', exe: String(exe), packaged: false, distribution: false };
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
    if (!body || typeof body !== 'object') throw new Error(`${method}: empty response`);
    if (!body.ok) {
      throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
    }
    return body.value;
  };
}

function controlDir(home) {
  return join(home, '.dsh-spaces-control');
}

function readLease(home) {
  const ownerFile = join(controlDir(home), 'run', 'owner.json');
  if (!existsSync(ownerFile)) return { held: false, kind: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ownerFile, 'utf8'));
  } catch {
    return { held: true, kind: 'unreadable' };
  }
  const kind = parsed?.kind === 'web' || parsed?.kind === 'desktop' ? parsed.kind : 'unknown';
  return { held: true, kind };
}

function readToolchainRecord(home) {
  const path = join(controlDir(home), 'toolchain.json');
  if (!existsSync(path)) throw new Error('Home private toolchain.json is missing');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.version !== 1) throw new Error(`toolchain.json version ${record.version} is not 1`);
  return record;
}

function resourceRoots(record) {
  return {
    runtimeRoot: record.runtimeRoot ? resolve(record.runtimeRoot) : null,
    snapshotRoot: record.snapshotRoot ? resolve(record.snapshotRoot) : null,
    toolchainRoot: record.toolchainRoot ? resolve(record.toolchainRoot) : null,
    dshVersion: record.dshVersion || null,
  };
}

function homeFingerprint(home) {
  const files = [
    'hub/settings.json',
    'hub/spaces.json',
    '.dsh-spaces-control/manager.json',
    '.dsh-spaces-control/toolchain.json',
  ];
  const profiles = join(home, 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      files.push(`profiles/${name}/package.json`);
    }
  }
  const map = {};
  for (const rel of files) {
    const path = join(home, rel);
    map[rel] = existsSync(path) ? sha256File(path) : null;
  }
  return map;
}

function spaceMeta(home, spaceId) {
  const path = join(home, 'hub', 'spaces.json');
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  return file.meta?.[spaceId] || {};
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
}

function assertSingleOwner(webState, desktopState, lease, label) {
  const webWrite = Boolean(webState?.writable);
  const deskWrite = Boolean(desktopState?.writable);
  assert.equal(webWrite && deskWrite, false, `${label}: web and desktop both writable`);
  if (webWrite) {
    assert.equal(lease.held, true, `${label}: web writable but lease missing`);
    assert.equal(lease.kind, 'web', `${label}: web writable but lease kind=${lease.kind}`);
    assert.equal(webState.owner?.kind, 'web', `${label}: web state owner is not web`);
    if (desktopState) {
      assert.equal(desktopState.writable, false, `${label}: desktop writable while web holds`);
      assert.equal(desktopState.held, false, `${label}: desktop held while web holds`);
      assert.equal(desktopState.ownerKind, 'web', `${label}: desktop ownerKind=${desktopState.ownerKind}`);
    }
  }
  if (deskWrite) {
    assert.equal(lease.held, true, `${label}: desktop writable but lease missing`);
    assert.equal(lease.kind, 'desktop', `${label}: desktop writable but lease kind=${lease.kind}`);
    if (webState) {
      assert.equal(webState.writable, false, `${label}: web writable while desktop holds`);
      assert.equal(webState.owner?.kind, 'desktop', `${label}: web owner=${webState.owner?.kind}`);
    }
    if (desktopState) {
      assert.equal(desktopState.held, true, `${label}: desktop writable but held=false`);
      assert.equal(desktopState.ownerKind, 'desktop', `${label}: desktop ownerKind=${desktopState.ownerKind}`);
    }
  }
}

async function expectFail(action, pattern, label) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error(`${label} succeeded; expected refusal matching ${pattern}`);
  const text = redact(errorText(caught));
  if (!pattern.test(text)) {
    throw new Error(`${label} refused with unexpected error: ${text}`);
  }
  return text;
}

async function desktopInvoke(page, name, args = []) {
  return page.evaluate(async payload => {
    const api = window.dshSpaces;
    if (!api) throw new Error('window.dshSpaces missing; cannot mockWindowAPI');
    if (typeof api[payload.name] !== 'function') {
      throw new Error(`window.dshSpaces.${payload.name} missing; cannot mockWindowAPI`);
    }
    return api[payload.name](...payload.args);
  }, { name, args });
}

async function desktopApiShape(page) {
  return page.evaluate(() => {
    const api = window.dshSpaces;
    if (!api) return { missing: true };
    const names = [
      'getControllerState',
      'acquireController',
      'releaseController',
      'previewControllerRelease',
      'listProfiles',
      'startProfile',
      'updateMeta',
      'createProfile',
      'saveSettings',
      'getSettings',
      'getDshHome',
    ];
    const shape = {};
    for (const name of names) shape[name] = typeof api[name];
    return shape;
  });
}

function assertNoManager(profiles, managerId, label) {
  const names = profiles.map(row => row.name);
  assert.ok(!names.includes(managerId), `${label}: listProfiles includes manager id ${managerId}`);
  assert.ok(
    !names.some(name => /^spaces-hub(?:-\d+)?$/i.test(name)),
    `${label}: listProfiles includes a spaces-hub manager name: ${names.join(',')}`,
  );
}

async function submitJob(api, command, options = {}) {
  const requestId = options.requestId || randomUUID();
  const timeout = options.timeout ?? JOB_MS;
  const label = options.label || command.kind;
  const first = await api('submit', { command, requestId });
  let latest = first;
  await until(async () => {
    latest = await api('job', { id: first.id });
    return !['queued', 'running'].includes(latest.status);
  }, label, timeout);
  assert.equal(latest.status, 'succeeded', `${label}: ${redact(JSON.stringify(latest.error || latest))}`);
  return latest;
}

async function waitReleaseProven(api, home, jobId) {
  let job;
  let jobLost = false;
  let jobError = '';
  const result = await until(async () => {
    if (jobId && !jobLost) {
      try {
        job = await api('job', { id: jobId });
      } catch (error) {
        const text = errorText(error);
        if (/read-only|unavailable/i.test(text)) {
          jobLost = true;
          jobError = redact(text);
        } else {
          throw error;
        }
      }
    }
    const state = await api('state');
    const lease = readLease(home);
    const jobDone = jobLost || (job && !['queued', 'running'].includes(job.status));
    const controlReleased = lease.held === false && state.writable === false && !state.owner;
    if (jobDone && controlReleased) {
      return { state, lease, job, jobLost, jobError };
    }
    if (job && job.status === 'failed') {
      throw new Error(`controller.release job failed: ${redact(JSON.stringify(job.error || job))}`);
    }
    return false;
  }, 'controller.release proven by job-or-lost plus state/lease', JOB_MS);
  if (!result.jobLost) {
    assert.equal(result.job.status, 'succeeded', `controller.release job ${result.job.status}`);
  }
  return result;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  output = flags.output;
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'screenshots'), { recursive: true });
  report.startedAt = new Date().toISOString();
  save();

  const bin = process.env.DSH_TEST_BIN || DEFAULT_BIN;
  if (!existsSync(bin)) throw new Error(`DSH CLI missing at ${bin}; set DSH_TEST_BIN`);
  const version = cliVersion(bin);
  if (version !== COMPATIBLE) {
    throw new Error(
      `CLI ${version} is not the required baseline ${COMPATIBLE}; dual-control will not relax the rc.1 gate or rewrite versions`,
    );
  }
  pass(`DSH CLI is exact ${COMPATIBLE}`);

  const home = flags.home || mkdtempSync(join(output, 'home-'));
  const userData = mkdtempSync(join(output, 'userdata-'));
  refuseRealHome(home);
  refuseRealHome(userData);
  report.home = home;
  report.userData = userData;

  const tools = join(output, 'tools');
  const snapshots = join(output, 'snapshots');
  mkdirSync(tools, { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(output, key)]));
  Object.values(tooling).forEach(path => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, node, resolvePnpmCjs());
  const env = stripSecrets(isolatedEnv(home, node, tooling));

  const packDir = join(output, 'packed');
  mkdirSync(packDir, { recursive: true });
  const plugin = packArtifact('plugin', packDir, env);
  const bridge = packArtifact('view-bridge', packDir, env);
  report.artifacts = {
    plugin: { path: plugin, sha256: sha256File(plugin) },
    bridge: { path: bridge, sha256: sha256File(bridge) },
  };

  runDsh(node, bin, home, tooling, ['--profile', 'web', '--dump-config'], SEED_MS, 'seed base web', join(output, 'seed.log'));
  pass('fresh official web profile seeded without copying user data or configuring a model key');

  const supervisorBin = join(root, 'packages/supervisor/lib/index.js');
  if (!existsSync(supervisorBin)) {
    throw new Error('packages/supervisor/lib/index.js missing; packed supervisor is required');
  }
  const supervisor = spawn(node, [
    supervisorBin,
    '--home', home, '--bin', bin, '--node', node, '--port', '0',
    '--plugin-artifact', plugin,
    '--view-bridge-artifact', bridge,
    '--snapshot-worker', join(root, 'packages/supervisor/lib/snapshot-worker.mjs'),
    '--control-tool-root', tools,
    '--snapshot-root', snapshots,
  ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchOutput = '';
  let stderr = '';
  supervisor.stdout.on('data', chunk => { launchOutput = (launchOutput + chunk.toString()).slice(-32768); });
  supervisor.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });

  let browser;
  let context;
  let page;
  let api;
  let origin = '';
  let cookie = '';
  let electronApp;
  let electronPage;
  let managerId = '';
  let managerDisplay = '';
  let desktopPort;

  const writeSupervisorLog = () => {
    writeFileSync(join(output, 'supervisor.log'), redact(`${launchOutput}\n${stderr}`));
  };

  try {
    await until(() => {
      if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${redact(stderr)}`);
      return /bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(launchOutput);
    }, 'packaged supervisor initialization', SUPERVISOR_MS);
    const bootstrapUrl = launchOutput.match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1];
    origin = new URL(bootstrapUrl).origin;
    report.origin = origin;

    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', error => console.log(`BROWSER ${redact(error.message)}`));
    await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await until(() => page.url() === `${origin}/`, 'clean stable entry URL');
    const cookies = await context.cookies();
    cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
    assert.ok(cookie, 'Playwright session cookie missing after bootstrap');
    api = makeApi(origin, cookie, context);

    let state = await api('state');
    assertPublicDto(state, 'initial web state');
    assert.equal(state.role, 'manager', JSON.stringify(state.reasons));
    assert.equal(state.writable, true);
    assert.ok(state.managerId);
    managerId = state.managerId;
    managerDisplay = state.spaces.find(space => space.id === managerId)?.displayName || managerId;
    assert.equal(state.spaces.find(space => space.id === managerId)?.status, 'running');
    assert.equal(state.owner?.kind, 'web');
    assertSingleOwner(state, null, readLease(home), 'after supervisor start');
    pass('packed supervisor started a real dedicated manager and holds web run rights');

    const toolchain = readToolchainRecord(home);
    const roots = resourceRoots(toolchain);
    assert.equal(toolchain.dshVersion, COMPATIBLE);
    assert.equal(roots.runtimeRoot, resolve(tools));
    assert.equal(roots.snapshotRoot, resolve(snapshots));
    assert.equal(roots.toolchainRoot, resolve(tools));
    assert.ok(existsSync(toolchain.bin), 'toolchain.json bin missing');
    assert.ok(existsSync(toolchain.nodeExe), 'toolchain.json nodeExe missing');
    report.resourceRoots = roots;
    pass('Home private toolchain.json points at the prepared runtime/snapshot/toolchain roots');

    await submitJob(api, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, { label: 'space.create' });
    const created = JSON.parse(readFileSync(join(home, 'profiles', SPACE, 'package.json'), 'utf8'));
    assert.equal(Boolean(created.dependencies?.['@dsh-spaces/plugin']), false);
    assert.ok(created.dependencies?.['@dsh-spaces/view-bridge']);
    await submitJob(api, { kind: 'space.start', spaceId: SPACE }, { label: 'space.start' });
    state = await api('state');
    assert.equal(state.spaces.find(space => space.id === SPACE)?.status, 'running');
    pass('ordinary test space started from the web owner without the full Spaces plugin');

    await page.screenshot({ path: join(output, 'screenshots', 'web-owner-running.png') });
    await browser.close();
    browser = undefined;
    context = undefined;
    page = undefined;
    api = makeApi(origin, cookie);
    await delay(2000);
    assert.equal(supervisor.exitCode, null, 'closing the browser stopped the supervisor');
    const afterClose = await api('state');
    assert.equal(afterClose.writable, true);
    assert.equal(afterClose.spaces.find(space => space.id === managerId)?.status, 'running');
    assert.equal(afterClose.spaces.find(space => space.id === SPACE)?.status, 'running');
    const entry = await fetch(`${origin}/`, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
    assert.equal(entry.status, 200);
    pass('closing the browser did not stop the supervisor, manager, ordinary space, or stable entry');

    const beforeHash = homeFingerprint(home);
    const beforeLease = readLease(home);
    assert.equal(beforeLease.kind, 'web');

    const { electron, require } = loadElectronLauncher();
    const launch = resolveElectronLaunch(require);
    report.electronMode = launch.mode;
    report.packaged = launch.packaged;
    report.distribution = launch.distribution;
    if (!launch.distribution) {
      console.log('INFO Electron launch is unpackaged out/main; this is not a distribution exe proof');
      uncovered.push('packaged distribution exe (DSH_TEST_PACKAGED_EXE unset; used current out/main)');
    } else {
      pass(`Electron launch uses distribution exe ${launch.exe}`);
    }

    const electronEnv = stripSecrets({
      ...process.env,
      DSH_SPACES_HOME: home,
      DSH_SPACES_USER_DATA: userData,
      DSH_SPACES_DISABLE_UPDATES: '1',
      DISABLE_UPDATES: '1',
      DSH_HOME: home,
    });
    delete electronEnv.DSH_SPACES_TOOLCHAIN;
    delete electronEnv.ELECTRON_RUN_AS_NODE;

    electronApp = await electron.launch(
      launch.packaged
        ? {
            executablePath: launch.exe,
            args: CHROME_ARGS,
            cwd: dirname(launch.exe),
            env: electronEnv,
            timeout: ELECTRON_MS,
          }
        : {
            executablePath: launch.exe,
            args: [root, ...CHROME_ARGS],
            cwd: root,
            env: electronEnv,
            timeout: ELECTRON_MS,
          },
    );
    electronPage = await electronApp.firstWindow();
    electronPage.setDefaultTimeout(20000);
    await electronPage.bringToFront();

    const packagedFlag = await electronApp.evaluate(({ app: electronAppHandle }) => electronAppHandle.isPackaged);
    assert.equal(packagedFlag, launch.packaged, `app.isPackaged=${packagedFlag} expected ${launch.packaged}`);

    await until(async () => {
      const shape = await desktopApiShape(electronPage);
      return shape && shape.missing !== true && shape.getControllerState === 'function';
    }, 'window.dshSpaces.getControllerState', 60000);
    const shape = await desktopApiShape(electronPage);
    if (shape.missing) {
      throw new Error('window.dshSpaces missing after Electron launch; cannot mockWindowAPI');
    }
    const missing = Object.entries(shape)
      .filter(([, type]) => type !== 'function')
      .map(([name]) => name);
    if (missing.length) {
      const detail = `window.dshSpaces missing ${missing.join(', ')}; cannot mockWindowAPI. Production preload/IPC gap.`;
      gaps.push(detail);
      throw new Error(detail);
    }

    const resolvedHome = await desktopInvoke(electronPage, 'getDshHome');
    assert.equal(resolve(resolvedHome), resolve(home));
    refuseRealHome(resolvedHome);
    pass('Electron opened the same isolated Home as the web supervisor');

    const desktopState = await until(async () => {
      const next = await desktopInvoke(electronPage, 'getControllerState');
      assertPublicDto(next, 'desktop controller state while web owns');
      if (next.writable) return false;
      if (next.ownerKind === 'web' && next.held === false) return next;
      return false;
    }, 'desktop read-only while web owns', 30000);
    assert.equal(desktopState.writable, false);
    assert.equal(desktopState.held, false);
    assert.equal(desktopState.ownerKind, 'web');
    assertSingleOwner(await api('state'), desktopState, readLease(home), 'electron attached while web owns');
    pass('desktop IPC getControllerState is read-only with ownerKind=web');

    const takeoverButtons = await electronPage
      .getByRole('button', { name: /接管|Take over|移交|Hand off/ })
      .count();
    if (takeoverButtons) {
      throw new Error(
        `desktop still shows ${takeoverButtons} takeover/hand-off button(s) while web owns this Home`,
      );
    }
    await electronPage.screenshot({ path: join(output, 'screenshots', 'desktop-readonly.png') });
    pass(
      'desktop has no takeover/hand-off buttons while web owns; screenshot records current appearance only (removed badge copy is not asserted)',
    );

    const profilesReadonly = await desktopInvoke(electronPage, 'listProfiles');
    assertNoManager(profilesReadonly, managerId, 'read-only listProfiles');
    const railLabels = await electronPage.locator('aside button[aria-label]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('aria-label') || ''),
    );
    if (managerDisplay && managerDisplay !== SPACE && managerDisplay !== SPACE_NAME) {
      assert.ok(!railLabels.includes(managerDisplay), `desktop rail includes manager ${managerDisplay}`);
    }
    pass('manager is absent from desktop listProfiles and the ordinary rail');

    await expectFail(
      () => desktopInvoke(electronPage, 'startProfile', [SPACE]),
      /read-only|web workbench holds/i,
      'startProfile while web owns',
    );
    await expectFail(
      () => desktopInvoke(electronPage, 'updateMeta', [SPACE, { displayName: 'should-not-write' }]),
      /read-only|web workbench holds/i,
      'updateMeta while web owns',
    );
    await expectFail(
      () => desktopInvoke(electronPage, 'createProfile', ['notes', '笔记']),
      /read-only|web workbench holds/i,
      'createProfile while web owns',
    );
    const settings = await desktopInvoke(electronPage, 'getSettings');
    await expectFail(
      () => desktopInvoke(electronPage, 'saveSettings', [{ ...settings, locale: settings.locale === 'zh' ? 'en' : 'zh' }]),
      /read-only|web workbench holds/i,
      'saveSettings while web owns',
    );
    pass('desktop write IPC start/updateMeta/createProfile/saveSettings refused while web owns');

    const afterDenied = homeFingerprint(home);
    assert.deepEqual(afterDenied, beforeHash, 'Home config/data hash changed after refused desktop writes');
    assert.deepEqual(readLease(home), beforeLease, 'lease kind changed after refused desktop writes');
    const stillRoots = resourceRoots(readToolchainRecord(home));
    assert.deepEqual(stillRoots, roots, 'resource roots changed during read-only attach');
    pass('Home config/data hashes and resource roots were unchanged after refused writes; test toolchain mkdir is not that proof');

    const plan = await api('preview', { request: { kind: 'controller.release' } });
    const submitted = await api('submit', {
      command: { kind: 'plan.execute', planId: plan.id },
      requestId: randomUUID(),
    });
    const released = await waitReleaseProven(api, home, submitted.id);
    assertPublicDto(released.state, 'web state after controller.release');
    assert.equal(released.lease.held, false);
    assert.equal(released.state.writable, false);
    assert.equal(released.state.owner, null);
    if (released.jobLost) {
      pass(`web controller.release job API disconnected after dropWritable (${released.jobError}); state/lease proved the handoff`);
    } else {
      pass('web controller.release job succeeded and state/lease show no owner');
    }

    const desktopFree = await until(async () => {
      const next = await desktopInvoke(electronPage, 'getControllerState');
      return next.ownerKind === null && next.held === false && next.writable === false ? next : false;
    }, 'desktop sees free Home after web release', 30000);
    assertPublicDto(desktopFree, 'desktop state after web release');
    await electronPage.screenshot({ path: join(output, 'screenshots', 'desktop-free.png') });

    const acquired = await desktopInvoke(electronPage, 'acquireController');
    assertPublicDto(acquired, 'desktop acquireController');
    const admitted = await until(async () => {
      const next = await desktopInvoke(electronPage, 'getControllerState');
      if (next.held && next.ownerKind === 'desktop' && !next.writable) {
        throw new Error(
          `desktop acquired the lease but writes were not admitted: ${next.reasons.join('; ') || 'no reasons'}. ` +
            'This is a production admission/residue gap, not skipped.',
        );
      }
      return next.writable && next.held && next.ownerKind === 'desktop' ? next : false;
    }, 'desktop admitted after explicit acquire', 60000);
    assertPublicDto(admitted, 'desktop admitted state');
    const webAfterDesktop = await api('state');
    assertPublicDto(webAfterDesktop, 'web state while desktop owns');
    assertSingleOwner(webAfterDesktop, admitted, readLease(home), 'after desktop acquire');
    const afterAcquireRoots = resourceRoots(readToolchainRecord(home));
    assert.equal(afterAcquireRoots.runtimeRoot, roots.runtimeRoot);
    assert.equal(afterAcquireRoots.snapshotRoot, roots.snapshotRoot);
    assert.equal(afterAcquireRoots.toolchainRoot, roots.toolchainRoot);
    pass('desktop explicit acquire took the lease; resource roots still match Home toolchain.json');

    await expectFail(
      () => api('submit', { command: { kind: 'space.update', spaceId: SPACE, displayName: 'web-should-not-write' }, requestId: randomUUID() }),
      /read-only|busy/i,
      'web space.update while desktop owns',
    );
    await expectFail(
      () => api('submit', { command: { kind: 'controller.acquire' }, requestId: randomUUID() }),
      /busy/i,
      'web controller.acquire while desktop owns',
    );
    pass('web ordinary write and acquire refused while desktop owns; one Home one owner');

    const started = await desktopInvoke(electronPage, 'startProfile', [SPACE]);
    desktopPort = started?.port;
    const running = await until(async () => {
      const row = (await desktopInvoke(electronPage, 'listProfiles')).find(item => item.name === SPACE);
      if (row?.status === 'crashed') throw new Error(row.lastError || 'coding crashed');
      return row?.status === 'running' && Number.isInteger(row.port) ? row : false;
    }, 'desktop startProfile coding', 90000);
    desktopPort = running.port;
    const meta = await desktopInvoke(electronPage, 'updateMeta', [SPACE, { displayName: DESKTOP_NAME, icon: ICON }]);
    assert.equal(meta.displayName, DESKTOP_NAME);
    const readback = (await desktopInvoke(electronPage, 'listProfiles')).find(item => item.name === SPACE);
    assert.equal(readback.meta.displayName, DESKTOP_NAME);
    assert.equal(readback.meta.icon, ICON);
    const diskMeta = spaceMeta(home, SPACE);
    assert.equal(diskMeta.displayName, DESKTOP_NAME);
    assert.equal(diskMeta.icon, ICON);
    const afterWriteProfiles = await desktopInvoke(electronPage, 'listProfiles');
    assertNoManager(afterWriteProfiles, managerId, 'writable listProfiles');
    await until(async () => {
      const labels = await electronPage.locator('aside button[aria-label]').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('aria-label') || ''),
      );
      if (managerDisplay && managerDisplay !== SPACE && managerDisplay !== SPACE_NAME && managerDisplay !== DESKTOP_NAME) {
        assert.ok(!labels.includes(managerDisplay), 'writable rail includes manager');
      }
      return labels.includes(DESKTOP_NAME);
    }, 'desktop rail shows updated display name', 15000);
    await electronPage.screenshot({ path: join(output, 'screenshots', 'desktop-owner-write.png') });
    pass('desktop started the ordinary space and read back display name plus icon; manager still off the rail');

    const preview = await desktopInvoke(electronPage, 'previewControllerRelease');
    assert.ok(Array.isArray(preview));
    assert.ok(preview.some(row => row.name === SPACE), 'release preview omitted the desktop-owned ordinary space');
    const afterRelease = await desktopInvoke(electronPage, 'releaseController');
    assertPublicDto(afterRelease, 'desktop releaseController');
    await until(async () => {
      const next = await desktopInvoke(electronPage, 'getControllerState');
      return next.held === false && next.writable === false ? next : false;
    }, 'desktop released the lease', 60000);
    const stopped = await until(async () => {
      const row = (await desktopInvoke(electronPage, 'listProfiles')).find(item => item.name === SPACE);
      return row?.status === 'stopped' ? row : false;
    }, 'desktop release stopped its own ordinary space', 30000);
    assert.equal(stopped.status, 'stopped');
    if (Number.isInteger(desktopPort)) {
      await until(() => portClosed(desktopPort), `desktop-owned port ${desktopPort} closed`, 15000);
    }
    assert.equal(readLease(home).held, false);
    pass('desktop explicit release stopped its own instance and dropped the lease');

    const webAcquired = await api('submit', { command: { kind: 'controller.acquire' }, requestId: randomUUID() });
    assert.equal(webAcquired.status, 'succeeded', redact(JSON.stringify(webAcquired)));
    const webRestored = await until(async () => {
      const next = await api('state');
      return next.writable && next.owner?.kind === 'web' ? next : false;
    }, 'web acquire restored control', 120000);
    assertPublicDto(webRestored, 'web state after re-acquire');
    assertSingleOwner(webRestored, await desktopInvoke(electronPage, 'getControllerState'), readLease(home), 'after web re-acquire');
    await submitJob(api, { kind: 'space.update', spaceId: SPACE, displayName: WEB_RECOVERED_NAME }, { label: 'space.update after web acquire' });
    const restoredState = await api('state');
    assert.equal(restoredState.spaces.find(space => space.id === SPACE)?.displayName, WEB_RECOVERED_NAME);
    assert.equal(spaceMeta(home, SPACE).displayName, WEB_RECOVERED_NAME);
    const restoredRoots = resourceRoots(readToolchainRecord(home));
    assert.equal(restoredRoots.runtimeRoot, roots.runtimeRoot);
    assert.equal(restoredRoots.snapshotRoot, roots.snapshotRoot);
    assert.equal(restoredRoots.toolchainRoot, roots.toolchainRoot);
    pass('web explicit acquire restored control, updated the ordinary space, and read the same resource roots back');

    report.status = 'pass';
    report.managerId = managerId;
    report.scope = 'Desktop/Web dual-end run-rights handoff on one isolated Home';
  } catch (error) {
    report.status = 'fail';
    report.error = redact(errorText(error));
    await electronPage?.screenshot({ path: join(output, 'screenshots', 'failure-desktop.png') }).catch(() => {});
    await page?.screenshot({ path: join(output, 'screenshots', 'failure-web.png') }).catch(() => {});
    throw error;
  } finally {
    try {
      if (electronPage) await desktopInvoke(electronPage, 'quitApp').catch(() => {});
    } catch {
      /* owned electron cleanup below */
    }
    await electronApp?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (api) {
      try {
        const current = await api('state').catch(() => null);
        if (current?.writable) {
          const plan = await api('preview', { request: { kind: 'controller.shutdown' } });
          await api('submit', { command: { kind: 'plan.execute', planId: plan.id }, requestId: randomUUID() });
          await until(() => supervisor.exitCode !== null, 'supervisor clean shutdown', 15000);
        }
      } catch {
        /* Owned test process tree cleanup below. Never other Home processes. */
      }
    }
    if (supervisor.exitCode === null) await stopOwned(supervisor);
    writeSupervisorLog();
    report.finishedAt = new Date().toISOString();
    save();
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(error => {
    report.status = 'fail';
    report.error ||= redact(errorText(error));
    mkdirSync(output, { recursive: true });
    save();
    console.error(`FAIL ${redact(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}
