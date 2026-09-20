#!/usr/bin/env node
/**
 * Real maintenance-crash acceptance. Isolated Home, empty session, rc1 CLI,
 * packed plugin/view-bridge. No model calls. Does not import
 * scripts/verify-workbench-maintenance-product.mjs (unsafe: top-level parseFlags).
 *
 * Injection uses the source test seam (createMaintenance + CoordinatedUpgrade.opts.inject
 * and a test worker that patches SnapshotStore.restore then loads the production
 * snapshot-worker). Packed supervisor/doctor are the formal restore entry after a
 * crash. Do not treat this as a full distribution proof.
 *
 *   node scripts/verify-workbench-crash.mjs [--phase upgrade-throw|restore-kill|upgrade-kill|all]
 *     [--self-check] [--http-only] [--output DIR] [--home DIR]
 *
 * Env: DSH_TEST_BIN, DSH_TEST_OUTPUT, DSH_TEST_HOME, DSH_TEST_PNPM_CJS,
 * DSH_TEST_PLAYWRIGHT or DSH_TEST_PLAYWRIGHT_MODULE.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
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
} from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const COMPATIBLE = '0.1.5-rc.1';
const SPACE = 'coding';
const SPACE_NAME = '编程';
const PHASES = ['upgrade-throw', 'restore-kill', 'upgrade-kill'];
const DRIVER = join(root, 'tests/fixtures/workbench-crash/driver.ts');
const WORKER_TS = join(root, 'tests/fixtures/workbench-crash/snapshot-worker.ts');
const PRODUCTION_WORKER_TS = join(root, 'src/main/snapshot-worker.ts');
const PACKED_SUPERVISOR = join(root, 'packages/supervisor/lib/index.js');
const PACKED_WORKER = join(root, 'packages/supervisor/lib/snapshot-worker.mjs');
const DOCTOR = join(root, 'packages/doctor/lib/index.js');
const PRODUCT_SCRIPT = join(root, 'scripts/verify-workbench-maintenance-product.mjs');
const DEFAULT_PLAYWRIGHT =
  'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const JOB_MS = 600_000;
const RUNTIME_MS = 900_000;
const SUPERVISOR_MS = 240_000;
const SEED_MS = 180_000;
const HEARTBEAT_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 3_000;
const JOB_QUERY_MS = 5_000;
const RECOVERY_MS = 600_000;
const HASH_FILES = [
  'hub/spaces.json',
  join('hub', SPACE, 'sessions', 'maintenance-marker.txt'),
  join('sessions', SPACE, 'maintenance-marker.txt'),
  join('profiles', SPACE, 'package.json'),
  join('profiles', SPACE, 'cordis.patch.yml'),
  join('profiles', 'web', 'cordis.patch.yml'),
];

export const FAULT_PHASES = PHASES;

function parseFlags(argv) {
  let phase = 'all';
  let selfCheck = false;
  let httpOnly = true;
  let out = process.env.DSH_TEST_OUTPUT || join(root, '.sandbox', 'workbench-crash');
  let home = process.env.DSH_TEST_HOME || '';
  let resumeFrom = '';
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
    else if (name === '--resume-from') resumeFrom = take();
    else throw new Error(`unknown flag: ${token}`);
  }
  if (!['all', 'self-check', ...PHASES].includes(phase)) {
    throw new Error(`unknown --phase ${phase}; expected upgrade-throw|restore-kill|upgrade-kill|all`);
  }
  return { phase, selfCheck: selfCheck || phase === 'self-check', httpOnly, output: resolve(out), home: home.trim() ? resolve(home.trim()) : '', resumeFrom };
}

const redact = value =>
  String(value)
    .replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/\/bootstrap\/[^\s"'<>]+/g, '/bootstrap/[redacted]')
    .replace(/(dsh-auth-[^=\s]+)=([^;\s"']+)/g, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/g, 'Bearer [redacted]');

function productModuleSafety() {
  const source = readFileSync(PRODUCT_SCRIPT, 'utf8');
  const hasInvokedGuard = /const invoked = process\.argv\[1\]/.test(source);
  const parsesArgvAtLoad = /parseFlags\(process\.argv\.slice\(2\)\)/.test(source);
  return {
    path: PRODUCT_SCRIPT,
    safeImport: hasInvokedGuard && !parsesArgvAtLoad,
    hasInvokedGuard,
    parsesArgvAtLoad,
    reason: parsesArgvAtLoad
      ? 'top-level parseFlags(process.argv) throws on unknown flags; this script must not import it'
      : 'invoked guard present',
  };
}

export async function runSelfCheck(outputDir = join(root, '.sandbox', 'workbench-crash')) {
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

  const script = join(root, 'scripts/verify-workbench-crash.mjs');
  const syntax = spawnSync(node, ['--check', script], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (syntax.status !== 0) fail('syntax verify-workbench-crash.mjs', syntax.stderr || syntax.stdout);
  else pass('syntax verify-workbench-crash.mjs');

  const product = productModuleSafety();
  if (product.safeImport) fail('product-module-not-imported', 'product module looks import-safe now; re-evaluate before sharing helpers');
  else pass('product-module-unsafe-not-imported', product);

  try {
    const dist = await import(pathToFileURL(join(root, 'scripts/verify-spaces-distribution.mjs')).href);
    assert.equal(typeof dist.refuseRealHome, 'function');
    assert.equal(typeof dist.isolatedEnv, 'function');
    pass('distribution-helpers-safe-import');
  } catch (error) {
    fail('distribution-helpers-safe-import', error);
  }

  try {
    const production = inspectProductionWorker();
    if (!production.operations.includes('runtimeInstall')) {
      fail('production-worker-operations', 'src/main/snapshot-worker.ts is missing runtimeInstall');
    } else if (!production.hasErrorName || !production.hasProcessTermination || !production.hasChildObservation) {
      fail('production-worker-operations', 'production worker missing async errorName / ProcessTerminationError / child observation');
    } else pass('production-worker-operations', production);
  } catch (error) {
    fail('production-worker-operations', error);
  }

  try {
    const workerSource = readFileSync(WORKER_TS, 'utf8');
    if (/store\.delete\(data\.id/.test(workerSource)) {
      fail('test-worker-no-copied-dispatch', 'test worker still copies store.delete fallback dispatch');
    } else if (!workerSource.includes('snapshot-worker.ts') || !workerSource.includes('SnapshotStore.prototype.restore')) {
      fail('test-worker-no-copied-dispatch', 'test worker must patch SnapshotStore.prototype.restore then load production snapshot-worker');
    } else pass('test-worker-no-copied-dispatch');
  } catch (error) {
    fail('test-worker-no-copied-dispatch', error);
  }

  try {
    const workerJs = await bundleFaultWorker(output);
    const check = spawnSync(node, ['--check', workerJs], { cwd: root, windowsHide: true, encoding: 'utf8' });
    if (check.status !== 0) fail('crash-worker-bundle', check.stderr || check.stdout);
    else {
      const bundled = readFileSync(workerJs, 'utf8');
      const production = inspectProductionWorker();
      const missing = production.operations.filter(op => !bundled.includes(`"${op}"`) && !bundled.includes(`'${op}'`));
      if (missing.length) fail('crash-worker-bundle', `bundled worker dropped operations: ${missing.join(',')}`);
      else if (!bundled.includes('runtimeInstall') || !bundled.includes('ProcessTerminationError') || !bundled.includes('errorName')) {
        fail('crash-worker-bundle', 'bundled worker missing runtimeInstall/ProcessTerminationError/errorName');
      } else pass('crash-worker-bundle', { path: workerJs, operations: production.operations });
    }
  } catch (error) {
    fail('crash-worker-bundle', error);
  }

  try {
    const result = spawnSync(node, ['--import', 'tsx', DRIVER, '--self-check'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env },
    });
    if (result.status !== 0) fail('crash-driver-self-check', result.stderr || result.stdout);
    else if (!String(result.stdout).includes('crash-driver-self-check=ok')) fail('crash-driver-self-check', result.stdout);
    else pass('crash-driver-self-check', { stdout: String(result.stdout).trim() });
  } catch (error) {
    fail('crash-driver-self-check', error);
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

function inspectProductionWorker() {
  const source = readFileSync(PRODUCTION_WORKER_TS, 'utf8');
  const compared = [...source.matchAll(/data\.operation === "([^"]+)"/g)].map(match => match[1]);
  const typed = [...source.matchAll(/^\s*\| "([A-Za-z]+)"/gm)].map(match => match[1]);
  const operations = [...new Set(compared)];
  return {
    operations,
    typed,
    hasRuntimeInstall: operations.includes('runtimeInstall') || typed.includes('runtimeInstall'),
    hasErrorName: source.includes('errorName'),
    hasProcessTermination: source.includes('ProcessTerminationError'),
    hasChildObservation: source.includes('observeMaintenanceChild') && source.includes('withChildObservation'),
    asyncDispatch: /const result = await dispatch\(input\)/.test(source),
  };
}

async function bundleFaultWorker(output) {
  const { build } = await import('esbuild');
  const outfile = join(output, 'crash-snapshot-worker.mjs');
  mkdirSync(output, { recursive: true });
  await build({
    bundle: true,
    format: 'esm',
    platform: 'node',
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    target: 'es2022',
    absWorkingDir: root,
    entryPoints: [WORKER_TS],
    outfile,
    logLevel: 'silent',
  });
  return outfile;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  mkdirSync(flags.output, { recursive: true });
  if (flags.selfCheck) {
    const report = await runSelfCheck(flags.output);
    console.log(`PASS self-check ${report.checks.length} checks`);
    return;
  }
  if (flags.resumeFrom) await resumeRestoreReport(flags);
  else await runFaults(flags);
}

async function resumeRestoreReport(flags) {
  const reportPath = realpathSync(resolve(flags.resumeFrom));
  const sandbox = realpathSync(join(root, '.sandbox'));
  const inside = (parent, child) => {
    const rel = relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  assert.ok(inside(sandbox, reportPath), 'only this workspace isolated evidence may be resumed');
  const prior = JSON.parse(readFileSync(reportPath, 'utf8'));
  const row = structuredClone(prior.phases?.['restore-kill']);
  assert.ok(row?.killedJob?.id && row.marker?.op === 'restore:swap' && row.marker?.action === 'kill', 'missing actual restore crash evidence');
  const home = realpathSync(row.home);
  assert.ok(inside(dirname(reportPath), home), 'recorded Home escaped the prior acceptance output');
  refuseRealHome(home);
  for (const artifact of [prior.artifacts.plugin, prior.artifacts.bridge]) {
    assert.equal(sha256File(artifact.path), artifact.sha256, 'prior artifact changed');
  }
  const binding = JSON.parse(readFileSync(join(home, '.dsh-spaces-control', 'toolchain.json'), 'utf8'));
  const phaseDir = join(flags.output, 'restore-kill');
  mkdirSync(phaseDir, { recursive: true });
  const tools = realpathSync(binding.runtimeRoot || binding.toolchainRoot);
  const snapshots = realpathSync(binding.snapshotRoot);
  assert.ok(inside(dirname(reportPath), tools) && inside(dirname(reportPath), snapshots), 'private recovery resources escaped original output');
  const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(dirname(reportPath), key)]));
  const ctx = { home, tools, snapshots, phaseDir, artifacts: prior.artifacts,
    markerDir: join(dirname(reportPath), 'restore-kill', 'markers'), httpOnly: flags.httpOnly,
    env: stripSecrets(isolatedEnv(home, node, tooling)) };
  delete row.error;
  row.status = 'running';
  const report = { status: 'running', resumedFrom: reportPath, realDsh: true, modelCalls: false,
    notADistributionProof: true, phases: { 'restore-kill': row }, proved: [], startedAt: new Date().toISOString() };
  try {
    await recoverRestoreKill(ctx, row, message => { report.proved.push(message); console.log(`PASS ${message}`); }, row.killedJob.id);
    row.status = report.status = 'pass';
  } catch (error) {
    row.status = report.status = 'fail';
    row.error = redact(error instanceof Error ? error.stack : error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(flags.output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}

async function runFaults(flags) {
  const output = flags.output;
  const proved = [];
  const uncovered = [];
  const phaseResults = {};
  const report = {
    status: 'running',
    proved,
    uncovered,
    phases: phaseResults,
    realDsh: true,
    modelCalls: false,
    compatibleCli: COMPATIBLE,
    injectSeam: 'source-test-seam',
    packedRestoreEntry: true,
    heartbeatLimitMs: HEARTBEAT_TIMEOUT_MS,
    productModule: productModuleSafety(),
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

  if (!existsSync(binPath())) throw new Error(`DSH CLI missing at ${binPath()}; set DSH_TEST_BIN`);
  const version = cliVersion(binPath());
  if (version !== COMPATIBLE) throw new Error(`bound CLI is ${version}; faults only accept ${COMPATIBLE}`);
  assert.ok(existsSync(PACKED_SUPERVISOR), 'packages/supervisor/lib/index.js missing; rebuild before the real run');
  assert.ok(existsSync(PACKED_WORKER), 'packages/supervisor/lib/snapshot-worker.mjs missing; rebuild before the real run');
  assert.ok(existsSync(DOCTOR), 'packages/doctor/lib/index.js missing; rebuild before the real run');

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
  const workerJs = await bundleFaultWorker(output);
  report.artifacts = {
    plugin: { path: plugin, sha256: sha256File(plugin) },
    bridge: { path: bridge, sha256: sha256File(bridge) },
    faultWorker: { path: workerJs, sha256: sha256File(workerJs), source: WORKER_TS },
  };
  pass('plugin, view-bridge packed; crash worker bundled from production snapshot-worker + restore inject patch');
  save();

  const selected = flags.phase === 'all' ? ['upgrade-throw', 'restore-kill'] : [flags.phase];
  if (flags.phase === 'all') {
    uncovered.push('upgrade-kill not in all; run --phase upgrade-kill for commit:retarget SIGKILL');
  }
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
      await runPhase({
        phase,
        artifacts: report.artifacts,
        tooling,
        explicitHome: home || undefined,
        output,
        httpOnly: flags.httpOnly,
        proved,
        uncovered,
        phaseResults,
        pass,
        save,
      });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : error);
      const blocked = error?.blocked || /^blocked:/.test(String(error instanceof Error ? error.message : error));
      failures.push({ phase, blocked, error: message });
      console.error(`${blocked ? 'BLOCKED' : 'FAIL'} ${phase}: ${message}`);
      persist(output, 'run.log', `${blocked ? 'BLOCKED' : 'FAIL'} ${phase}: ${redact(error instanceof Error ? error.stack : error)}`);
    }
    save();
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

function binPath() {
  return process.env.DSH_TEST_BIN || DEFAULT_BIN;
}

function blocked(message) {
  const error = new Error(`blocked: ${message}`);
  error.blocked = true;
  return error;
}

function assertProvedRollbackSettlement(interruptedAfter, afterState) {
  if (!interruptedAfter) throw blocked('interrupted job disappeared after recovery');
  if (interruptedAfter.status === 'succeeded') {
    throw new Error('unproven job was settled succeeded');
  }
  if (afterState?.recoveryRequired || interruptedAfter.status === 'recovery-required') {
    throw blocked('recovery still required after resume/doctor; no proved rollback receipt');
  }
}

function persist(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, name), `${new Date().toISOString()} ${text}\n`);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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
  const result = run(node, [npm, 'pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: root,
    env,
    timeoutMs: 60_000,
    label: `pack ${name}`,
  });
  const rows = JSON.parse(result);
  const file = join(packDir, rows[0].filename);
  assert.ok(existsSync(file), `packed ${name} missing`);
  return file;
}

function hashManaged(home) {
  const hash = createHash('sha256');
  for (const rel of HASH_FILES) {
    const path = join(home, rel);
    hash.update(rel);
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.from('MISSING'));
  }
  return hash.digest('hex');
}

function runtimePointer(tools) {
  const path = join(tools, 'current.json');
  if (!existsSync(path)) return { path, present: false, sha256: null, body: null };
  return { path, present: true, sha256: sha256File(path), body: JSON.parse(readFileSync(path, 'utf8')) };
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

function spaceMetaName(home, spaceId) {
  const path = join(home, 'hub', 'spaces.json');
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  return file.meta?.[spaceId]?.displayName;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { unreadable: true, error: redact(error instanceof Error ? error.message : error) };
  }
}

function copyEvidence(home, snapshots, dest) {
  mkdirSync(dest, { recursive: true });
  const files = {
    upgradeJournal: join(home, '.dsh-spaces-upgrade', 'journal.json'),
    restoreJournal: join(home, '.dsh-spaces-restore', 'journal.json'),
    pendingRestore: join(snapshots, 'pending-restore.json'),
    spaces: join(home, 'hub', 'spaces.json'),
    runtimeCurrent: null,
  };
  const copied = {};
  for (const [name, path] of Object.entries(files)) {
    if (!path || !existsSync(path)) {
      copied[name] = null;
      continue;
    }
    const target = join(dest, `${name}.json`);
    writeFileSync(target, readFileSync(path));
    copied[name] = { path, sha256: sha256File(path) };
  }
  const jobsDir = join(home, '.dsh-spaces-control', 'jobs');
  const jobs = [];
  if (existsSync(jobsDir)) {
    mkdirSync(join(dest, 'jobs'), { recursive: true });
    for (const name of readdirSync(jobsDir).filter(item => item.endsWith('.json'))) {
      const path = join(jobsDir, name);
      writeFileSync(join(dest, 'jobs', name), readFileSync(path));
      jobs.push({ id: name.replace(/\.json$/, ''), sha256: sha256File(path), body: readJsonIfPresent(path) });
    }
  }
  const plansDir = join(home, '.dsh-spaces-control', 'plans');
  const plans = [];
  if (existsSync(plansDir)) {
    mkdirSync(join(dest, 'plans'), { recursive: true });
    for (const name of readdirSync(plansDir).filter(item => item.endsWith('.json'))) {
      const path = join(plansDir, name);
      writeFileSync(join(dest, 'plans', name), readFileSync(path));
      plans.push({ id: name.replace(/\.json$/, ''), sha256: sha256File(path), body: readJsonIfPresent(path) });
    }
  }
  return { copied, jobs, plans };
}

function listInstanceRecords(home) {
  const dir = join(home, '.dsh-spaces-control', 'instances');
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir).filter(item => item.endsWith('.json'))) {
    const path = join(dir, name);
    const body = readJsonIfPresent(path);
    let alive = 'unknown';
    if (body && Number.isInteger(body.pid) && body.pid > 0) {
      try {
        process.kill(body.pid, 0);
        alive = 'alive';
      } catch {
        alive = 'dead';
      }
    }
    rows.push({ id: name.replace(/\.json$/, ''), path, body, alive });
  }
  return rows;
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

async function acquireRecoveryController(session) {
  const before = await session.api('state');
  if (before.writable) return;
  const job = await session.api('submit', { command: { kind: 'controller.acquire' }, requestId: randomUUID() });
  assert.equal(job.status, 'succeeded', 'explicit reclaim of a proven-dead test controller failed');
  assert.equal((await session.api('state')).writable, true, 'recovery requires actual run rights');
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
  const expect = options.expect || 'succeeded';
  const heartbeat = startEntryHeartbeat(session);
  const transport = [];
  let latest;
  let runError;
  try {
    const first = await session.api('submit', { command, requestId });
    latest = first;
    const deadline = Date.now() + timeout;
    let attempt = 0;
    while (Date.now() < deadline) {
      const death = supervisorExit(session);
      if (death) {
        if (expect === 'supervisor-exit') break;
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
        if (expect === 'supervisor-exit') break;
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
    expect,
  });
  if (expect === 'supervisor-exit') {
    const deadline = Date.now() + 15_000;
    let death = supervisorExit(session);
    while (!death && Date.now() < deadline) {
      await delay(100);
      death = supervisorExit(session);
    }
    if (!death) throw new Error(`${label}: expected supervisor process exit, still running`);
    return { job: latest, requestId, death, heartbeat: heartbeatStats };
  }
  const death = supervisorExit(session);
  const pending = !latest || ['queued', 'running'].includes(latest.status);
  if (death && pending) {
    throw new Error(`${label}: supervisor exited exitCode=${death.exitCode} signal=${death.signal}; lastJob=${latest?.status ?? 'none'} ${latest?.phase ?? ''}`);
  }
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

async function executePlan(session, request, options = {}) {
  const plan = await session.api('preview', { request });
  const job = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, options);
  return { plan, job };
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
  persist(phaseDir, 'run.log', `spawn ${kind} pid=${child.pid} ${args.filter(item => item !== node).join(' ')}`);
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

async function launchFaultSupervisor(ctx) {
  const { home, artifacts, env, phaseDir, inject } = ctx;
  const args = [
    '--import', 'tsx', DRIVER,
    '--home', home,
    '--bin', binPath(),
    '--node', node,
    '--port', '0',
    '--plugin-artifact', artifacts.plugin.path,
    '--view-bridge-artifact', artifacts.bridge.path,
    '--snapshot-worker', artifacts.faultWorker.path,
    '--control-tool-root', ctx.tools,
    '--snapshot-root', ctx.snapshots,
    '--marker-dir', ctx.markerDir,
  ];
  if (inject.upgradeHook) args.push('--upgrade-hook', inject.upgradeHook, '--upgrade-action', inject.upgradeAction);
  if (inject.snapshotHook) args.push('--snapshot-hook', inject.snapshotHook, '--snapshot-action', inject.snapshotAction);
  const session = spawnSupervisor('fault-driver', args, env, phaseDir);
  Object.assign(session, { home, phaseDir, tools: ctx.tools, snapshots: ctx.snapshots, markerDir: ctx.markerDir, packed: false });
  await waitBootstrap(session, 'fault driver');
  await authorize(session, ctx.httpOnly);
  return session;
}

async function launchPackedSupervisor(ctx) {
  const { home, artifacts, env, phaseDir } = ctx;
  const args = [
    PACKED_SUPERVISOR,
    '--home', home, '--bin', binPath(), '--node', node, '--port', '0',
    '--plugin-artifact', artifacts.plugin.path,
    '--view-bridge-artifact', artifacts.bridge.path,
    '--snapshot-worker', PACKED_WORKER,
    '--control-tool-root', ctx.tools,
    '--snapshot-root', ctx.snapshots,
  ];
  const session = spawnSupervisor('packed-supervisor', args, env, phaseDir);
  Object.assign(session, { home, phaseDir, tools: ctx.tools, snapshots: ctx.snapshots, packed: true });
  await waitBootstrap(session, 'packed supervisor');
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
  if (session.supervisor.exitCode === null) await stopOwned(session.supervisor);
  writeFileSync(
    join(session.phaseDir, `${label}-supervisor.log`),
    redact(`${session.launchOutput()}\n${session.stderr()}`),
  );
}

async function seedOrdinary(session) {
  await submitJob(session, { kind: 'space.create', input: { name: SPACE, displayName: SPACE_NAME } }, { timeout: JOB_MS, label: 'space.create' });
  await submitJob(session, { kind: 'space.start', spaceId: SPACE }, { timeout: JOB_MS, label: 'space.start' });
}

function snapshotState(home, tools, label) {
  return {
    label,
    at: new Date().toISOString(),
    hash: hashManaged(home),
    markers: readMarkers(home),
    displayName: spaceMetaName(home, SPACE),
    runtime: runtimePointer(tools),
  };
}

async function runPhase(input) {
  const { phase, artifacts, tooling, explicitHome, output, httpOnly, phaseResults, pass, save } = input;
  const phaseDir = join(output, phase);
  mkdirSync(phaseDir, { recursive: true });
  const home = explicitHome || mkdtempSync(join(phaseDir, 'home-'));
  refuseRealHome(home);
  const tools = join(phaseDir, 'tools', basename(home));
  const snapshots = join(phaseDir, 'snapshots', basename(home));
  const markerDir = join(phaseDir, 'markers');
  mkdirSync(tools, { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  mkdirSync(markerDir, { recursive: true });
  const env = stripSecrets(isolatedEnv(home, node, tooling));
  const started = new Date().toISOString();
  const row = { status: 'running', home, startedAt: started, injectSeam: 'source-test-seam' };
  phaseResults[phase] = row;
  save();
  persist(phaseDir, 'run.log', `start ${phase} home=${home}`);
  runDsh(node, binPath(), home, {
    shim: join(output, 'shim'),
    pnpmHome: join(output, 'pnpmHome'),
    store: join(output, 'store'),
    cache: join(output, 'cache'),
  }, ['--profile', 'web', '--dump-config'], SEED_MS, `${phase} seed web`, join(phaseDir, 'seed.log'));
  const ctx = { home, artifacts, env, phaseDir, tools, snapshots, markerDir, httpOnly };
  try {
    if (phase === 'upgrade-throw') await phaseUpgradeThrow(ctx, row, pass);
    else if (phase === 'restore-kill') await phaseRestoreKill(ctx, row, pass);
    else if (phase === 'upgrade-kill') await phaseUpgradeKill(ctx, row, pass);
    else throw new Error(`unknown phase ${phase}`);
    row.status = 'pass';
    row.finishedAt = new Date().toISOString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    row.status = error?.blocked || /^blocked:/.test(message) ? 'blocked' : 'fail';
    row.error = redact(error instanceof Error ? error.stack : error);
    row.finishedAt = new Date().toISOString();
    throw error;
  } finally {
    row.leftoverInstances = listInstanceRecords(home).filter(item => item.alive === 'alive');
    if (row.leftoverInstances.length) {
      persist(phaseDir, 'run.log', `leftover-alive-instances ${JSON.stringify(row.leftoverInstances.map(item => ({ id: item.id, pid: item.body?.pid })))} not killed`);
    }
    save();
  }
}

async function phaseUpgradeThrow(ctx, row, pass) {
  row.kind = 'runtime.upgrade commit:swap throw; CoordinatedUpgrade in-process rollback';
  row.restoreEntry = 'fault-driver (source seam); packed supervisor not used for this live rollback';
  const session = await launchFaultSupervisor({
    ...ctx,
    inject: { upgradeHook: 'commit:swap', upgradeAction: 'throw' },
  });
  row.origin = session.origin;
  try {
    await seedOrdinary(session);
    writeMarkers(session.home, 'before-upgrade\n');
    const before = snapshotState(session.home, session.tools, 'before-upgrade');
    row.before = before;
    const ordinaryBefore = (await session.api('state')).spaces.find(space => space.id === SPACE);
    assert.equal(ordinaryBefore?.status, 'running');
    const upgraded = await executePlan(session, { kind: 'runtime.upgrade', version: COMPATIBLE }, {
      timeout: RUNTIME_MS,
      label: 'runtime.upgrade commit:swap throw',
      expect: 'failed',
    });
    row.job = { id: upgraded.job.id, status: upgraded.job.status, phase: upgraded.job.phase, error: upgraded.job.error };
    row.plan = { id: upgraded.plan.id, kind: upgraded.plan.kind };
    const marker = readJsonIfPresent(join(ctx.markerDir, 'fault-marker.json'));
    assert.equal(marker?.kind, 'upgrade');
    assert.equal(marker?.op, 'commit:swap');
    assert.equal(marker?.action, 'throw');
    assert.equal(marker?.pid, session.supervisor.pid);
    row.marker = marker;
    const after = snapshotState(session.home, session.tools, 'after-rollback');
    row.after = after;
    assert.equal(after.hash, before.hash, 'managed data hash changed after CoordinatedUpgrade rollback');
    assert.equal(after.markers.hub, 'before-upgrade\n');
    assert.equal(after.displayName, before.displayName);
    if (before.runtime.present || after.runtime.present) {
      assert.equal(after.runtime.sha256, before.runtime.sha256, 'runtime current.json changed after rollback');
    }
    assert.equal(existsSync(join(session.home, '.dsh-spaces-upgrade', 'journal.json')), false, 'upgrade journal survived rollback');
    const state = await session.api('state');
    const ordinary = state.spaces.find(space => space.id === SPACE);
    const manager = state.spaces.find(space => space.id === state.managerId);
    assert.equal(ordinary?.status, 'stopped', 'ordinary spaces must not be auto-restarted after upgrade rollback');
    assert.equal(manager?.status, 'running', 'manager must be available after consistent rollback');
    await assertStableEntry(session);
    row.evidence = copyEvidence(session.home, session.snapshots, join(ctx.phaseDir, 'evidence-after'));
    row.observations = session.observations;
    pass('upgrade-throw: commit:swap inject rolled back original hash/runtime; manager running; ordinary stopped');
  } finally {
    await shutdownOwned(session, 'upgrade-throw');
  }
}

async function phaseRestoreKill(ctx, row, pass) {
  row.kind = 'snapshot.restore restore:swap SIGKILL of owned supervisor; packed supervisor/doctor recover';
  row.restoreEntry = 'packed supervisor recovery.resume, doctor recover fallback';
  let session = await launchFaultSupervisor({
    ...ctx,
    inject: { snapshotHook: 'restore:swap', snapshotAction: 'kill' },
  });
  row.origin = session.origin;
  let jobId;
  try {
    await seedOrdinary(session);
    writeMarkers(session.home, 'snapshot-original\n');
    const original = snapshotState(session.home, session.tools, 'snapshot-original');
    const created = await executePlan(session, { kind: 'snapshot.create' }, { timeout: JOB_MS, label: 'snapshot.create' });
    const snapshotId = created.job.result?.snapshotId;
    assert.equal(typeof snapshotId, 'string');
    row.snapshotId = snapshotId;
    await submitJob(session, { kind: 'space.update', spaceId: SPACE, displayName: '已改名' });
    writeMarkers(session.home, 'after-change\n');
    const changed = snapshotState(session.home, session.tools, 'after-change');
    assert.notEqual(changed.hash, original.hash, 'post-snapshot change did not distinguish hashes');
    row.original = original;
    row.changed = changed;
    const plan = await session.api('preview', { request: { kind: 'snapshot.restore', snapshotId } });
    row.plan = { id: plan.id, kind: plan.kind };
    const submitted = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, {
      timeout: JOB_MS,
      label: 'snapshot.restore restore:swap kill',
      expect: 'supervisor-exit',
    });
    jobId = submitted.job?.id;
    row.killedJob = { id: jobId, lastStatus: submitted.job?.status, lastPhase: submitted.job?.phase };
    row.supervisorExit = submitted.death;
    const marker = readJsonIfPresent(join(ctx.markerDir, 'fault-marker.json'));
    assert.equal(marker?.kind, 'snapshot');
    assert.equal(marker?.op, 'restore:swap');
    assert.equal(marker?.action, 'kill');
    assert.equal(marker?.pid, session.supervisor.pid);
    row.marker = marker;
    row.crashEvidence = copyEvidence(session.home, session.snapshots, join(ctx.phaseDir, 'evidence-crash'));
    row.crashHash = hashManaged(session.home);
    persist(ctx.phaseDir, 'run.log', `supervisor-exit code=${submitted.death.exitCode} signal=${submitted.death.signal} pid=${submitted.death.pid}`);
  } finally {
    await session.browser?.close().catch(() => {});
    if (session.supervisor.exitCode === null) await stopOwned(session.supervisor);
    writeFileSync(join(ctx.phaseDir, 'restore-kill-driver.log'), redact(`${session.launchOutput()}\n${session.stderr()}`));
  }

  return recoverRestoreKill(ctx, row, pass, jobId);
}

async function recoverRestoreKill(ctx, row, pass, jobId) {
  let packed;
  try {
    packed = await launchPackedSupervisor(ctx);
    row.packedOrigin = packed.origin;
    await acquireRecoveryController(packed);
    const state = await packed.api('state');
    row.coldRestart = {
      recoveryRequired: state.recoveryRequired,
      reasons: state.reasons,
      writable: state.writable,
      jobs: state.jobs,
    };
    assert.equal(state.recoveryRequired, true, 'cold packed restart must enter recovery mode');
    const jobs = Array.isArray(row.coldRestart.jobs) ? row.coldRestart.jobs : [];
    const interrupted = jobs.find(item => item.id === jobId);
    assert.ok(interrupted, 'interrupted restore job missing after cold restart');
    assert.equal(interrupted.status, 'recovery-required');
    row.interruptedJob = interrupted;
    await assertStableEntry(packed);
    pass('restore-kill: packed supervisor cold start is recovery-required; original job not settled; entry up');

    let recoveredBy = 'recovery.resume';
    try {
      await submitJob(packed, { kind: 'recovery.resume' }, { timeout: RECOVERY_MS, label: 'recovery.resume', expect: 'succeeded' });
    } catch (error) {
      recoveredBy = 'doctor';
      row.resumeError = redact(error instanceof Error ? error.message : error);
      persist(ctx.phaseDir, 'run.log', `recovery.resume failed, falling back to doctor: ${row.resumeError}`);
      await shutdownOwned(packed, 'restore-kill-packed-before-doctor');
      packed = undefined;
      row.doctor = runDoctorRecover(ctx);
      packed = await launchPackedSupervisor(ctx);
    }
    const afterState = await packed.api('state');
    await assertStableEntry(packed);
    const after = snapshotState(packed.home, packed.tools, 'after-recover');
    row.after = after;
    row.recoveredBy = recoveredBy;
    row.evidenceAfter = copyEvidence(packed.home, packed.snapshots, join(ctx.phaseDir, 'evidence-after'));
    assert.equal(after.hash, row.changed.hash, 'incomplete restore:swap kill must roll live data back to the pre-restore changed hash, not invent snapshot bytes');
    assert.equal(after.markers.hub, 'after-change\n');
    const jobsAfter = (await packed.api('state')).jobs;
    const interruptedAfter = jobsAfter.find(item => item.id === interrupted.id);
    row.jobsAfter = jobsAfter.map(item => ({ id: item.id, status: item.status, kind: item.kind, phase: item.phase }));
    row.entryAfter = { recoveryRequired: afterState.recoveryRequired, manager: afterState.spaces.find(space => space.id === afterState.managerId)?.status };
    assertProvedRollbackSettlement(interruptedAfter, afterState);
    pass(`restore-kill: recovered via ${recoveredBy}; pre-restore hash kept; interrupted job settled with a proved rollback receipt; entry queryable`);
  } finally {
    await shutdownOwned(packed, 'restore-kill-final');
  }
}

async function phaseUpgradeKill(ctx, row, pass) {
  row.kind = 'runtime.upgrade commit:retarget SIGKILL of owned supervisor; packed supervisor/doctor recover';
  row.restoreEntry = 'packed supervisor recovery.resume, doctor recover fallback';
  let session = await launchFaultSupervisor({
    ...ctx,
    inject: { upgradeHook: 'commit:retarget', upgradeAction: 'kill' },
  });
  row.origin = session.origin;
  let jobId;
  try {
    await seedOrdinary(session);
    writeMarkers(session.home, 'before-upgrade-kill\n');
    const before = snapshotState(session.home, session.tools, 'before-upgrade-kill');
    row.before = before;
    const plan = await session.api('preview', { request: { kind: 'runtime.upgrade', version: COMPATIBLE } });
    row.plan = { id: plan.id, kind: plan.kind };
    const submitted = await submitJob(session, { kind: 'plan.execute', planId: plan.id }, {
      timeout: RUNTIME_MS,
      label: 'runtime.upgrade commit:retarget kill',
      expect: 'supervisor-exit',
    });
    jobId = submitted.job?.id;
    row.killedJob = { id: jobId, lastStatus: submitted.job?.status, lastPhase: submitted.job?.phase };
    row.supervisorExit = submitted.death;
    const marker = readJsonIfPresent(join(ctx.markerDir, 'fault-marker.json'));
    assert.equal(marker?.kind, 'upgrade');
    assert.equal(marker?.op, 'commit:retarget');
    assert.equal(marker?.action, 'kill');
    row.marker = marker;
    row.crashEvidence = copyEvidence(session.home, session.snapshots, join(ctx.phaseDir, 'evidence-crash'));
    persist(ctx.phaseDir, 'run.log', `supervisor-exit code=${submitted.death.exitCode} signal=${submitted.death.signal}`);
  } finally {
    await session.browser?.close().catch(() => {});
    if (session.supervisor.exitCode === null) await stopOwned(session.supervisor);
    writeFileSync(join(ctx.phaseDir, 'upgrade-kill-driver.log'), redact(`${session.launchOutput()}\n${session.stderr()}`));
  }

  let packed;
  try {
    packed = await launchPackedSupervisor(ctx);
    await acquireRecoveryController(packed);
    const state = await packed.api('state');
    row.coldRestart = { recoveryRequired: state.recoveryRequired, reasons: state.reasons };
    assert.equal(state.recoveryRequired, true);
    const jobs = state.jobs;
    const interrupted = jobs.find(item => item.id === jobId) || jobs.find(item => item.status === 'recovery-required');
    assert.ok(interrupted);
    assert.equal(interrupted.status, 'recovery-required');
    row.interruptedJob = interrupted;
    await assertStableEntry(packed);
    let recoveredBy = 'recovery.resume';
    try {
      await submitJob(packed, { kind: 'recovery.resume' }, { timeout: RECOVERY_MS, label: 'recovery.resume', expect: 'succeeded' });
    } catch (error) {
      recoveredBy = 'doctor';
      row.resumeError = redact(error instanceof Error ? error.message : error);
      await shutdownOwned(packed, 'upgrade-kill-packed-before-doctor');
      packed = undefined;
      row.doctor = runDoctorRecover(ctx);
      packed = await launchPackedSupervisor(ctx);
    }
    const after = snapshotState(packed.home, packed.tools, 'after-recover');
    row.after = after;
    row.recoveredBy = recoveredBy;
    row.evidenceAfter = copyEvidence(packed.home, packed.snapshots, join(ctx.phaseDir, 'evidence-after'));
    assert.equal(after.hash, row.before.hash, 'upgrade commit:retarget kill must restore original managed data');
    assert.equal(after.markers.hub, 'before-upgrade-kill\n');
    if (row.before.runtime.present || after.runtime.present) {
      assert.equal(after.runtime.sha256, row.before.runtime.sha256, 'runtime pointer must match original after upgrade rollback');
    }
    const jobsAfter = (await packed.api('state')).jobs;
    const interruptedAfter = jobsAfter.find(item => item.id === interrupted.id);
    row.jobsAfter = jobsAfter.map(item => ({ id: item.id, status: item.status, kind: item.kind, phase: item.phase }));
    const live = await packed.api('state');
    assertProvedRollbackSettlement(interruptedAfter, live);
    await assertStableEntry(packed);
    const ordinary = live.spaces.find(space => space.id === SPACE);
    assert.equal(ordinary?.status, 'stopped', 'ordinary spaces must not all restart after recovery');
    pass(`upgrade-kill: recovered via ${recoveredBy}; original hash/runtime; interrupted job settled with a proved rollback receipt; entry up`);
  } finally {
    await shutdownOwned(packed, 'upgrade-kill-final');
  }
}

function runDoctorRecover(ctx) {
  const result = spawnSync(node, [
    DOCTOR, 'recover',
    '--home', ctx.home,
    '--cli', binPath(),
    '--snapshot-root', ctx.snapshots,
    '--runtime-root', ctx.tools,
  ], {
    cwd: root,
    env: ctx.env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: RECOVERY_MS,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  writeFileSync(join(ctx.phaseDir, 'doctor-recover.log'), redact(`${stdout}\n${stderr}\nexit=${result.status} signal=${result.signal}`));
  let body;
  try {
    body = JSON.parse(stdout.trim().split(/\n/).filter(Boolean).at(-1) || '{}');
  } catch {
    body = { parseError: true, stdout: redact(stdout.slice(0, 2000)) };
  }
  return {
    exitCode: result.status,
    signal: result.signal,
    body,
  };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch(error => {
    console.error(`FAIL ${redact(error instanceof Error ? error.message : error)}`);
    process.exitCode = 1;
  });
}
