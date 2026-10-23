import { PROTECTED_PLUGIN_PACKAGES } from "../../../../shared/types";
import type { WorkbenchPlanRequest } from "../../../../shared/workbench";

export const WORKBENCH_PLANS_DIR_NAME = "plans";
export const WORKBENCH_PLUGIN_REGISTRY_FILE = "plugin-registry.json";
export const WORKBENCH_PLUGIN_MUTATION_FILE = "plugin-mutation.json";
export const WORKBENCH_PLUGIN_MUTATION_FILES_DIR = "plugin-mutation-files";
export const WORKBENCH_PLAN_TTL_MS = 5 * 60 * 1000;
export const FULL_SPACES_PACKAGE = "@dsh-spaces/plugin";
export const UPGRADE_STAGE_DIR = ".dsh-spaces-upgrade";
export const UPGRADE_JOURNAL_FILE = "journal.json";

export const WORKBENCH_MAINTENANCE_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench maintenance plan.",
  "workbench/not-found": "That maintenance target was not found.",
  "workbench/expired": "This plan has expired. Preview the action again.",
  "workbench/stale": "The target changed after preview. Preview the action again.",
  "workbench/conflict": "This plan was already executed.",
  "workbench/forbidden": "This maintenance action is not allowed for the selected target.",
  "workbench/runtime-handoff": "This action is handled by the supervisor runtime, not maintenance.",
  "workbench/unsupported": "That runtime version cannot be used for this action.",
  "workbench/cancelled": "The maintenance job was cancelled.",
  "workbench/failed": "The maintenance operation failed.",
} as const;

export type WorkbenchMaintenanceErrorCode = keyof typeof WORKBENCH_MAINTENANCE_ERROR;

export const DOWNLOAD_TIMEOUT_MS = 20_000;
export const PROTECTED_PACKAGES = new Set<string>([...PROTECTED_PLUGIN_PACKAGES, FULL_SPACES_PACKAGE]);
export const HANDOFF_KINDS = new Set<WorkbenchPlanRequest["kind"]>([
  "space.stop",
  "space.restart",
  "space.delete",
  "service.shutdown",
]);
export const PLAN_SCHEMA = 1;
export const PLAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const REMOVED_DISK_COMMANDS = new Set([
  "snapshot.restore",
  "config.restore",
  "runtime.install",
  "runtime.upgrade",
  "workbench.upgrade",
  "controller.release",
  "controller.shutdown",
]);
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
export const CATALOG_ID_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$|^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export const PROFILE_FILE_NAMES = ["package.json", "pnpm-lock.yaml", "pnpm-lock.yml", "cordis.patch.yml"] as const;
