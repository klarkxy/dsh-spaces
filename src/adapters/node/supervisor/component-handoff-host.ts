import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProfileStatus } from "../../../shared/types";
import { sanitizeLogText } from "../diagnostics";
import {
  createComponentHandoffBinding,
  spawnComponentLauncher,
  type ComponentHandoffCommit,
} from "../component-handoff";
import {
  COMPONENT_PAYLOAD_ENTRIES,
  validateComponentPayload,
  type ValidatedComponentPayload,
} from "../component-payload";
import type { HomeControlHandle, HomeController, PidAliveFn } from "../home-controller";
import type { SpaceMessageRouter } from "../message-bus/router";
import type { SupervisorDashboard } from "../dashboard/supervisor";
import { beginLaunchDiagnostics } from "../supervisor-launch";
import {
  WORKBENCH_JOBS_DIR_NAME,
  type WorkbenchJobContext,
  type WorkbenchJobStore,
} from "../workbench-jobs";
import type {
  WorkbenchPackageHandoff,
  WorkbenchPackageHandoffInput,
} from "../workbench-package-upgrade";
import { packLocalArtifacts } from "../../../../packages/plugin/src/host/supervisor-pack.ts";
import { supervisorCliArgs } from "./cli-args";
import { WorkbenchPublicError } from "./errors";
import { pathInsideHome, payloadRel, resolveLauncherEntry } from "./payload";
import type { PendingComponentHandoff, WorkbenchSupervisorOptions } from "./types";

export interface SupervisorComponentHandoffHost {
  home: string;
  controlDir: string;
  nodeExe: string;
  options: WorkbenchSupervisorOptions;
  controller: HomeController;
  messageBus: SpaceMessageRouter;
  spawned: Map<string, { pid: number; startedAt: string }>;
  reasons: () => string[];
  jobs: () => WorkbenchJobStore | undefined;
  handle: () => HomeControlHandle | undefined;
  clearHandle: () => void;
  origin: () => string;
  closeHttp: () => Promise<void>;
  removeEndpointFile: () => void;
  dashboard: () => SupervisorDashboard | null;
  activeJobId: () => string | undefined;
  pendingHandoff: () => PendingComponentHandoff | undefined;
  setPendingHandoff: (value: PendingComponentHandoff | undefined) => void;
  seal: () => void;
  markTransferredOwner: () => void;
  markClosed: () => void;
  markBlocked: () => void;
  selectedPayload: () => ValidatedComponentPayload | undefined;
  ownedSpaceIds: () => string[];
  statusOf: (id: string) => ProfileStatus;
  pidAlive: PidAliveFn;
}

export class SupervisorComponentHandoff {
  constructor(private readonly host: SupervisorComponentHandoffHost) {}

  /**
   * Package-upgrade handoff port. Confirms owned children are stopped, seals
   * further mutations, and records an in-memory pending transfer. Does not wait
   * for this job's tail.
   */
  async handoffWorkbenchPackage(input: WorkbenchPackageHandoffInput, ctx: WorkbenchJobContext): Promise<void> {
    if (this.ownedChildStillRunning()) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Owned processes are still running. The component handoff was not started.",
      );
    }
    const jobId = this.host.activeJobId();
    if (!jobId) {
      throw new WorkbenchPublicError("workbench/unavailable", "Component handoff requires the running upgrade job.");
    }
    const artifacts = await this.artifactsForPayload(input.payload);
    this.host.seal();
    this.host.setPendingHandoff({
      jobId,
      planId: input.planId,
      snapshotId: input.snapshotId,
      payload: input.payload,
      ...artifacts,
    });
    ctx.phase("handoff-pending");
    ctx.message("Handoff preparation is complete. New service startup is unconfirmed.");
    ctx.result({ snapshotId: input.snapshotId });
  }

  toolsRootOutsideHome(): string | undefined {
    const toolsRoot = this.host.options.controlToolRoot;
    if (typeof toolsRoot !== "string" || !toolsRoot.trim()) return undefined;
    const resolved = resolve(toolsRoot.trim());
    if (pathInsideHome(this.host.home, resolved)) return undefined;
    return resolved;
  }

  componentHandoffCallback(): WorkbenchPackageHandoff | undefined {
    if (typeof this.host.options.onNormalExit !== "function" || !this.host.selectedPayload()) return undefined;
    if (!this.toolsRootOutsideHome()) return undefined;
    return (input, ctx) => this.handoffWorkbenchPackage(input, ctx);
  }

  componentHandoffPort(): { toolsRoot: string; handoff: WorkbenchPackageHandoff } | undefined {
    const toolsRoot = this.toolsRootOutsideHome();
    const handoff = this.componentHandoffCallback();
    if (!toolsRoot || !handoff) return undefined;
    return { toolsRoot, handoff };
  }

  jobPersistedSuccess(jobId: string): boolean {
    const jobs = this.host.jobs();
    if (!jobs) return false;
    try {
      if (jobs.job(jobId).status !== "succeeded") return false;
    } catch {
      return false;
    }
    try {
      const raw = readFileSync(join(this.host.controlDir, WORKBENCH_JOBS_DIR_NAME, `${jobId}.json`), "utf8");
      const parsed = JSON.parse(raw) as { status?: string };
      return parsed.status === "succeeded";
    } catch {
      return false;
    }
  }

  private ownedChildStillRunning(): boolean {
    const ids = new Set([...this.host.ownedSpaceIds(), ...this.host.spawned.keys()]);
    for (const id of ids) {
      const spawned = this.host.spawned.get(id);
      if (spawned) {
        const liveness = this.host.pidAlive(spawned.pid, spawned.startedAt);
        if (liveness === "alive" || liveness === "ambiguous") return true;
      }
      const status = this.host.statusOf(id);
      if (status === "running" || status === "starting") return true;
    }
    return false;
  }

  async finalizeComponentHandoff(pending: PendingComponentHandoff): Promise<void> {
    this.host.setPendingHandoff(undefined);
    if (this.ownedChildStillRunning()) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Owned processes are still running. The component handoff was not transferred.",
      );
    }
    const owner = this.host.handle();
    if (!owner) {
      throw new WorkbenchPublicError("workbench/unavailable", "Run rights are not held for the component handoff.");
    }
    const toolsRoot = this.componentHandoffPort()?.toolsRoot ?? this.host.options.controlToolRoot;
    if (!toolsRoot) {
      throw new WorkbenchPublicError("workbench/unavailable", "A tools root outside Home is required for handoff.");
    }
    const targetDiagnosticFile = beginLaunchDiagnostics(this.host.home, resolve(toolsRoot));
    const port = Number(new URL(this.host.origin()).port);
    if (!Number.isInteger(port) || port < 1) {
      throw new WorkbenchPublicError("workbench/invalid-input", "Handoff requires the preserved nonzero management port.");
    }

    await this.host.closeHttp();
    this.host.removeEndpointFile();

    const oldPayload = this.host.selectedPayload();
    if (!oldPayload) {
      throw new WorkbenchPublicError("workbench/unavailable", "The running component group is not validated.");
    }
    const launcherEntry = resolveLauncherEntry(oldPayload);
    const spawnFn = this.host.options.spawnLauncher ?? spawnComponentLauncher;
    let launcher;
    try {
      launcher = spawnFn({
        home: this.host.home,
        launcherEntry,
        execPath: this.host.nodeExe,
        allowRealHome: this.host.options.allowRealHome,
      });
    } catch (error) {
      this.recordHandoffDiagnostic(error);
      throw error;
    }

    this.host.messageBus.close();
    await this.host.dashboard()?.close();
    let token;
    try {
      token = await this.host.controller.transferToLauncher({
        nonce: owner.owner.nonce,
        binding: createComponentHandoffBinding(
          this.host.home,
          owner.owner.nonce,
          pending.payload.digest,
          undefined,
          { allowRealHome: this.host.options.allowRealHome },
        ),
        launcher: { pid: launcher.pid, startedAt: launcher.startedAt },
      });
    } catch (error) {
      try {
        launcher.disconnect();
      } catch {
        /* ignore */
      }
      this.recordHandoffDiagnostic(error);
      throw error;
    }
    this.host.markTransferredOwner();

    const newEntry = payloadRel(pending.payload.packageRoot, COMPONENT_PAYLOAD_ENTRIES.supervisor);
    const newWorker = payloadRel(pending.payload.packageRoot, COMPONENT_PAYLOAD_ENTRIES["installation-worker"]);
    const argv = supervisorCliArgs({
      home: this.host.home,
      bin: this.host.options.bin,
      nodeExe: this.host.nodeExe,
      port,
      allowRealHome: this.host.options.allowRealHome,
      controlToolRoot: resolve(toolsRoot),
      snapshotRoot: this.host.options.snapshotRoot,
      pluginArtifact: pending.pluginArtifact,
      viewBridgeArtifact: pending.viewBridgeArtifact,
      browserArtifact: pending.browserArtifact,
      llmBridgeArtifact: pending.llmBridgeArtifact,
      snapshotWorkerFile: newWorker,
      componentPayloadRoot: pending.payload.payloadRootLib,
      acceptHandoff: true,
    });
    const commit: ComponentHandoffCommit = {
      token,
      home: this.host.home,
      toolsRoot: resolve(toolsRoot),
      artifactDigest: pending.payload.digest,
      oldPid: process.pid,
      oldStartedAt: owner.owner.startedAt,
      cleanStopConfirmed: true,
      runtime: {
        execPath: this.host.nodeExe,
        entry: newEntry,
        argv,
        cwd: dirname(newEntry),
        env: { ...process.env, DSH_SPACES_SUPERVISOR_DIAGNOSTICS: targetDiagnosticFile },
      },
      ...(this.host.options.allowRealHome ? { allowRealHome: true } : {}),
    };
    try {
      await launcher.sendCommit(commit);
    } catch (error) {
      this.recordHandoffDiagnostic(error);
      throw error;
    }
    launcher.disconnect();
    this.host.markClosed();
    this.host.clearHandle();
    if (this.host.options.onNormalExit) await this.host.options.onNormalExit();
  }

  private async artifactsForPayload(
    payload: ValidatedComponentPayload,
  ): Promise<{ pluginArtifact: string; viewBridgeArtifact: string; browserArtifact?: string; llmBridgeArtifact?: string }> {
    const live = validateComponentPayload(payload.payloadRootLib);
    const toolsRoot = this.host.options.controlToolRoot;
    if (typeof toolsRoot !== "string" || !toolsRoot.trim() || pathInsideHome(this.host.home, resolve(toolsRoot))) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        "Selected component artifacts require a tools root outside Home.",
      );
    }
    const packed = await packLocalArtifacts({
      pluginPackageRoot: live.packageRoot,
      viewBridgeRoot: join(live.payloadRootLib, "view-bridge"),
      browserRoot: join(live.payloadRootLib, "browser"),
      llmBridgeRoot: join(live.payloadRootLib, "llm-bridge"),
      artifactDir: join(resolve(toolsRoot), "artifacts"),
      home: this.host.home,
      execPath: this.host.nodeExe,
    });
    if ("reasons" in packed) {
      throw new WorkbenchPublicError(
        "workbench/unavailable",
        packed.reasons[0] ?? "Selected component artifacts could not be packed.",
      );
    }
    if (!packed.pluginArtifact || !packed.viewBridgeArtifact || !packed.browserArtifact) {
      throw new WorkbenchPublicError("workbench/unavailable", "Selected component artifacts could not be packed.");
    }
    return {
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: packed.viewBridgeArtifact,
      browserArtifact: packed.browserArtifact,
      ...(packed.llmBridgeArtifact ? { llmBridgeArtifact: packed.llmBridgeArtifact } : {}),
    };
  }

  recordHandoffDiagnostic(error: unknown): void {
    const message = sanitizeLogText(
      error instanceof Error ? error.message : typeof error === "string" ? error : "Component handoff failed.",
    ).slice(0, 400);
    if (!this.host.reasons().includes(message)) this.host.reasons().push(message);
    this.host.markBlocked();
  }
}
