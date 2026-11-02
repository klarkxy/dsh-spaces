import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { samePath } from "../home/home-guard";
import { bindDshCli, isCompatibleDshCliVersion } from "../products/spaces-service";
import {
  COMPONENT_PAYLOAD_ENTRIES,
  ComponentPayloadError,
  validateComponentPayload,
  validateComponentPayloadArtifacts,
  type ValidatedComponentPayload,
} from "../payload/component-payload";
import { detectDevCheckout } from "../payload/dev-checkout";
import { WorkbenchPublicError } from "./errors";
import type { BoundCli, WorkbenchSupervisorOptions } from "./types";

/**
 * Fail-closed v2 payload validation with the binding error shape. Launch code
 * calls this once per start and threads the result through bind, preflight,
 * and runtime construction, so the manifest and every declared file are read
 * and hashed a single time; all non-hash checks still run on each call.
 */
export function validateSupervisorComponentPayload(payloadRootLib: string): ValidatedComponentPayload {
  try {
    return validateComponentPayload(payloadRootLib);
  } catch (error) {
    const detail = error instanceof ComponentPayloadError || error instanceof Error
      ? error.message
      : "Component payload is invalid.";
    throw new WorkbenchPublicError("workbench/invalid-input", detail);
  }
}

/**
 * Cold-start binding for `--component-payload`. Library callers that omit the
 * root stay unchanged. A present root is v2-validated and fail-closed: worker
 * and supervisor assets come from that group, and packed view/llm artifacts
 * must be real files already supplied by bootstrap.
 */
export function bindSupervisorComponentPayload(
  options: WorkbenchSupervisorOptions,
  validated?: ValidatedComponentPayload,
): WorkbenchSupervisorOptions {
  const root = options.componentPayloadRoot;
  if (options.devCheckoutRoot !== undefined) {
    const checkout = typeof root === "string" ? detectDevCheckout(root) : undefined;
    if (root === undefined || checkout === undefined || !samePath(checkout, options.devCheckoutRoot)) {
      throw new WorkbenchPublicError(
        "workbench/invalid-input",
        "--dev-checkout must name the source checkout the --component-payload lib belongs to.",
      );
    }
    if (
      options.pluginArtifact !== undefined ||
      options.viewBridgeArtifact !== undefined ||
      options.llmBridgeArtifact !== undefined ||
      options.browserArtifact !== undefined
    ) {
      throw new WorkbenchPublicError(
        "workbench/invalid-input",
        "--dev-checkout does not accept component artifacts; components link from the checkout.",
      );
    }
  }
  if (root === undefined) return options;
  if (typeof root !== "string" || !root.trim()) {
    throw new WorkbenchPublicError("workbench/invalid-input", "--component-payload must be a filesystem path.");
  }
  // `validated` must be the validation of this same payload root; every check
  // below still runs, only the manifest read and file hashing are reused.
  const selected = validated ?? validateSupervisorComponentPayload(root);
  options.componentPayloadRoot = selected.payloadRootLib;
  const worker = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES["installation-worker"]);
  const supervisorDir = payloadRel(selected.packageRoot, "lib/supervisor");
  const viewEntry = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES["view-bridge"]);
  const llmEntry = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES["llm-bridge"]);
  const browserEntry = payloadRel(selected.packageRoot, COMPONENT_PAYLOAD_ENTRIES.browser);
  assertRealFile(worker, "Selected snapshot worker");
  assertRealDirectory(supervisorDir, "Selected supervisor assets");
  assertRealFile(viewEntry, "Selected view-bridge");
  assertRealFile(llmEntry, "Selected llm-bridge");
  assertRealFile(browserEntry, "Selected browser");

  if (options.snapshotWorkerFile !== undefined && !sameRealPath(options.snapshotWorkerFile, worker)) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "snapshot-worker is not from the selected component group.",
    );
  }
  options.snapshotWorkerFile = worker;

  if (options.supervisorAssetRoot !== undefined && !sameRealPath(options.supervisorAssetRoot, supervisorDir)) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "supervisor-asset-root is not from the selected component group.",
    );
  }
  options.supervisorAssetRoot = supervisorDir;

  if (options.viewBridgeArtifact !== undefined) {
    assertRealFile(options.viewBridgeArtifact, "view-bridge-artifact");
  }
  if (options.llmBridgeArtifact !== undefined) {
    assertRealFile(options.llmBridgeArtifact, "llm-bridge-artifact");
  }
  if (options.browserArtifact !== undefined) {
    assertRealFile(options.browserArtifact, "browser-artifact");
  }
  if (options.pluginArtifact !== undefined) {
    assertRealFile(options.pluginArtifact, "plugin-artifact");
  }
  return options;
}

/**
 * Async group preflight: bind the v2 payload, require the plugin/view/llm
 * artifact tuple, and validate tar bytes against the selected manifest.
 * Call before runtime construction, HTTP, or Home writers. When `validated`
 * is the launch validation of the same payload root, its manifest/digest
 * conclusion is reused instead of re-reading and re-hashing the group.
 */
export async function preflightSupervisorComponentPayload(
  options: WorkbenchSupervisorOptions,
  validated?: ValidatedComponentPayload,
): Promise<WorkbenchSupervisorOptions> {
  const resolved: WorkbenchSupervisorOptions = { ...options };
  bindSupervisorComponentPayload(resolved, validated);
  if (resolved.componentPayloadRoot === undefined) return resolved;
  // A linked checkout has no artifact tuple; bind already proved the root.
  if (resolved.devCheckoutRoot !== undefined) return resolved;
  const pluginArtifact = resolved.pluginArtifact;
  const viewBridgeArtifact = resolved.viewBridgeArtifact;
  const llmBridgeArtifact = resolved.llmBridgeArtifact;
  const browserArtifact = resolved.browserArtifact;
  if (!pluginArtifact || !viewBridgeArtifact || !browserArtifact || !llmBridgeArtifact) {
    throw new WorkbenchPublicError(
      "workbench/invalid-input",
      "A component payload requires plugin, view-bridge, browser, and llm-bridge artifacts from the same group.",
    );
  }
  const payload = validated && validated.payloadRootLib === resolved.componentPayloadRoot
    ? validated
    : validateComponentPayload(resolved.componentPayloadRoot);
  try {
    await validateComponentPayloadArtifacts(payload, {
      pluginArtifact,
      viewBridgeArtifact,
      browserArtifact,
      llmBridgeArtifact,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Component payload artifacts are invalid.";
    throw new WorkbenchPublicError("workbench/invalid-input", detail);
  }
  return resolved;
}

export function payloadRel(packageRoot: string, rel: string): string {
  return join(packageRoot, ...rel.split("/").filter(Boolean));
}

export function assertRealFile(path: string, label: string): string {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is missing.`);
  }
  if (st.isSymbolicLink()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is a symlink or junction.`);
  }
  if (!st.isFile()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is not a regular file.`);
  }
  return abs;
}

export function assertRealDirectory(path: string, label: string): string {
  const abs = resolve(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is missing.`);
  }
  if (st.isSymbolicLink()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is a symlink or junction.`);
  }
  if (!st.isDirectory()) {
    throw new WorkbenchPublicError("workbench/invalid-input", `${label} is not a directory.`);
  }
  return abs;
}

export function sameRealPath(left: string, right: string): boolean {
  try {
    return samePath(realpathSync(resolve(left)), realpathSync(resolve(right)));
  } catch {
    return false;
  }
}

export function pathInsideHome(home: string, path: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function bindSelectedCli(bin: string): BoundCli {
  const bound = bindDshCli(resolve(bin));
  if (!bound) {
    throw new WorkbenchPublicError("workbench/incompatible", "The selected DSH CLI could not be bound from disk.");
  }
  if (!isCompatibleDshCliVersion(bound.version)) {
    throw new WorkbenchPublicError("workbench/incompatible");
  }
  return bound;
}

export function defaultSnapshotWorkerFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../../packages/supervisor/lib/snapshot-worker.mjs"),
    join(here, "../../../lib/snapshot-worker.mjs"),
  ];
  if (typeof process.argv[1] === "string") {
    candidates.push(join(dirname(process.argv[1]), "snapshot-worker.mjs"));
    candidates.push(join(dirname(process.argv[1]), "../lib/snapshot-worker.mjs"));
  }
  const found = candidates.map((path) => resolve(path)).find((path) => existsSync(path));
  return found ?? resolve(candidates[0]);
}
