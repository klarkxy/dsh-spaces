#!/usr/bin/env node
/**
 * Source-seam workbench supervisor for maintenance-fault acceptance.
 * Not a packed product entry. Sets CoordinatedUpgrade.opts.inject in
 * createMaintenance and points SnapshotExecutor at the test-only worker.
 *
 *   node --import tsx scripts/workbench-fault-supervisor.mjs --home DIR --bin CLI [flags]
 *   node --import tsx scripts/workbench-fault-supervisor.mjs --self-check
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export function parseFaultSupervisorArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--self-check') {
      flags.selfCheck = true;
      continue;
    }
    if (token === '--allow-real-home') {
      flags.allowRealHome = true;
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
    const pathFlag = {
      '--home': 'home',
      '--bin': 'bin',
      '--cli': 'bin',
      '--node': 'nodeExe',
      '--plugin-artifact': 'pluginArtifact',
      '--view-bridge-artifact': 'viewBridgeArtifact',
      '--snapshot-worker': 'snapshotWorkerFile',
      '--control-tool-root': 'controlToolRoot',
      '--snapshot-root': 'snapshotRoot',
      '--marker-dir': 'markerDir',
    };
    const textFlag = {
      '--upgrade-hook': 'upgradeHook',
      '--upgrade-action': 'upgradeAction',
      '--snapshot-hook': 'snapshotHook',
      '--snapshot-action': 'snapshotAction',
    };
    if (name === '--port') {
      flags.port = Number(take());
      continue;
    }
    if (pathFlag[name]) {
      flags[pathFlag[name]] = requirePath(take(), name);
      continue;
    }
    if (textFlag[name]) {
      flags[textFlag[name]] = take();
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return flags;
}

function requirePath(value, flag) {
  if (!value || !isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}

function writeMarker(markerDir, payload) {
  if (!markerDir) throw new Error('marker-dir is required when an upgrade hook fires');
  mkdirSync(markerDir, { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(join(markerDir, 'fault-marker.json'), body);
  appendFileSync(join(markerDir, 'fault-marker.jsonl'), `${JSON.stringify(payload)}\n`);
}

function attachUpgradeInject(upgrades, flags) {
  const hook = String(flags.upgradeHook ?? '').trim();
  if (!hook) return;
  const action = String(flags.upgradeAction ?? 'throw').trim();
  if (!upgrades || typeof upgrades !== 'object') throw new Error('ports.upgrades missing');
  const opts = upgrades.opts;
  if (!opts || typeof opts !== 'object') {
    throw new Error('CoordinatedUpgrade.opts missing; the documented test seam is unavailable');
  }
  opts.inject = (op) => {
    if (op !== hook) return;
    writeMarker(flags.markerDir, {
      kind: 'upgrade',
      op,
      pid: process.pid,
      action,
      at: new Date().toISOString(),
    });
    if (action === 'kill') process.kill(process.pid, 'SIGKILL');
    throw new Error(`fault inject ${op}`);
  };
}

export async function startFaultSupervisor(flags) {
  const [{ createWorkbenchSupervisor }, { WorkbenchMaintenance }] = await Promise.all([
    import('../src/adapters/node/workbench-supervisor.ts'),
    import('../src/adapters/node/workbench-maintenance.ts'),
  ]);
  if (typeof createWorkbenchSupervisor !== 'function') throw new Error('createWorkbenchSupervisor missing');
  if (typeof WorkbenchMaintenance !== 'function') throw new Error('WorkbenchMaintenance missing');
  if (flags.snapshotHook) process.env.DSH_FAULT_SNAPSHOT_HOOK = flags.snapshotHook;
  else delete process.env.DSH_FAULT_SNAPSHOT_HOOK;
  if (flags.snapshotAction) process.env.DSH_FAULT_SNAPSHOT_ACTION = flags.snapshotAction;
  else delete process.env.DSH_FAULT_SNAPSHOT_ACTION;
  if (flags.markerDir) process.env.DSH_FAULT_MARKER_DIR = flags.markerDir;
  const handle = await createWorkbenchSupervisor({
    home: flags.home,
    bin: flags.bin,
    nodeExe: flags.nodeExe,
    port: Number.isInteger(flags.port) ? flags.port : 0,
    pluginArtifact: flags.pluginArtifact,
    viewBridgeArtifact: flags.viewBridgeArtifact,
    snapshotWorkerFile: flags.snapshotWorkerFile,
    snapshotRoot: flags.snapshotRoot,
    controlToolRoot: flags.controlToolRoot,
    allowRealHome: flags.allowRealHome === true,
    createMaintenance: (ports) => {
      attachUpgradeInject(ports.upgrades, flags);
      return new WorkbenchMaintenance(ports, {
        log: (operation, error) => {
          const detail = String(error instanceof Error ? error.message : error ?? '').slice(0, 4000);
          try {
            appendFileSync(
              join(flags.home, '.dsh-spaces-control', 'maintenance-errors.jsonl'),
              `${JSON.stringify({ at: new Date().toISOString(), operation, detail })}\n`,
              { encoding: 'utf8', mode: 0o600 },
            );
          } catch {
            /* keep going; supervisor recovery handles persist failure */
          }
        },
      });
    },
  });
  return handle;
}

export async function selfCheck() {
  const [{ createWorkbenchSupervisor }, { WorkbenchMaintenance }] = await Promise.all([
    import('../src/adapters/node/workbench-supervisor.ts'),
    import('../src/adapters/node/workbench-maintenance.ts'),
  ]);
  if (typeof createWorkbenchSupervisor !== 'function') throw new Error('createWorkbenchSupervisor is not a function');
  if (typeof WorkbenchMaintenance !== 'function') throw new Error('WorkbenchMaintenance is not a function');
  const worker = join(root, 'scripts/workbench-fault-snapshot-worker.ts');
  if (!existsSync(worker)) throw new Error('fault snapshot worker source missing');
  process.stdout.write('fault-supervisor-self-check=ok\n');
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseFaultSupervisorArgs(argv);
  if (flags.selfCheck) {
    await selfCheck();
    return 0;
  }
  if (!flags.home || !flags.bin) throw new Error('--home and --bin are required');
  if (!flags.snapshotWorkerFile) throw new Error('--snapshot-worker is required for the fault driver');
  const handle = await startFaultSupervisor(flags);
  process.stdout.write(`origin=${handle.origin}\n`);
  process.stdout.write(`bootstrap=${handle.bootstrapUrl}\n`);
  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await new Promise(() => undefined);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : 'fault supervisor failed';
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
