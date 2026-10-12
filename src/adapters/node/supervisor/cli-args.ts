import { isAbsolute, resolve } from "node:path";
import { WorkbenchPublicError } from "./errors";
import type { SupervisorCliOptions } from "./types";

export function parseSupervisorArgs(argv: string[]): SupervisorCliOptions {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--allow-real-home") { flags.allowRealHome = "1"; continue; }
    const mapped = flagName(token);
    if (!mapped) throw new WorkbenchPublicError("workbench/invalid-input", `Unknown flag: ${token}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) {
      throw new WorkbenchPublicError("workbench/invalid-input", `Missing value for ${token}`);
    }
    flags[mapped] = value;
    i += 1;
  }
  const home = requirePath(flags.home, "--home");
  const binFlag = flags.bin ? "--bin" : flags.cli ? "--cli" : "--bin";
  const bin = requirePath(flags.bin ?? flags.cli, binFlag);
  const options: SupervisorCliOptions = { home, bin };
  if (flags.allowRealHome === "1") options.allowRealHome = true;
  if (flags.node) options.nodeExe = requirePath(flags.node, "--node");
  if (flags.port) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new WorkbenchPublicError("workbench/invalid-input", "Port must be an integer 0-65535.");
    }
    options.port = port;
  }
  if (flags["control-tool-root"]) options.controlToolRoot = requirePath(flags["control-tool-root"], "--control-tool-root");
  if (flags["supervisor-asset-root"]) {
    options.supervisorAssetRoot = requirePath(flags["supervisor-asset-root"], "--supervisor-asset-root");
  }
  if (flags["plugin-artifact"]) options.pluginArtifact = requirePath(flags["plugin-artifact"], "--plugin-artifact");
  if (flags["view-bridge-artifact"]) {
    options.viewBridgeArtifact = requirePath(flags["view-bridge-artifact"], "--view-bridge-artifact");
  }
  if (flags["llm-bridge-artifact"]) {
    options.llmBridgeArtifact = requirePath(flags["llm-bridge-artifact"], "--llm-bridge-artifact");
  }
  if (flags["browser-artifact"]) {
    options.browserArtifact = requirePath(flags["browser-artifact"], "--browser-artifact");
  }
  if (flags["snapshot-worker"]) options.snapshotWorkerFile = requirePath(flags["snapshot-worker"], "--snapshot-worker");
  if (flags["snapshot-root"]) options.snapshotRoot = requirePath(flags["snapshot-root"], "--snapshot-root");
  if (flags["component-payload"]) {
    options.componentPayloadRoot = requirePath(flags["component-payload"], "--component-payload");
  }
  return options;
}

export function supervisorCliArgs(options: SupervisorCliOptions): string[] {
  const args = ["--home", options.home, "--bin", options.bin];
  if (options.allowRealHome) args.push("--allow-real-home");
  if (options.nodeExe) args.push("--node", options.nodeExe);
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.controlToolRoot) args.push("--control-tool-root", options.controlToolRoot);
  if (options.supervisorAssetRoot) args.push("--supervisor-asset-root", options.supervisorAssetRoot);
  if (options.pluginArtifact) args.push("--plugin-artifact", options.pluginArtifact);
  if (options.viewBridgeArtifact) args.push("--view-bridge-artifact", options.viewBridgeArtifact);
  if (options.llmBridgeArtifact) args.push("--llm-bridge-artifact", options.llmBridgeArtifact);
  if (options.browserArtifact) args.push("--browser-artifact", options.browserArtifact);
  if (options.snapshotWorkerFile) args.push("--snapshot-worker", options.snapshotWorkerFile);
  if (options.snapshotRoot) args.push("--snapshot-root", options.snapshotRoot);
  if (options.componentPayloadRoot) args.push("--component-payload", options.componentPayloadRoot);
  return args;
}

function flagName(token: string): string | undefined {
  const names: Record<string, string> = {
    "--home": "home",
    "--bin": "bin",
    "--cli": "cli",
    "--node": "node",
    "--port": "port",
    "--control-tool-root": "control-tool-root",
    "--supervisor-asset-root": "supervisor-asset-root",
    "--plugin-artifact": "plugin-artifact",
    "--view-bridge-artifact": "view-bridge-artifact",
    "--llm-bridge-artifact": "llm-bridge-artifact",
    "--browser-artifact": "browser-artifact",
    "--snapshot-worker": "snapshot-worker",
    "--snapshot-root": "snapshot-root",
    "--component-payload": "component-payload",
  };
  return names[token];
}

function requirePath(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new WorkbenchPublicError("workbench/invalid-input", `${flag} is required.`);
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) throw new WorkbenchPublicError("workbench/invalid-input", `${flag} must be a filesystem path.`);
  return resolved;
}
