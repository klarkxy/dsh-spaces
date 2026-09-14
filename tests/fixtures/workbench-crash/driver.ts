/**
 * Source-seam workbench supervisor for crash acceptance.
 * Not a packed product entry. Isolated Home only; --allow-real-home is refused.
 *
 *   node --import tsx tests/fixtures/workbench-crash/driver.ts --home DIR --bin CLI [flags]
 *   node --import tsx tests/fixtures/workbench-crash/driver.ts --self-check
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotRealHome } from "../../../src/main/home-guard.ts";
import { createWorkbenchSupervisor } from "../../../src/adapters/node/workbench-supervisor.ts";
import { WorkbenchMaintenance } from "../../../src/adapters/node/workbench-maintenance.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const WORKER = join(root, "tests/fixtures/workbench-crash/snapshot-worker.ts");

export type CrashDriverFlags = {
  selfCheck?: boolean;
  home?: string;
  bin?: string;
  nodeExe?: string;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  snapshotWorkerFile?: string;
  controlToolRoot?: string;
  snapshotRoot?: string;
  markerDir?: string;
  upgradeHook?: string;
  upgradeAction?: string;
  snapshotHook?: string;
  snapshotAction?: string;
  port?: number;
};

export function parseCrashDriverArgs(argv: string[]): CrashDriverFlags {
  const flags: CrashDriverFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--self-check") {
      flags.selfCheck = true;
      continue;
    }
    if (token === "--allow-real-home" || token.startsWith("--allow-real-home=")) {
      throw new Error("isolated Home only; --allow-real-home is refused");
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const take = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new Error(`missing value for ${name}`);
      i += 1;
      return next;
    };
    const pathFlag: Record<string, keyof CrashDriverFlags> = {
      "--home": "home",
      "--bin": "bin",
      "--cli": "bin",
      "--node": "nodeExe",
      "--plugin-artifact": "pluginArtifact",
      "--view-bridge-artifact": "viewBridgeArtifact",
      "--snapshot-worker": "snapshotWorkerFile",
      "--control-tool-root": "controlToolRoot",
      "--snapshot-root": "snapshotRoot",
      "--marker-dir": "markerDir",
    };
    const textFlag: Record<string, keyof CrashDriverFlags> = {
      "--upgrade-hook": "upgradeHook",
      "--upgrade-action": "upgradeAction",
      "--snapshot-hook": "snapshotHook",
      "--snapshot-action": "snapshotAction",
    };
    if (name === "--port") {
      flags.port = Number(take());
      continue;
    }
    if (pathFlag[name]) {
      (flags as Record<string, unknown>)[pathFlag[name]] = requirePath(take(), name);
      continue;
    }
    if (textFlag[name]) {
      (flags as Record<string, unknown>)[textFlag[name]] = take();
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return flags;
}

function requirePath(value: string, flag: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}

function refuseProductionHome(home: string): void {
  delete process.env.DSH_SPACES_ALLOW_REAL_HOME;
  delete process.env.DSH_SPACES_PACKAGED;
  try {
    assertNotRealHome(home);
  } catch {
    throw new Error("refusing production Home; this driver only accepts an isolated Home");
  }
}

function writeMarker(markerDir: string | undefined, payload: Record<string, unknown>): void {
  if (!markerDir) throw new Error("marker-dir is required when an upgrade hook fires");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, "fault-marker.json"), `${JSON.stringify(payload, null, 2)}\n`);
  appendFileSync(join(markerDir, "fault-marker.jsonl"), `${JSON.stringify(payload)}\n`);
}

function attachUpgradeInject(
  upgrades: { opts?: { inject?: (op: string) => void } },
  flags: CrashDriverFlags,
): void {
  const hook = String(flags.upgradeHook ?? "").trim();
  if (!hook) return;
  const action = String(flags.upgradeAction ?? "throw").trim();
  if (!upgrades || typeof upgrades !== "object") throw new Error("ports.upgrades missing");
  const opts = upgrades.opts;
  if (!opts || typeof opts !== "object") {
    throw new Error("CoordinatedUpgrade.opts missing; the documented test seam is unavailable");
  }
  opts.inject = (op: string) => {
    if (op !== hook) return;
    writeMarker(flags.markerDir, {
      kind: "upgrade",
      op,
      pid: process.pid,
      action,
      at: new Date().toISOString(),
    });
    if (action === "kill") process.kill(process.pid, "SIGKILL");
    throw new Error(`fault inject ${op}`);
  };
}

export async function startCrashDriver(flags: CrashDriverFlags) {
  if (!flags.home) throw new Error("--home is required");
  refuseProductionHome(flags.home);
  if (typeof createWorkbenchSupervisor !== "function") throw new Error("createWorkbenchSupervisor missing");
  if (typeof WorkbenchMaintenance !== "function") throw new Error("WorkbenchMaintenance missing");
  if (flags.snapshotHook) process.env.DSH_FAULT_SNAPSHOT_HOOK = flags.snapshotHook;
  else delete process.env.DSH_FAULT_SNAPSHOT_HOOK;
  if (flags.snapshotAction) process.env.DSH_FAULT_SNAPSHOT_ACTION = flags.snapshotAction;
  else delete process.env.DSH_FAULT_SNAPSHOT_ACTION;
  if (flags.markerDir) process.env.DSH_FAULT_MARKER_DIR = flags.markerDir;
  return createWorkbenchSupervisor({
    home: flags.home,
    bin: flags.bin!,
    nodeExe: flags.nodeExe,
    port: Number.isInteger(flags.port) ? flags.port : 0,
    pluginArtifact: flags.pluginArtifact,
    viewBridgeArtifact: flags.viewBridgeArtifact,
    snapshotWorkerFile: flags.snapshotWorkerFile,
    snapshotRoot: flags.snapshotRoot,
    controlToolRoot: flags.controlToolRoot,
    createMaintenance: (ports) => {
      attachUpgradeInject(ports.upgrades as { opts?: { inject?: (op: string) => void } }, flags);
      return new WorkbenchMaintenance(ports, {
        log: (operation, error) => {
          const detail = String(error instanceof Error ? error.message : error ?? "").slice(0, 4000);
          try {
            appendFileSync(
              join(flags.home!, ".dsh-spaces-control", "maintenance-errors.jsonl"),
              `${JSON.stringify({ at: new Date().toISOString(), operation, detail })}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
          } catch {
            /* supervisor recovery handles persist failure */
          }
        },
      });
    },
  });
}

export async function selfCheck(): Promise<void> {
  delete process.env.DSH_SPACES_ALLOW_REAL_HOME;
  delete process.env.DSH_SPACES_PACKAGED;
  if (typeof createWorkbenchSupervisor !== "function") throw new Error("createWorkbenchSupervisor is not a function");
  if (typeof WorkbenchMaintenance !== "function") throw new Error("WorkbenchMaintenance is not a function");
  if (!existsSync(WORKER)) throw new Error("crash snapshot worker source missing");
  let refusedFlag = false;
  try {
    parseCrashDriverArgs(["--allow-real-home"]);
  } catch (error) {
    refusedFlag = /isolated Home only/i.test(error instanceof Error ? error.message : String(error));
  }
  if (!refusedFlag) throw new Error("driver must refuse --allow-real-home");
  let refusedHome = false;
  try {
    refuseProductionHome(join(homedir(), ".dsh"));
  } catch (error) {
    refusedHome = /refusing production Home/i.test(error instanceof Error ? error.message : String(error));
  }
  if (!refusedHome) throw new Error("driver must refuse the production Home");
  process.stdout.write("crash-driver-self-check=ok\n");
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseCrashDriverArgs(argv);
  if (flags.selfCheck) {
    await selfCheck();
    return 0;
  }
  if (!flags.home || !flags.bin) throw new Error("--home and --bin are required");
  if (!flags.snapshotWorkerFile) throw new Error("--snapshot-worker is required for the crash driver");
  refuseProductionHome(flags.home);
  const handle = await startCrashDriver(flags);
  process.stdout.write(`origin=${handle.origin}\n`);
  process.stdout.write(`bootstrap=${handle.bootstrapUrl}\n`);
  const stop = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => undefined);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : "crash driver failed";
      process.stderr.write(`${message.replace(/([?&]token=)[^\s&]+/gi, "$1[redacted]")}\n`);
      process.exit(1);
    },
  );
}
