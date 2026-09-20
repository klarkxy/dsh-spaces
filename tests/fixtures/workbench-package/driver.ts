/**
 * Source-seam workbench supervisor for package-upgrade acceptance.
 * Not a packed product entry. Failure injection is this driver's pluginAdd
 * wrap only; it is not a packed-supervisor / packed-product fault.
 *
 * Isolated Home only. Allowed roots:
 *   <repo>/.sandbox/workbench-package-acceptance
 *   <repo>/.sandbox/workbench-maintenance-network-acceptance
 * --allow-real-home is refused. Production ~/.dsh is refused.
 *
 *   node --import tsx tests/fixtures/workbench-package/driver.ts --home DIR --bin CLI [flags]
 *   node --import tsx tests/fixtures/workbench-package/driver.ts --self-check
 *
 * --fault-digest-bridge-add wraps options.pluginAdd, calls the real pluginAdd,
 * then throws only on the digest-named view-bridge archive (the second add of
 * a workbench package upgrade). Manager bootstrap uses dsh-spaces-plugin.tgz /
 * dsh-spaces-view-bridge.tgz (no content digest) and is not injected.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotRealHome } from "../../../src/adapters/node/home-guard.ts";
import { pluginAdd as defaultPluginAdd } from "../../../src/adapters/node/plugin-ops.ts";
import { createWorkbenchSupervisor } from "../../../src/adapters/node/workbench-supervisor.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const ALLOWED_HOME_ROOTS = [
  resolve(root, ".sandbox/workbench-package-acceptance"),
  resolve(root, ".sandbox/workbench-maintenance-network-acceptance"),
];
const DIGEST_BRIDGE_RE = /^dsh-spaces-view-bridge-[0-9a-f]{32}\.tgz$/i;
const DIGEST_PLUGIN_RE = /^dsh-spaces-plugin-[0-9a-f]{32}\.tgz$/i;

export type PackageDriverFlags = {
  selfCheck?: boolean;
  faultDigestBridgeAdd?: boolean;
  home?: string;
  bin?: string;
  nodeExe?: string;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  snapshotWorkerFile?: string;
  controlToolRoot?: string;
  snapshotRoot?: string;
  runtimeRoot?: string;
  markerDir?: string;
  port?: number;
};

export function parsePackageDriverArgs(argv: string[]): PackageDriverFlags {
  const flags: PackageDriverFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--self-check") {
      flags.selfCheck = true;
      continue;
    }
    if (token === "--fault-digest-bridge-add") {
      flags.faultDigestBridgeAdd = true;
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
    const pathFlag: Record<string, keyof PackageDriverFlags> = {
      "--home": "home",
      "--bin": "bin",
      "--cli": "bin",
      "--node": "nodeExe",
      "--plugin-artifact": "pluginArtifact",
      "--view-bridge-artifact": "viewBridgeArtifact",
      "--snapshot-worker": "snapshotWorkerFile",
      "--control-tool-root": "controlToolRoot",
      "--snapshot-root": "snapshotRoot",
      "--runtime-root": "runtimeRoot",
      "--marker-dir": "markerDir",
    };
    if (name === "--port") {
      flags.port = Number(take());
      continue;
    }
    if (pathFlag[name]) {
      (flags as Record<string, unknown>)[pathFlag[name]] = requirePath(take(), name);
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

function insideDir(rootDir: string, target: string): boolean {
  const rel = relative(resolve(rootDir), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

function assertAllowedHome(home: string): void {
  refuseProductionHome(home);
  const resolved = resolve(home);
  if (!ALLOWED_HOME_ROOTS.some((allowed) => insideDir(allowed, resolved))) {
    throw new Error("this driver only accepts this script isolated Home");
  }
}

function writeMarker(markerDir: string | undefined, payload: Record<string, unknown>): void {
  if (!markerDir) throw new Error("marker-dir is required when the pluginAdd fault fires");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, "fault-marker.json"), `${JSON.stringify(payload, null, 2)}\n`);
  appendFileSync(join(markerDir, "fault-marker.jsonl"), `${JSON.stringify(payload)}\n`);
}

function archiveName(spec: string): string {
  return basename(spec.replaceAll("\\", "/"));
}

function wrapPluginAdd(flags: PackageDriverFlags): typeof defaultPluginAdd {
  return async (home, profile, spec) => {
    const name = archiveName(spec);
    const digestPlugin = DIGEST_PLUGIN_RE.test(name);
    const digestBridge = DIGEST_BRIDGE_RE.test(name);
    if (flags.faultDigestBridgeAdd && digestBridge) {
      const pluginRoot = join(home, "profiles", profile, "node_modules", "@dsh-spaces", "plugin");
      const firstInstalled = existsSync(join(pluginRoot, "lib", "index.js")) &&
        existsSync(join(pluginRoot, "package.json"));
      writeMarker(flags.markerDir, {
        kind: "pluginAdd",
        seam: "source-test-seam",
        notPackedProduct: true,
        archive: name,
        profile,
        digestPlugin,
        digestBridge,
        firstPackageInstalled: firstInstalled,
        pid: process.pid,
        at: new Date().toISOString(),
      });
      if (!firstInstalled) {
        throw new Error("fault inject digest-named view-bridge pluginAdd: first package was not installed");
      }
      throw new Error("fault inject digest-named view-bridge pluginAdd");
    }
    await defaultPluginAdd(home, profile, spec);
  };
}

export async function startPackageDriver(flags: PackageDriverFlags) {
  if (!flags.home) throw new Error("--home is required");
  assertAllowedHome(flags.home);
  if (typeof createWorkbenchSupervisor !== "function") throw new Error("createWorkbenchSupervisor missing");
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
    runtimeRoot: flags.runtimeRoot,
    pluginAdd: flags.faultDigestBridgeAdd ? wrapPluginAdd(flags) : undefined,
  });
}

export async function selfCheck(): Promise<void> {
  delete process.env.DSH_SPACES_ALLOW_REAL_HOME;
  delete process.env.DSH_SPACES_PACKAGED;
  if (typeof createWorkbenchSupervisor !== "function") throw new Error("createWorkbenchSupervisor is not a function");
  if (typeof defaultPluginAdd !== "function") throw new Error("pluginAdd is not a function");
  let refusedFlag = false;
  try {
    parsePackageDriverArgs(["--allow-real-home"]);
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
  let refusedOutside = false;
  try {
    assertAllowedHome(resolve(root, ".sandbox", "someone-else-home"));
  } catch (error) {
    refusedOutside = /this script isolated Home/i.test(error instanceof Error ? error.message : String(error));
  }
  if (!refusedOutside) throw new Error("driver must refuse Homes outside this script's sandbox");
  let refusedRelative = false;
  try {
    parsePackageDriverArgs(["--home", "relative/home"]);
  } catch (error) {
    refusedRelative = /must be an absolute path/i.test(error instanceof Error ? error.message : String(error));
  }
  if (!refusedRelative) throw new Error("driver must require absolute --home");
  process.stdout.write("package-driver-self-check=ok\n");
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parsePackageDriverArgs(argv);
  if (flags.selfCheck) {
    await selfCheck();
    return 0;
  }
  if (!flags.home || !flags.bin) throw new Error("--home and --bin are required");
  if (!flags.snapshotWorkerFile) throw new Error("--snapshot-worker is required for the package driver");
  if (!flags.pluginArtifact || !flags.viewBridgeArtifact) {
    throw new Error("--plugin-artifact and --view-bridge-artifact are required");
  }
  if (flags.faultDigestBridgeAdd && !flags.markerDir) {
    throw new Error("--marker-dir is required with --fault-digest-bridge-add");
  }
  assertAllowedHome(flags.home);
  const handle = await startPackageDriver(flags);
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
      const message = error instanceof Error ? error.message : "package driver failed";
      process.stderr.write(`${message.replace(/([?&]token=)[^\s&]+/gi, "$1[redacted]")}\n`);
      process.exit(1);
    },
  );
}
