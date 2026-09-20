#!/usr/bin/env node
/**
 * Isolated 0.1.5-rc.2 compatibility evidence. Fresh Home, empty config, no
 * model calls, no production ~/.dsh. Does not import verify-workbench-product.mjs
 * (that file runs at load). Safe to import this module; main is guarded.
 *
 * Confirms live `dsh --version` is exactly 0.1.5-rc.2. Does not rewrite
 * manifests or pretend the product write-gate is rc.2. If the packed
 * supervisor refuses the manager, that is recorded as a blocker and the
 * script continues with CLI / view-bridge / guide-only plugin wiring.
 *
 * HTTP fetch + typed RPC is not a Chromium/DOM acceptance. Chromium loads an
 * independent experiment parent (not the official workbench) with two ordinary
 * DSH iframes and checks the view-bridge handshake origin/channel/generation.
 *
 * Unregistered plugin-host is guide-only: workbenchGuide/role is required;
 * spaces/workbench write remotes must stay unregistered. That is the new
 * role contract, not a relaxation of management rights.
 *
 *   node scripts/verify-workbench-rc2.mjs [--output DIR] [--home DIR]
 *
 * Env: DSH_TEST_BIN or DSH_TEST_RC2_BIN (must be real 0.1.5-rc.2),
 * DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE, DSH_TEST_OUTPUT,
 * DSH_TEST_HOME, DSH_TEST_PNPM_CJS.
 *
 * Exit: 0 product admitted rc.2; 2 low-level wiring proved, product gate
 * still rc.1 / full product unvalidated; 1 failed. Cleanup kills only this
 * process's spawned PIDs.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BOOT_MS,
  HOST,
  PLUGIN_MS,
  RPC_MS,
  assertRpcOk,
  captureLaunchUrl,
  cliVersion,
  ephemeralPort,
  importCore,
  isolatedEnv,
  refuseRealHome,
  resolveNpmCli,
  resolvePnpmCjs,
  rpc,
  rpcAvailable,
  run,
  runDsh,
  runDshRetry,
  sessionCookie,
  sha256File,
  stopOwned,
  writePnpmShim,
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const PRODUCT_GATE = '0.1.5-rc.1';
const RC2 = '0.1.5-rc.2';
const DEFAULT_RC2_BIN = join(
  root,
  '.sandbox',
  'spaces-unknown-cli',
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib',
  'bin.js',
);
const PLUGIN_NAME = '@dsh-spaces/plugin';
const BRIDGE_NAME = '@dsh-spaces/view-bridge';
const PLUGIN_ROW = 'dsh-spaces';
const BRIDGE_ROW = 'dsh-spaces-view-bridge';
const WEB = 'web';
const SPACE_A = 'coding';
const SPACE_B = 'notes';
const PLUGIN_HOST = 'plugin-host';
const SEED_MS = 180_000;
const VERSION_MS = 20_000;
const SUPERVISOR_MS = 120_000;
const PACK_MS = 60_000;
const HANDSHAKE_MS = 90_000;
const SHELL_UNSAFE = /[\s"'&|<>^()%!]/;
const DEFAULT_PLAYWRIGHT =
  'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const PRIOR_ROOT_FAIL = {
  log: join(root, '.sandbox', 'workbench-rc2-root.log'),
  results: join(root, '.sandbox', 'workbench-rc2', 'results.json'),
  error: 'plugin-host spaces/overview RPC rejected: gateway/service-unavailable (spaces service unregistered)',
};

const proved = [];
const gaps = [];
const owned = [];
const closers = [];
const report = {
  status: 'running',
  productSupported: false,
  productGate: { refused: false, admitted: false, reasons: [] },
  proved,
  gaps,
  realDsh: true,
  packed: true,
  modelCalls: false,
  copiedProductionHome: false,
  liveVersionRequired: RC2,
  productWriteGate: PRODUCT_GATE,
};
let output = process.env.DSH_TEST_OUTPUT
  ? resolve(process.env.DSH_TEST_OUTPUT)
  : join(root, '.sandbox', 'workbench-rc2-retry');

const pass = text => {
  proved.push(text);
  console.log(`PASS ${redact(text)}`);
};
const info = text => console.log(`INFO ${redact(text)}`);
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
    .replace(/"nonce"\s*:\s*"[^"]+"/g, '"nonce":"[redacted]"');
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

function parseVersionText(text) {
  return String(text).match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1];
}

function requireShellSafe(path, label) {
  if (SHELL_UNSAFE.test(path)) {
    throw new Error(`${label} needs a shell-safe path (no spaces/metacharacters): ${path}`);
  }
  return path;
}

function dumpHasExactId(dump, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-\\s*id:\\s*['"]?${escaped}['"]?(?:\\s|$)`, 'm').test(dump);
}

function installState(home, profile, packageName) {
  const pkgPath = join(home, 'profiles', profile, 'package.json');
  if (!existsSync(pkgPath)) {
    return { dependency: null, inBundles: false, installedOnDisk: false, installDir: null, pkg: null };
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = pkg.dependencies ?? {};
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const installDir = join(home, 'profiles', profile, 'node_modules', ...packageName.split('/'));
  return {
    dependency: Object.prototype.hasOwnProperty.call(deps, packageName) ? String(deps[packageName]) : null,
    inBundles: bundles.includes(packageName),
    bundles,
    installedOnDisk: existsSync(join(installDir, 'package.json')),
    installDir,
    pkg,
  };
}

function readInstalledManifest(home, profile, packageName) {
  const file = join(home, 'profiles', profile, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
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

function stageTarball(origin, fileName) {
  const stageRoot = mkdtempSync(join(tmpdir(), 'spaces-rc2-tgz-'));
  const rel = relative(tmpdir(), stageRoot);
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('tarball stage escaped tmpdir');
  requireShellSafe(stageRoot, 'tarball stage');
  const staged = join(stageRoot, fileName);
  copyFileSync(origin, staged);
  const hash = sha256File(staged);
  if (hash !== sha256File(origin)) throw new Error(`staged ${fileName} differs from packed artifact`);
  return { origin, staged, sha256: hash, stageRoot };
}

function resolveRc2Bin() {
  const override = (process.env.DSH_TEST_RC2_BIN || process.env.DSH_TEST_BIN || '').trim();
  const candidate = override || DEFAULT_RC2_BIN;
  if (!existsSync(candidate)) {
    throw new Error(`rc.2 CLI missing at ${candidate}; set DSH_TEST_RC2_BIN or DSH_TEST_BIN`);
  }
  return resolve(candidate);
}

function track(child) {
  if (child) owned.push(child);
  return child;
}

async function cleanupOwned() {
  for (const child of [...owned].reverse()) {
    try {
      if (child && child.exitCode === null && child.signalCode === null && child.pid) {
        await stopOwned(child);
      }
    } catch {
      /* only this script's spawned tree */
    }
  }
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch {
      /* experiment parent / browser owned by this script */
    }
  }
}

function liveVersion(bin, home, tooling) {
  const result = spawnSync(node, [bin, '--version'], {
    env: stripSecrets(isolatedEnv(home, node, tooling)),
    encoding: 'utf8',
    timeout: VERSION_MS,
    windowsHide: true,
  });
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  writeFileSync(join(output, 'version.log'), redact(raw));
  if (result.error) throw new Error(`dsh --version failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`dsh --version exited ${result.status}: ${redact(raw.slice(0, 400))}`);
  }
  return { raw: raw.trim(), parsed: parseVersionText(raw) };
}

async function startOwned(bin, home, tooling, profile, logPath, extraEnv = {}) {
  const port = await ephemeralPort();
  writeFileSync(logPath, '', 'utf8');
  const env = { ...stripSecrets(isolatedEnv(home, node, tooling)), ...extraEnv };
  const child = spawn(node, [bin, '--profile', profile, '--no-open', '--host', HOST, '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!child.pid) throw new Error(`failed to spawn ${profile}`);
  track(child);
  const append = chunk => writeFileSync(logPath, redact(chunk.toString('utf8')), { flag: 'a' });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  try {
    const launchUrl = await captureLaunchUrl(child, port, BOOT_MS);
    return { child, port, launchUrl, origin: launchUrl.origin, pid: child.pid };
  } catch (error) {
    await stopOwned(child);
    throw error;
  }
}

function viewEnv(parentOrigin, spaceId, generation, channel) {
  return {
    DSH_SPACES_VIEW_PARENT_ORIGIN: parentOrigin,
    DSH_SPACES_VIEW_ID: spaceId,
    DSH_SPACES_VIEW_GENERATION: String(generation),
    DSH_SPACES_VIEW_CHANNEL: channel,
  };
}

function rpcError(call) {
  return {
    status: call.status,
    ok: Boolean(call.body?.result?.ok),
    code: call.body?.result?.error?.code ?? null,
    message: redact(call.body?.result?.error?.message ?? call.text ?? ''),
  };
}

function assertRpcUnavailable(call, label) {
  if (rpcAvailable(call)) {
    throw new Error(`${label} must stay unregistered on a non-manager profile; got a successful RPC`);
  }
  return rpcError(call);
}

function cookiePair(cookie) {
  if (!cookie) return null;
  const at = cookie.indexOf('=');
  if (at <= 0) return null;
  return { name: cookie.slice(0, at), value: cookie.slice(at + 1) };
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

function experimentParentHtml(parentOrigin, children) {
  const spec = { officialWorkbench: false, parentOrigin, children };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>rc.2 view-bridge experiment (not official workbench)</title>
</head>
<body>
<p data-rc2-experiment="not-official-workbench">Compatibility experiment parent — not the official DSH Spaces workbench.</p>
<div id="frames"></div>
<script>
const spec = ${JSON.stringify(spec)};
window.__RC2_EXPERIMENT__ = {
  officialWorkbench: false,
  note: "independent compatibility parent; not the product workbench",
  parentOrigin: spec.parentOrigin,
  accepted: {},
  rejected: [],
  errors: [],
};
window.addEventListener("message", (event) => {
  const child = spec.children.find((row) => row.origin === event.origin);
  const data = event.data;
  if (!child) {
    window.__RC2_EXPERIMENT__.rejected.push({ reason: "unexpected-origin", origin: String(event.origin) });
    return;
  }
  if (!data || typeof data !== "object" || data.source !== "dsh-spaces-view") {
    window.__RC2_EXPERIMENT__.rejected.push({ reason: "bad-source", origin: event.origin });
    return;
  }
  if (data.spaceId !== child.id || data.generation !== child.generation || data.channel !== child.channel) {
    window.__RC2_EXPERIMENT__.rejected.push({ reason: "identity-mismatch", origin: event.origin });
    return;
  }
  if (data.state !== "ready" && data.state !== "failed" && data.state !== "disconnected") {
    window.__RC2_EXPERIMENT__.rejected.push({ reason: "bad-state", origin: event.origin });
    return;
  }
  window.__RC2_EXPERIMENT__.accepted[child.id] = {
    origin: event.origin,
    state: data.state,
    spaceId: data.spaceId,
    generation: data.generation,
    channel: data.channel,
  };
});
for (const child of spec.children) {
  const frame = document.createElement("iframe");
  frame.id = "frame-" + child.id;
  frame.title = child.id;
  frame.setAttribute("data-space-id", child.id);
  frame.style.cssText = "width:720px;height:540px;border:1px solid #888";
  frame.src = child.origin + "/";
  frame.addEventListener("load", () => {
    try {
      frame.contentWindow.postMessage({
        source: "dsh-spaces-view-parent",
        type: "ping",
        spaceId: child.id,
        generation: child.generation,
        channel: child.channel,
      }, child.origin);
    } catch (error) {
      window.__RC2_EXPERIMENT__.errors.push(String(error && error.message ? error.message : error));
    }
  });
  document.getElementById("frames").appendChild(frame);
}
</script>
</body>
</html>`;
}

async function startExperimentParent() {
  const spec = { parentOrigin: '', children: [] };
  const port = await ephemeralPort();
  spec.parentOrigin = `http://${HOST}:${port}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', spec.parentOrigin);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end(experimentParentHtml(spec.parentOrigin, spec.children));
      return;
    }
    res.writeHead(404, { 'cache-control': 'no-store' });
    res.end();
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolveListen());
  });
  closers.push(() => new Promise(resolveClose => {
    server.close(() => resolveClose());
    setTimeout(resolveClose, 2000).unref();
  }));
  return {
    origin: spec.parentOrigin,
    port,
    setChildren(children) {
      spec.children = children;
    },
  };
}

async function chromiumEvidence(parent, children, host) {
  mkdirSync(join(output, 'screenshots'), { recursive: true });
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  closers.push(() => browser.close().catch(() => {}));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const browserErrors = [];
  const recordError = text => {
    const line = redact(text);
    browserErrors.push(line);
    console.log(`BROWSER ${line}`);
  };
  for (const child of children) {
    const pair = cookiePair(child.cookie);
    if (!pair) continue;
    await context.addCookies([{
      name: pair.name,
      value: pair.value,
      url: `${child.origin}/`,
      httpOnly: true,
      sameSite: 'Strict',
    }]);
  }
  if (host?.cookie) {
    const pair = cookiePair(host.cookie);
    if (pair) {
      await context.addCookies([{
        name: pair.name,
        value: pair.value,
        url: `${host.origin}/`,
        httpOnly: true,
        sameSite: 'Strict',
      }]);
    }
  }

  const page = await context.newPage();
  page.on('pageerror', error => recordError(error.message));
  page.on('console', message => {
    if (message.type() === 'error') recordError(message.text());
  });
  await page.goto(parent.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const disclaimer = await page.locator('[data-rc2-experiment="not-official-workbench"]').textContent();
  assert.match(String(disclaimer), /not the official DSH Spaces workbench/i);
  await page.evaluate(payload => {
    window.postMessage(payload, window.location.origin);
  }, {
    source: 'dsh-spaces-view',
    spaceId: children[0].id,
    generation: children[0].generation,
    channel: children[0].channel,
    state: 'ready',
  });
  let handshake;
  try {
    handshake = await until(async () => {
      const state = await page.evaluate(() => window.__RC2_EXPERIMENT__);
      const coding = state?.accepted?.[SPACE_A];
      const notes = state?.accepted?.[SPACE_B];
      if (coding?.state === 'ready' && notes?.state === 'ready') return state;
      if (coding?.state === 'failed' || notes?.state === 'failed') return state;
      return false;
    }, 'experiment parent view-bridge handshake', HANDSHAKE_MS);
  } catch (error) {
    handshake = await page.evaluate(() => window.__RC2_EXPERIMENT__).catch(() => null);
    await page.screenshot({ path: join(output, 'screenshots', 'experiment-parent-failure.png') }).catch(() => {});
    writeFileSync(join(output, 'browser-errors.json'), `${JSON.stringify({ browserErrors, handshake }, null, 2)}\n`);
    throw error;
  }
  await page.screenshot({ path: join(output, 'screenshots', 'experiment-parent-two-iframes.png') });
  const forged = handshake.rejected?.some(row => row.reason === 'unexpected-origin');
  assert.equal(forged, true, 'parent must reject a same-window forged handshake with the parent origin');
  for (const child of children) {
    const row = handshake.accepted?.[child.id];
    assert.ok(row, `missing handshake for ${child.id}`);
    assert.equal(row.origin, child.origin);
    assert.equal(row.spaceId, child.id);
    assert.equal(row.generation, child.generation);
    assert.equal(row.channel, child.channel);
    assert.equal(row.state, 'ready', `${child.id} handshake state=${row.state}`);
  }
  const iframeCount = await page.locator('iframe[data-space-id]').count();
  assert.equal(iframeCount, 2);
  pass('Chromium experiment parent (not official workbench) received exact-origin view-bridge ready from both ordinary iframes');

  const hostPage = await context.newPage();
  hostPage.on('pageerror', error => recordError(error.message));
  hostPage.on('console', message => {
    if (message.type() === 'error') recordError(message.text());
  });
  await hostPage.goto(`${host.origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await hostPage.waitForSelector('body', { timeout: 30000 });
  await hostPage.locator('.dsh-spaces-return').waitFor({ timeout: 20000 }).catch(() => {});
  const rail = await hostPage.locator('.dsh-wb-rail').count();
  assert.equal(rail, 0, 'unregistered plugin-host must not render a nested workbench rail');
  await hostPage.screenshot({ path: join(output, 'screenshots', 'plugin-host-guide-only.png') });
  pass('Chromium plugin-host has no nested workbench rail');
  writeFileSync(join(output, 'browser-errors.json'), `${JSON.stringify(browserErrors.map(value => redact(value)), null, 2)}\n`);
  report.chromium = {
    officialWorkbench: false,
    experimentParent: parent.origin,
    handshake: {
      coding: handshake.accepted?.[SPACE_A] ?? null,
      notes: handshake.accepted?.[SPACE_B] ?? null,
      rejected: handshake.rejected ?? [],
    },
    pluginHostRail: rail,
    browserErrors,
    screenshots: [
      join(output, 'screenshots', 'experiment-parent-two-iframes.png'),
      join(output, 'screenshots', 'plugin-host-guide-only.png'),
    ],
  };
}

async function fetchDocument(origin, cookie) {
  const response = await fetch(`${origin}/`, {
    headers: { origin, ...(cookie ? { cookie } : {}) },
    redirect: 'manual',
    signal: AbortSignal.timeout(RPC_MS),
  });
  const text = await response.text();
  return { status: response.status, text, location: response.headers.get('location') };
}

async function workbenchCall(origin, cookie, method, payload = {}) {
  const response = await fetch(`${origin}/api/workbench/${method}`, {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  let body = null;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text: redact(text.slice(0, 400)) };
}

function ensureProfile(nodeExe, bin, home, tooling, name, applyIsolationPatch, assertDumpPatched) {
  const pkgPath = join(home, 'profiles', name, 'package.json');
  const logPath = join(output, `seed-${name}.log`);
  if (!existsSync(pkgPath)) {
    runDsh(
      nodeExe,
      bin,
      home,
      tooling,
      ['--profile', name, '--from-default-profile', WEB, '--dump-config'],
      SEED_MS,
      `${name} from-default-profile`,
      logPath,
    );
  }
  const patchPath = join(home, 'profiles', name, 'cordis.patch.yml');
  if (existsSync(patchPath)) {
    writeFileSync(patchPath, applyIsolationPatch(readFileSync(patchPath, 'utf8'), name, patchPath), 'utf8');
  }
  const dump = runDsh(nodeExe, bin, home, tooling, ['--profile', name, '--dump-config'], SEED_MS, `${name} dump-config`, logPath);
  assertDumpPatched(dump, name);
  writeFileSync(join(output, `dump-${name}-seed.txt`), dump, 'utf8');
  return dump;
}

function addPlugin(nodeExe, bin, home, tooling, profile, tarball, label) {
  const logPath = join(output, `${label}.log`);
  runDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ['plugin', '--profile', profile, 'add', tarball, '--config.auto-install-peers=true'],
    PLUGIN_MS,
    label,
    logPath,
  );
}

function assertReadback(home, profile, packageName, expectedName, expectedVersion) {
  const state = installState(home, profile, packageName);
  assert.ok(state.dependency, `${profile} package.json missing ${packageName}`);
  assert.equal(state.inBundles, true, `${profile} bundles missing ${packageName}: ${JSON.stringify(state.bundles)}`);
  assert.equal(state.installedOnDisk, true, `${profile} node_modules missing ${packageName}`);
  const installed = readInstalledManifest(home, profile, packageName);
  assert.ok(installed, `${profile} installed manifest missing for ${packageName}`);
  assert.equal(installed.name, expectedName);
  assert.equal(installed.version, expectedVersion);
  return { spec: state.dependency, installed: { name: installed.name, version: installed.version }, bundles: state.bundles };
}

async function probeSupervisor(bin, home, env, artifacts) {
  const supervisorBin = join(root, 'packages', 'supervisor', 'lib', 'index.js');
  const result = {
    attempted: true,
    started: false,
    refused: false,
    admitted: false,
    exitCode: null,
    reasons: [],
    dshVersion: null,
    role: null,
    managerStatus: null,
    error: null,
  };
  if (!existsSync(supervisorBin)) {
    gaps.push('packages/supervisor/lib/index.js missing; product manager probe skipped');
    result.attempted = false;
    result.error = 'packed supervisor missing';
    return result;
  }
  let launchOutput = '';
  let stderr = '';
  const child = spawn(node, [
    supervisorBin,
    '--home', home, '--bin', bin, '--node', node, '--port', '0',
    '--plugin-artifact', artifacts.plugin.staged,
    '--view-bridge-artifact', artifacts.bridge.staged,
    '--snapshot-worker', join(root, 'packages', 'supervisor', 'lib', 'snapshot-worker.mjs'),
    '--control-tool-root', join(output, 'tools'),
    '--snapshot-root', join(output, 'snapshots'),
  ], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.pid) throw new Error('failed to spawn packed supervisor');
  track(child);
  child.stdout.on('data', chunk => { launchOutput = (launchOutput + chunk.toString()).slice(-32768); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });
  let api = null;
  let origin = null;
  try {
    const ready = await until(() => {
      if (child.exitCode !== null) return { kind: 'exited', code: child.exitCode };
      const match = launchOutput.match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) return { kind: 'ready', bootstrap: match[1] };
      return false;
    }, 'rc.2 supervisor bind or exit', SUPERVISOR_MS);
    result.exitCode = child.exitCode;
    writeFileSync(join(output, 'supervisor.log'), redact(`${launchOutput}\n${stderr}`));
    if (ready.kind === 'exited') {
      const combined = redact(`${launchOutput}\n${stderr}`);
      result.refused = /0\.1\.5-rc\.1|incompatible/i.test(combined);
      result.error = combined.slice(0, 1200);
      result.reasons = [combined.slice(0, 400)];
      pass('packed supervisor did not stay up on rc.2; product manager was not started');
      return result;
    }
    result.started = true;
    origin = new URL(ready.bootstrap).origin;
    report.supervisorOrigin = origin;
    const response = await fetch(ready.bootstrap, { redirect: 'manual' });
    await response.body?.cancel();
    assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'supervisor bootstrap did not mint a session cookie');
    api = (method, payload = {}) => workbenchCall(origin, cookie, method, payload);
    const stateCall = await api('state');
    const state = stateCall.body?.ok ? stateCall.body.value : null;
    result.role = state?.role ?? null;
    result.dshVersion = state?.dshVersion ?? null;
    result.reasons = Array.isArray(state?.reasons) ? state.reasons.map(value => redact(value)) : [];
    result.managerStatus = state?.spaces?.find(space => space.id === state.managerId)?.status ?? null;
    const reasonText = result.reasons.join('\n');
    const gateText = /0\.1\.5-rc\.1|incompatible|compatible DSH CLI is required/i.test(reasonText);
    const managerRunning = result.managerStatus === 'running';
    if (state?.role === 'manager' && managerRunning && state.dshVersion === RC2 && !state.recoveryRequired) {
      result.admitted = true;
      pass('packed supervisor admitted a running manager on live 0.1.5-rc.2 (product write-gate no longer blocking)');
    } else {
      result.refused = true;
      pass('product manager was refused or left in recovery by the current 0.1.5-rc.1 write-gate');
      info(`supervisor role=${result.role} dshVersion=${result.dshVersion} manager=${result.managerStatus} recovery=${state?.recoveryRequired} gateText=${gateText}`);
    }
    report.productState = {
      role: result.role,
      dshVersion: result.dshVersion,
      recoveryRequired: state?.recoveryRequired ?? null,
      managerStatus: result.managerStatus,
      reasons: result.reasons,
    };
    if (api && state?.writable) {
      try {
        const plan = await api('preview', { request: { kind: 'controller.shutdown' } });
        if (plan.body?.ok && plan.body.value?.id) {
          await api('submit', {
            command: { kind: 'plan.execute', planId: plan.body.value.id },
            requestId: randomUUID(),
          });
          await until(() => child.exitCode !== null, 'supervisor shutdown', 15000).catch(() => false);
        }
      } catch {
        /* stopOwned below; never other Home processes */
      }
    }
    return result;
  } catch (error) {
    result.error = redact(errorText(error));
    writeFileSync(join(output, 'supervisor.log'), redact(`${launchOutput}\n${stderr}\n${result.error}`));
    throw error;
  } finally {
    if (child.exitCode === null) await stopOwned(child);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  output = flags.output;
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'screenshots'), { recursive: true });
  report.startedAt = new Date().toISOString();
  report.priorRootFailure = PRIOR_ROOT_FAIL;
  report.httpIsNotChromium = true;
  save();

  const bin = resolveRc2Bin();
  const packageVersion = cliVersion(bin);
  if (packageVersion !== RC2) {
    throw new Error(
      `CLI package.json is ${packageVersion}, not ${RC2}; this script will not rewrite versions or use rc.1 as rc.2`,
    );
  }

  const home = flags.home || mkdtempSync(join(output, 'home-'));
  refuseRealHome(home);
  report.home = home;
  report.cli = { bin, packageVersion };

  const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(output, key)]));
  Object.values(tooling).forEach(path => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, node, resolvePnpmCjs());
  const env = stripSecrets(isolatedEnv(home, node, tooling));

  const live = liveVersion(bin, home, tooling);
  report.cli.liveVersion = live.parsed;
  report.cli.liveRaw = redact(live.raw);
  if (live.parsed !== RC2) {
    throw new Error(`live dsh --version reported ${live.parsed || live.raw || '(empty)'}, not ${RC2}`);
  }
  if (live.parsed !== packageVersion) {
    throw new Error(`--version ${live.parsed} does not match package.json ${packageVersion}; refusing to paper over the mismatch`);
  }
  pass(`live dsh --version is ${RC2} and matches the adjacent package.json`);

  const packDir = join(output, 'packed');
  mkdirSync(packDir, { recursive: true });
  const pluginOrigin = packArtifact('plugin', packDir, env);
  const bridgeOrigin = packArtifact('view-bridge', packDir, env);
  const plugin = stageTarball(pluginOrigin, basename(pluginOrigin));
  const bridge = stageTarball(bridgeOrigin, basename(bridgeOrigin));
  report.artifacts = {
    plugin: { origin: plugin.origin, staged: plugin.staged, sha256: plugin.sha256 },
    bridge: { origin: bridge.origin, staged: bridge.staged, sha256: bridge.sha256 },
  };
  pass('current plugin and view-bridge packages packed; staged tarball hashes match');

  runDsh(node, bin, home, tooling, ['--profile', WEB, '--dump-config'], SEED_MS, 'seed official web', join(output, 'seed-web.log'));
  const webManifest = JSON.parse(readFileSync(join(home, 'profiles', WEB, 'package.json'), 'utf8'));
  assert.equal(Boolean(webManifest.dependencies?.[PLUGIN_NAME]), false);
  assert.equal(Boolean(webManifest.dependencies?.[BRIDGE_NAME]), false);
  pass('fresh official web profile seeded without copying user data or installing Spaces packages');

  const product = await probeSupervisor(bin, home, env, report.artifacts);
  report.productGate = {
    refused: product.refused,
    admitted: product.admitted,
    attempted: product.attempted,
    started: product.started,
    exitCode: product.exitCode,
    reasons: product.reasons,
    dshVersion: product.dshVersion,
    role: product.role,
    managerStatus: product.managerStatus,
    error: product.error,
  };
  report.productSupported = product.admitted === true;
  if (product.admitted) {
    pass('product path admitted rc.2; still not rewriting the documented rc.1 write-gate');
  } else if (product.attempted) {
    gaps.push('packed supervisor did not start a dedicated rc.2 manager; product write support is not granted');
  }

  const { applyIsolationPatch, assertDumpPatched } = await importCore();
  for (const name of [SPACE_A, SPACE_B, PLUGIN_HOST]) {
    ensureProfile(node, bin, home, tooling, name, applyIsolationPatch, assertDumpPatched);
  }
  pass(`two independent profiles ${SPACE_A}/${SPACE_B} plus ${PLUGIN_HOST} exist under the isolated Home`);

  if (!installState(home, SPACE_A, BRIDGE_NAME).inBundles) addPlugin(node, bin, home, tooling, SPACE_A, bridge.staged, 'bridge-coding');
  if (!installState(home, SPACE_B, BRIDGE_NAME).inBundles) addPlugin(node, bin, home, tooling, SPACE_B, bridge.staged, 'bridge-notes');
  if (!installState(home, PLUGIN_HOST, PLUGIN_NAME).inBundles) addPlugin(node, bin, home, tooling, PLUGIN_HOST, plugin.staged, 'plugin-host');

  const codingBridge = assertReadback(home, SPACE_A, BRIDGE_NAME, BRIDGE_NAME, '0.2.0');
  const notesBridge = assertReadback(home, SPACE_B, BRIDGE_NAME, BRIDGE_NAME, '0.2.0');
  const hostPlugin = assertReadback(home, PLUGIN_HOST, PLUGIN_NAME, PLUGIN_NAME, '0.2.0');
  assert.equal(installState(home, SPACE_A, PLUGIN_NAME).inBundles, false);
  assert.equal(installState(home, SPACE_A, PLUGIN_NAME).installedOnDisk, false);
  assert.equal(installState(home, SPACE_B, PLUGIN_NAME).inBundles, false);
  assert.equal(installState(home, SPACE_B, PLUGIN_NAME).installedOnDisk, false);
  report.manifests = { codingBridge, notesBridge, hostPlugin };
  pass('ordinary profiles have only packed view-bridge; plugin-host has packed @dsh-spaces/plugin; versions read back from disk');

  const dumpCoding = runDsh(node, bin, home, tooling, ['--profile', SPACE_A, '--dump-config'], SEED_MS, 'coding dump after bridge', join(output, 'dump-coding.log'));
  const dumpNotes = runDsh(node, bin, home, tooling, ['--profile', SPACE_B, '--dump-config'], SEED_MS, 'notes dump after bridge', join(output, 'dump-notes.log'));
  const dumpHost = runDsh(node, bin, home, tooling, ['--profile', PLUGIN_HOST, '--dump-config'], SEED_MS, 'plugin-host dump after plugin', join(output, 'dump-plugin-host.log'));
  const dumpWeb = runDsh(node, bin, home, tooling, ['--profile', WEB, '--dump-config'], SEED_MS, 'web dump after seed', join(output, 'dump-web.log'));
  writeFileSync(join(output, 'dump-coding.txt'), dumpCoding, 'utf8');
  writeFileSync(join(output, 'dump-notes.txt'), dumpNotes, 'utf8');
  writeFileSync(join(output, 'dump-plugin-host.txt'), dumpHost, 'utf8');
  writeFileSync(join(output, 'dump-web.txt'), dumpWeb, 'utf8');
  assert.equal(dumpHasExactId(dumpCoding, BRIDGE_ROW), true);
  assert.equal(dumpHasExactId(dumpNotes, BRIDGE_ROW), true);
  assert.equal(dumpHasExactId(dumpCoding, PLUGIN_ROW), false);
  assert.equal(dumpHasExactId(dumpNotes, PLUGIN_ROW), false);
  assert.equal(dumpHasExactId(dumpHost, PLUGIN_ROW), true);
  assert.equal(dumpHasExactId(dumpWeb, PLUGIN_ROW), false);
  assert.equal(dumpHasExactId(dumpWeb, BRIDGE_ROW), false);
  pass('dump-config rows match: lightbridge on ordinary profiles, full Spaces plugin only on plugin-host, official web unchanged');

  const parent = await startExperimentParent();
  const viewCoding = { id: SPACE_A, generation: 1, channel: 'rc2-coding' };
  const viewNotes = { id: SPACE_B, generation: 2, channel: 'rc2-notes' };
  report.experimentParent = { origin: parent.origin, officialWorkbench: false };

  const web = await startOwned(bin, home, tooling, WEB, join(output, 'dsh-web.log'));
  const coding = await startOwned(
    bin, home, tooling, SPACE_A, join(output, 'dsh-coding.log'),
    viewEnv(parent.origin, viewCoding.id, viewCoding.generation, viewCoding.channel),
  );
  const notes = await startOwned(
    bin, home, tooling, SPACE_B, join(output, 'dsh-notes.log'),
    viewEnv(parent.origin, viewNotes.id, viewNotes.generation, viewNotes.channel),
  );
  parent.setChildren([
    { ...viewCoding, origin: coding.origin },
    { ...viewNotes, origin: notes.origin },
  ]);
  assert.notEqual(web.port, coding.port);
  assert.notEqual(coding.port, notes.port);
  assert.notEqual(web.port, notes.port);

  const webCookie = await sessionCookie(web.launchUrl);
  const codingCookie = await sessionCookie(coding.launchUrl);
  const notesCookie = await sessionCookie(notes.launchUrl);
  const webDoc = await fetchDocument(web.origin, webCookie);
  const codingDoc = await fetchDocument(coding.origin, codingCookie);
  const notesDoc = await fetchDocument(notes.origin, notesCookie);
  assert.equal(webDoc.status, 200);
  assert.equal(codingDoc.status, 200);
  assert.equal(notesDoc.status, 200);
  assert.match(webDoc.text, /(?:dsh|deepseek)/i);
  assert.match(codingDoc.text, /(?:dsh|deepseek)/i);
  assert.match(notesDoc.text, /(?:dsh|deepseek)/i);
  pass('official web and two independent rc.2 profiles launched on distinct 127.0.0.1 ports');

  assert.match(codingDoc.text, /__DSH_SPACES_VIEW__/);
  assert.ok(codingDoc.text.includes(`"spaceId":"${SPACE_A}"`));
  assert.match(notesDoc.text, /__DSH_SPACES_VIEW__/);
  assert.ok(notesDoc.text.includes(`"spaceId":"${SPACE_B}"`));
  assert.equal(webDoc.text.includes('__DSH_SPACES_VIEW__'), false);
  pass('packed lightbridge injected the view handshake into ordinary profile documents only');

  assertRpcOk(await rpc(web.port, webCookie, 'session/list', { _request: {} }), 'web session/list');
  assertRpcOk(await rpc(coding.port, codingCookie, 'session/list', { _request: {} }), 'coding session/list');
  assertRpcOk(await rpc(notes.port, notesCookie, 'session/list', { _request: {} }), 'notes session/list');
  const cross = await rpc(notes.port, codingCookie, 'session/list', { _request: {} });
  assert.equal(rpcAvailable(cross), false, 'coding cookie must not authorize notes');
  const codingSpaces = await rpc(coding.port, codingCookie, 'spaces/overview', {});
  const notesSpaces = await rpc(notes.port, notesCookie, 'spaces/overview', {});
  const codingGuide = await rpc(coding.port, codingCookie, 'workbenchGuide/role', {});
  const notesGuide = await rpc(notes.port, notesCookie, 'workbenchGuide/role', {});
  assert.equal(rpcAvailable(codingSpaces), false);
  assert.equal(rpcAvailable(notesSpaces), false);
  assert.equal(rpcAvailable(codingGuide), false);
  assert.equal(rpcAvailable(notesGuide), false);
  report.ordinaryRpc = {
    codingSpaces: { status: codingSpaces.status, ok: Boolean(codingSpaces.body?.result?.ok) },
    notesSpaces: { status: notesSpaces.status, ok: Boolean(notesSpaces.body?.result?.ok) },
    crossNotesWithCodingCookie: { status: cross.status, ok: Boolean(cross.body?.result?.ok) },
  };
  pass('ordinary profiles expose session/list typed RPC, not Spaces/workbenchGuide (HTTP only; not Chromium)');

  const host = await startOwned(bin, home, tooling, PLUGIN_HOST, join(output, 'dsh-plugin-host.log'));
  const hostCookie = await sessionCookie(host.launchUrl);
  const hostDoc = await fetchDocument(host.origin, hostCookie);
  assert.equal(hostDoc.status, 200);
  assert.match(hostDoc.text, /(?:dsh|deepseek)/i);
  const guide = assertRpcOk(await rpc(host.port, hostCookie, 'workbenchGuide/role', {}), 'plugin-host workbenchGuide/role');
  assert.notEqual(guide.role, 'manager', 'unregistered plugin-host must not claim manager');
  assert.ok(
    guide.role === 'workspace' || guide.role === 'uninitialized',
    `plugin-host guide role must be workspace or uninitialized, got ${guide.role}`,
  );
  if (guide.role === 'workspace') {
    assert.equal(guide.profileId, PLUGIN_HOST);
  }
  const overviewDenied = assertRpcUnavailable(
    await rpc(host.port, hostCookie, 'spaces/overview', {}),
    'plugin-host spaces/overview',
  );
  const createDenied = assertRpcUnavailable(
    await rpc(host.port, hostCookie, 'spaces/create', {
      input: { name: 'must-not-exist', displayName: 'No' },
    }, SEED_MS),
    'plugin-host spaces/create',
  );
  const submitDenied = assertRpcUnavailable(
    await rpc(host.port, hostCookie, 'workbench/submit', {
      command: { kind: 'space.create', input: { name: 'must-not-exist' } },
      requestId: randomUUID(),
    }),
    'plugin-host workbench/submit',
  );
  const stateDenied = assertRpcUnavailable(
    await rpc(host.port, hostCookie, 'workbench/state', {}),
    'plugin-host workbench/state',
  );
  assert.equal(existsSync(join(home, 'profiles', 'must-not-exist')), false);
  if (hostDoc.text.includes('__DSH_SPACES_HOST__')) {
    assert.equal(hostDoc.text.includes('"role":"manager"'), false);
  }
  report.pluginHostGuide = {
    role: guide.role,
    profileId: guide.profileId ?? null,
    managerId: guide.managerId ?? null,
    recoveryRequired: guide.recoveryRequired ?? null,
    reasons: Array.isArray(guide.reasons) ? guide.reasons.map(value => redact(value)) : [],
    unavailable: { overview: overviewDenied, create: createDenied, submit: submitDenied, state: stateDenied },
  };
  pass(
    `unregistered plugin-host is guide-only on rc.2 (role=${guide.role}); spaces/workbench writes stay unregistered (${overviewDenied.code || 'unavailable'})`,
  );

  await chromiumEvidence(parent, [
    { ...viewCoding, origin: coding.origin, cookie: codingCookie },
    { ...viewNotes, origin: notes.origin, cookie: notesCookie },
  ], { origin: host.origin, cookie: hostCookie });

  report.processes = {
    web: { port: web.port, pid: web.pid },
    coding: { port: coding.port, pid: coding.pid },
    notes: { port: notes.port, pid: notes.pid },
    pluginHost: { port: host.port, pid: host.pid },
  };
  report.fullProductValidated = false;
  report.scope = product.admitted
    ? 'live 0.1.5-rc.2 product manager admitted; low-level CLI/bridge/guide wiring and Chromium experiment parent also proved'
    : 'low-level CLI / view-bridge / guide-only plugin on live 0.1.5-rc.2 plus Chromium experiment parent; product write-gate still 0.1.5-rc.1; full product unvalidated';
  report.status = product.admitted ? 'pass' : 'blocked';
  report.finishedAt = new Date().toISOString();
  save();
  console.log(product.admitted ? '\nRC2 COMPATIBILITY: PASS' : '\nRC2 COMPATIBILITY: BLOCKED');
  console.log(`productSupported=${report.productSupported}`);
  console.log(`fullProductValidated=false`);
  console.log(`scope=${report.scope}`);
  process.exitCode = product.admitted ? 0 : 2;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main()
    .catch(error => {
      report.status = 'fail';
      report.productSupported = false;
      report.error = redact(errorText(error));
      report.finishedAt = new Date().toISOString();
      mkdirSync(output, { recursive: true });
      save();
      console.error(`FAIL ${redact(error instanceof Error ? error.message : error)}`);
      process.exitCode = 1;
    })
    .finally(() => cleanupOwned());
}
