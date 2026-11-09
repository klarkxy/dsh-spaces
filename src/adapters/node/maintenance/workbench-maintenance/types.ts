import type { PackageSource } from "../../../../shared/types";
import type { WorkbenchPlan } from "../../../../shared/workbench";
import type { ExactPluginSource } from "../../../../shared/plugin-source";
import type { setSpacePlugin as defaultSetSpacePlugin } from "../../products/plugin-ops";

export type MaintenanceFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

export type PluginMutator = (home: string, profile: string, spec: string) => Promise<void>;

export interface WorkbenchMaintenanceOptions {
  now?: () => Date;
  fetch?: MaintenanceFetcher;
  pluginAdd?: PluginMutator;
  pluginRemove?: PluginMutator;
  setSpacePlugin?: typeof defaultSetSpacePlugin;
  packageSource?: PackageSource | (() => PackageSource);
  log?: (message: string, error?: unknown) => void;
}

export type ResolvedCommand =
  | {
      kind: "plugin.install";
      spaceIds: string[];
      catalogId: string;
      packageName: string;
      version: string;
    }
  | { kind: "plugin.install.spec"; spaceId: string; plugin: ExactPluginSource }
  | { kind: "plugin.remove"; spaceId: string; packageName: string }
  | { kind: "plugin.toggle"; spaceId: string; pluginId: string; packageName: string; enabled: boolean }
  | { kind: "plugin.cleanup-manager"; spaceId: string; packageName: string }
  | { kind: "snapshot.create" }
  | { kind: "snapshot.delete"; snapshotId: string }
  | { kind: "space.runtime.set"; spaceId: string; version: string }
  | { kind: "runtime.remove"; version: string };

export type PlanStatus = "previewed" | "running" | "succeeded" | "failed" | "cancelled";

export interface StoredPlan {
  schemaVersion: 1;
  id: string;
  public: WorkbenchPlan;
  command: ResolvedCommand;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  status: PlanStatus;
  startedAt?: string;
  finishedAt?: string;
}

export interface PluginMutationExpected {
  spaceId: string;
  action: "install" | "remove";
  packageName: string;
  version?: string;
  /** Exact-source installs are verified against the frozen source (pin provenance). */
  plugin?: ExactPluginSource;
}

export interface PluginMutationJournal {
  schemaVersion: 1;
  phase: "prepared" | "mutating" | "failed";
  planId?: string;
  spaceIds: string[];
  expected: PluginMutationExpected[];
  startedAt: string;
}

export interface Packument {
  name?: unknown;
  description?: unknown;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: string }; description?: unknown }>;
}
