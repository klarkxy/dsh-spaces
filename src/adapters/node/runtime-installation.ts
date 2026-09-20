import { observeMaintenanceChild, withChildObservation } from "../../main/owned-process-record";
import { assertNotRealHome } from "../../main/home-guard";
import { RuntimeStore, type RunProcessFn } from "../../main/runtime-store";
import { ProcessTerminationError } from "../../main/terminate-process";
import { setToolchainRoot } from "../../main/toolchain";
import type { InstalledRuntime, RuntimeRef } from "../../shared/runtime";
import type { PackageSource } from "../../shared/types";

export interface RuntimeInstallationInput {
  home: string;
  runtimeRoot: string;
  version: string;
  packageSource: PackageSource;
  snapshotRoot?: string;
  legacy?: RuntimeRef;
  toolchainRoot?: string;
  /** Tests inject npm/CLI IO. Production worker omits this and uses the toolchain. */
  run?: RunProcessFn;
}

/** RuntimeStore install + toolchain, with owned maintenance-child observation. */
export async function runRuntimeInstallation(input: RuntimeInstallationInput): Promise<InstalledRuntime> {
  assertNotRealHome(input.home);
  assertNotRealHome(input.runtimeRoot);
  if (input.toolchainRoot) setToolchainRoot(input.toolchainRoot);
  const runtimes = new RuntimeStore({
    root: input.runtimeRoot,
    snapshotRoot: input.snapshotRoot,
    source: () => input.packageSource,
    legacy: () => input.legacy,
    run: input.run,
  });
  let journalFailed = false;
  return withChildObservation(
    () => observeMaintenanceChild(input.home, () => { journalFailed = true; }),
    async () => {
      const installed = await runtimes.install(input.version);
      if (journalFailed) throw new ProcessTerminationError("Maintenance child journal needs recovery.");
      return installed;
    },
  );
}
