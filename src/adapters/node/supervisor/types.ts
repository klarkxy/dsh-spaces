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
import type { PidAliveFn } from "../home-controller";
import type { ProcessRuntime } from "../process-manager";
import type { PatchWriter } from "../patch-writer";
import type { BoundCliRunner } from "../spaces-control";
import type { WorkbenchJobContext, WorkbenchJobsInject } from "../workbench-jobs";
import type { WorkbenchMaintenancePorts } from "../workbench-maintenance-ports";
import type { WorkbenchSupervisorRuntime } from "../workbench-supervisor";

export interface WorkbenchMaintenance {
  preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan>;
  execute(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void>;
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
  llmBridgeArtifact?: string;
  snapshotWorkerFile?: string;
  snapshotRoot?: string;
  /** Selected v2 payload `lib` root (`--component-payload`). Absent keeps library callers compatible. */
  componentPayloadRoot?: string;
  /** CLI-only: process may exit after a durable shutdown. */
  onNormalExit?: () => void | Promise<void>;
  /** Test seam forwarded to WorkbenchJobStore. */
  jobsInject?: WorkbenchJobsInject;
  runtimeRoot?: string;
  allowRealHome?: boolean;
  portStart?: number;
  portEnd?: number;
  now?: () => Date;
  fetch?: typeof fetch;
  pidAlive?: PidAliveFn;
  processRuntime?: Partial<ProcessRuntime>;
  createMaintenance?: (ports: WorkbenchMaintenancePorts) => WorkbenchMaintenance;
  runCli?: BoundCliRunner;
  pluginAdd?: (home: string, profile: string, spec: string, options?: { force?: boolean }) => Promise<void>;
  dumpConfig?: (profile: string) => Promise<string>;
  patchWriter?: PatchWriter;
}

export interface SupervisorCliOptions extends WorkbenchSupervisorOptions {
  home: string;
  bin: string;
}

export interface WorkbenchSupervisorHandle {
  server: Server;
  runtime: WorkbenchSupervisorRuntime;
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
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
}

export interface BoundCli {
  bin: string;
  version: string;
}
