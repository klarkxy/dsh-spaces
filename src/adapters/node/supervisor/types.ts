import type { Server } from "node:http";
import type {
  WorkbenchBackup,
  WorkbenchJob,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime as WorkbenchRuntimeDto,
  WorkbenchSnapshot,
} from "../../../shared/workbench";
import type { ResumeSpacesMode } from "../../../shared/types";
import type { PidAliveFn } from "../home/home-lease";
import type { ProcessRuntime } from "../runtime/process-manager";
import type { PatchWriter } from "../profile/patch-writer";
import type { BoundCliRunner } from "../products/spaces-service";
import type { WorkbenchJobContext, WorkbenchJobsInject } from "../maintenance/workbench-jobs";
import type { WorkbenchMaintenancePorts } from "../maintenance/workbench-maintenance-ports";
import type { WorkbenchSupervisorRuntime } from "../workbench-supervisor";
import type { DiagnosticLogger } from "../diagnostics/rotating-log";

export interface WorkbenchMaintenance {
  preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan>;
  execute(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void>;
  admitPlan?(planId: string): { scope: WorkbenchPlan["scope"]; affectedSpaceIds: string[] };
  plugins(query: string): Promise<WorkbenchPlugin[]>;
  snapshots(): Promise<WorkbenchSnapshot[]>;
  snapshot(id: string): Promise<WorkbenchSnapshot>;
  runtimes(): Promise<WorkbenchRuntimeDto[]>;
  backups(spaceId: string): Promise<WorkbenchBackup[]>;
}

export interface WorkbenchSupervisorOptions {
  home: string;
  bin: string;
  nodeExe?: string;
  port?: number;
  controlToolRoot?: string;
  supervisorAssetRoot?: string;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  browserArtifact?: string;
  snapshotWorkerFile?: string;
  snapshotRoot?: string;
  /** Selected v2 payload `lib` root (`--component-payload`). */
  componentPayloadRoot?: string;
  /** Source checkout root (`--dev-checkout`): components link in place instead of installing tarballs. */
  devCheckoutRoot?: string;
  /** CLI-only: process may exit after a durable shutdown. */
  onNormalExit?: () => void | Promise<void>;
  /** Test seam forwarded to WorkbenchJobStore. */
  jobsInject?: WorkbenchJobsInject;
  runtimeRoot?: string;
  allowRealHome?: boolean;
  /** Desktop-origin launch: saved per-space startup preferences apply. */
  startDesktopSpaces?: boolean;
  /** Explicit one-shot resume selection; absent means the Home setting decides ledger use. */
  resumeMode?: ResumeSpacesMode;
  portStart?: number;
  portEnd?: number;
  now?: () => Date;
  diagnosticLog?: DiagnosticLogger;
  fetch?: typeof fetch;
  pidAlive?: PidAliveFn;
  processRuntime?: Partial<ProcessRuntime>;
  createMaintenance?: (ports: WorkbenchMaintenancePorts) => WorkbenchMaintenance;
  runCli?: BoundCliRunner;
  pluginAdd?: (home: string, profile: string, spec: string, options?: { force?: boolean }) => Promise<void>;
  pluginLink?: (home: string, profile: string, dir: string, expectedName: string) => Promise<void>;
  /** Official plugin remove; used once per older space to drop the retired LLM bridge. */
  pluginRemove?: (home: string, profile: string, packageName: string) => Promise<void>;
  dumpConfig?: (profile: string) => Promise<string>;
  patchWriter?: PatchWriter;
}

export interface SupervisorCliOptions extends WorkbenchSupervisorOptions {
  home: string;
  bin: string;
  exitWithHost?: boolean;
}

export interface WorkbenchSupervisorHandle {
  server: Server;
  runtime: WorkbenchSupervisorRuntime;
  origin: string;
  bootstrapUrl: string;
  close(reason?: "host-exit" | "signal"): Promise<void>;
}

export interface ChildView {
  spaceId: string;
  generation: number;
  origin: string;
  channel: string;
  serviceEpoch: string;
  issued: boolean;
}

export interface StoredPlan {
  plan: WorkbenchPlan;
  request: WorkbenchPlanRequest;
  fingerprint: string;
  consumed?: boolean;
  admitted?: boolean;
}

export interface BoundCli {
  bin: string;
  version: string;
}
