/**
 * Facade for the workbench maintenance service.
 *
 * The implementation lives in focused parts under `./workbench-maintenance/`:
 * shared state and helpers (`core`), plugin batch operations
 * (`plugin-batch`), snapshot flows (`snapshots`), runtime and toolchain
 * switching (`runtime`), preview and plan construction (`plans`), guarded
 * execution phases (`execution`), and the public service (`service`).
 */
export {
  FULL_SPACES_PACKAGE,
  UPGRADE_JOURNAL_FILE,
  UPGRADE_STAGE_DIR,
  WORKBENCH_MAINTENANCE_ERROR,
  WORKBENCH_PLANS_DIR_NAME,
  WORKBENCH_PLUGIN_MUTATION_FILE,
  WORKBENCH_PLUGIN_MUTATION_FILES_DIR,
  WORKBENCH_PLUGIN_REGISTRY_FILE,
  WORKBENCH_PLAN_TTL_MS,
} from "./workbench-maintenance/constants";
export type { WorkbenchMaintenanceErrorCode } from "./workbench-maintenance/constants";
export { WorkbenchMaintenanceError } from "./workbench-maintenance/errors";
export type {
  MaintenanceFetcher,
  PluginMutator,
  WorkbenchMaintenanceOptions,
} from "./workbench-maintenance/types";
export { WorkbenchMaintenance } from "./workbench-maintenance/service";
export type { WorkbenchJob } from "../../../shared/workbench";
export type { WorkbenchJobContext, WorkbenchJobResult } from "./workbench-jobs";
